/**
 * Anthropic's web search server tool (`web_search_YYYYMMDD`, used by Claude Code's WebSearch)
 * for targets that cannot run it: Kiro and OpenAI chat-completions providers get it as a plain
 * function and answer with a `tool_use` nobody runs, so Claude Code saw "no usable results".
 *
 * TRouteAI runs it itself, the way the real API does: the model gets a `web_search` function;
 * when it calls it, TRouteAI searches (a configured search provider, else free DuckDuckGo),
 * reads the top pages, gives the model the results and asks again, until it answers. The client
 * gets the Messages API's own blocks: `server_tool_use`, `web_search_tool_result` (title, URL,
 * `encrypted_content`) and the model's text, streaming or not, with
 * `usage.server_tool_use.web_search_requests`. The web fetch server tool (`web_fetch_YYYYMMDD`)
 * runs the same way: TRouteAI opens the URL (public addresses only; like the real tool, only
 * URLs that appeared earlier in the conversation) and answers with `web_fetch_tool_result`.
 *
 * When no search works at all, the request goes to a model with native web search instead
 * (`TROUTEAI_WEB_SEARCH_FALLBACK_MODEL`, else the best Sonnet of an active Claude account);
 * without one the model answers from what it knows and the client gets the search error block.
 */
import { randomBytes } from "node:crypto";

import { getComboModelString, isComboStepDisabled } from "@/lib/combos/steps";
import { getCustomModels, getModelIsHidden } from "@/lib/db/models";
import { getProviderConnections } from "@/lib/db/providers";
import { executeWebSearch } from "@/lib/search/executeWebSearch";
import { safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { isPrivateHost } from "@/shared/network/outboundUrlGuard";
import { getModelsByProviderId } from "@trouteai/open-sse/config/providerModels.ts";
import { freeWebSearch } from "@trouteai/open-sse/services/freeWebSearch.ts";
import { getTargetFormat } from "@trouteai/open-sse/services/provider.ts";
import {
  encodeWebSearchContent,
  formatWebSearchResultsForModel,
  type WebSearchResultItem,
} from "@trouteai/open-sse/services/webSearchResultText.ts";
import { getComboForModel, getModelInfo } from "../services/model";

type JsonRecord = Record<string, unknown>;
type Log = {
  info?: (tag: string, msg: string) => void;
  warn?: (tag: string, msg: string) => void;
  debug?: (tag: string, msg: string) => void;
};

/** Target formats that cannot run Anthropic's server tools (they get TRouteAI's run of it). */
const EMULATED_TARGET_FORMATS = new Set(["kiro", "openai"]);
const DEFAULT_MAX_USES = 5;
const MAX_USES_CAP = 10;
const RESULTS_PER_SEARCH = 5;
const PAGES_READ_PER_SEARCH = 3;
const PAGE_TEXT_CHARS = 3000;
const PAGE_FETCH_TIMEOUT_MS = 6000;
const PAGE_MAX_BYTES = 768 * 1024;
const PING_INTERVAL_MS = 10_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36";

function isServerWebSearchTool(tool: unknown): tool is JsonRecord {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  const t = tool as JsonRecord;
  return typeof t.type === "string" && /^web_search_\d{8}$/.test(t.type) && !t.function;
}

function isServerWebFetchTool(tool: unknown): tool is JsonRecord {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  const t = tool as JsonRecord;
  return typeof t.type === "string" && /^web_fetch_\d{8}$/.test(t.type) && !t.function;
}

/** True when a Claude-format request carries Anthropic's web search server tool. */
export function hasClaudeServerWebSearchTool(body: unknown): boolean {
  const tools = (body as JsonRecord | null)?.tools;
  return Array.isArray(tools) && tools.some(isServerWebSearchTool);
}

/** True when a Claude-format request carries Anthropic's web search or web fetch server tool. */
export function hasClaudeServerWebTool(body: unknown): boolean {
  const tools = (body as JsonRecord | null)?.tools;
  return (
    Array.isArray(tools) && tools.some((t) => isServerWebSearchTool(t) || isServerWebFetchTool(t))
  );
}

async function modelNeedsEmulation(modelStr: string): Promise<boolean> {
  const info = await getModelInfo(modelStr).catch(() => null);
  const provider = info?.provider;
  if (!provider) return false;
  try {
    return EMULATED_TARGET_FORMATS.has(String(getTargetFormat(provider)));
  } catch {
    return false;
  }
}

/**
 * Whether the request's target cannot run the server tool. For a combo: when any switched-on
 * step cannot (a later step may answer it after the first one fails).
 */
export async function webSearchNeedsEmulation(modelStr: string, depth = 0): Promise<boolean> {
  if (!modelStr || depth > 3) return false;
  const combo = (await getComboForModel(modelStr).catch(() => null)) as JsonRecord | null;
  const steps = Array.isArray(combo?.models) ? (combo.models as unknown[]) : null;
  if (!steps) return modelNeedsEmulation(modelStr);
  for (const step of steps) {
    if (isComboStepDisabled(step)) continue;
    const rec = step as JsonRecord | null;
    if (rec && typeof rec === "object" && rec.kind === "combo-ref") {
      if (await webSearchNeedsEmulation(String(rec.comboName || ""), depth + 1)) return true;
      continue;
    }
    const model = getComboModelString(step);
    if (model && (await modelNeedsEmulation(model))) return true;
  }
  return false;
}

// ── Search ───────────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(host: string, domain: string): boolean {
  const d = domain
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^www\./, "");
  const h = host.replace(/^www\./, "");
  return h === d || h.endsWith(`.${d}`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim())
    : [];
}

export type SearchOptions = { allowed: string[]; blocked: string[]; apiKeyId?: string | null };

async function runSearch(
  query: string,
  opts: SearchOptions,
  log?: Log
): Promise<{ items: WebSearchResultItem[]; provider: string }> {
  const keep = (url: string) => {
    const host = hostOf(url);
    if (!host) return false;
    if (opts.blocked.some((d) => domainMatches(host, d))) return false;
    if (opts.allowed.length && !opts.allowed.some((d) => domainMatches(host, d))) return false;
    return true;
  };
  let lastError = "";
  try {
    const { data } = await executeWebSearch({
      query,
      max_results: RESULTS_PER_SEARCH,
      filters: {
        ...(opts.allowed.length ? { include_domains: opts.allowed } : {}),
        ...(opts.blocked.length ? { exclude_domains: opts.blocked } : {}),
      },
      apiKeyId: opts.apiKeyId ?? null,
    });
    const items = (data.results || [])
      .filter((r) => r?.url && keep(r.url))
      .map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: r.snippet || "",
        pageAge: r.published_at ? String(r.published_at) : null,
        // A search provider that returns page text saves the page fetch.
        ...(r.content?.text ? { pageText: String(r.content.text).slice(0, PAGE_TEXT_CHARS) } : {}),
      }));
    if (items.length) return { items, provider: data.provider };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  // Free DuckDuckGo search: no account needed. Domain rules become site: operators.
  const operators = [
    ...(opts.allowed.length === 1 ? [`site:${opts.allowed[0]}`] : []),
    ...opts.blocked.map((d) => `-site:${d}`),
  ];
  const q = [query, ...operators].join(" ").slice(0, 400);
  try {
    const free = await freeWebSearch(q, RESULTS_PER_SEARCH + 3, 10_000);
    const items = free
      .filter((r) => keep(r.url))
      .slice(0, RESULTS_PER_SEARCH)
      .map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: r.snippet || "",
        pageAge: null,
      }));
    return { items, provider: "duckduckgo-free" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.warn?.(
      "WEBSEARCH",
      `search failed (${lastError ? `${lastError.slice(0, 120)}; ` : ""}free search: ${message.slice(0, 120)})`
    );
    throw new Error("web search unavailable");
  }
}

/** Cut `<tag ...> ... </tag>` (and `<!-- -->`) spans out of the page in one pass. */
function removeSpans(html: string, tags: string[]): string {
  const lower = html.toLowerCase();
  const openers = [
    ...tags.map((t) => ({ open: `<${t}`, close: `</${t}`, end: ">" })),
    { open: "<!--", close: "-->", end: "" },
  ];
  const nextAt = openers.map(() => -2);
  let out = "";
  let i = 0;
  while (i < html.length) {
    let best = -1;
    let which = -1;
    for (let k = 0; k < openers.length; k++) {
      if (nextAt[k] !== -1 && nextAt[k] < i) nextAt[k] = lower.indexOf(openers[k].open, i);
      if (nextAt[k] !== -1 && (best === -1 || nextAt[k] < best)) {
        best = nextAt[k];
        which = k;
      }
    }
    if (best === -1) {
      out += html.slice(i);
      break;
    }
    const o = openers[which];
    const boundary = lower.charAt(best + o.open.length);
    if (o.end && /[a-z0-9-]/.test(boundary)) {
      // `<scripts>` or `<navbar>`: not the tag, keep it.
      out += html.slice(i, best + 1);
      i = best + 1;
      continue;
    }
    out += `${html.slice(i, best)} `;
    const close = lower.indexOf(o.close, best + o.open.length);
    if (close === -1) break;
    if (!o.end) {
      i = close + o.close.length;
    } else {
      const end = lower.indexOf(">", close);
      i = end === -1 ? html.length : end + 1;
    }
  }
  return out;
}

function htmlToText(html: string): string {
  let s = html.slice(0, PAGE_MAX_BYTES);
  const lower = s.toLowerCase();
  const bodyStart = lower.indexOf("<body");
  if (bodyStart !== -1) {
    const open = lower.indexOf(">", bodyStart);
    const close = lower.lastIndexOf("</body");
    s = s.slice(open === -1 ? bodyStart : open + 1, close > bodyStart ? close : undefined);
  }
  s = removeSpans(s, [
    "script",
    "style",
    "noscript",
    "svg",
    "template",
    "iframe",
    "nav",
    "footer",
    "header",
    "aside",
    "form",
    "head",
  ]);
  s = s.replace(
    /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|pre|blockquote)\b[^>]{0,500}>/gi,
    "\n"
  );
  s = s.replace(/<[^>]{0,2000}>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    })
    .replace(/&amp;/gi, "&");
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((line) => line.length > 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

type Fetched = { status: number; contentType: string; bytes: Buffer; url: string };

/** GET a public URL (redirects followed by hand, each hop checked as public); null on failure. */
async function fetchUrl(
  url: string,
  signal: AbortSignal | null | undefined,
  maxBytes: number,
  accept: string
): Promise<Fetched | null> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (signal?.aborted) return null;
    let res: Response;
    try {
      res = await safeOutboundFetch(current, {
        method: "GET",
        guard: "public-only",
        allowRedirect: false,
        timeoutMs: PAGE_FETCH_TIMEOUT_MS,
        retry: false,
        headers: { "User-Agent": BROWSER_UA, Accept: accept },
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) return null;
      try {
        current = new URL(location, current).href;
      } catch {
        return null;
      }
      continue;
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, contentType, bytes: Buffer.alloc(0), url: current };
    }
    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, contentType, bytes: Buffer.alloc(0), url: current };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    return {
      status: res.status,
      contentType,
      bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      url: current,
    };
  }
  return null;
}

/** Readable text of a public page, for search results. */
async function fetchPageText(url: string, signal?: AbortSignal | null): Promise<string> {
  const got = await fetchUrl(url, signal, PAGE_MAX_BYTES, "text/html,text/plain;q=0.9,*/*;q=0.5");
  if (!got || got.status !== 200) return "";
  if (!/text\/html|text\/plain|application\/xhtml/.test(got.contentType)) return "";
  const raw = got.bytes.subarray(0, PAGE_MAX_BYTES).toString("utf8");
  const text = got.contentType.includes("text/plain") ? raw : htmlToText(raw);
  return text.slice(0, PAGE_TEXT_CHARS);
}

// ── Web fetch ──────────────────────────────────────────────────────────────

const FETCH_MAX_URL = 250;
const FETCH_MAX_HTML_BYTES = 4 * 1024 * 1024;
const FETCH_MAX_PDF_BYTES = 32 * 1024 * 1024;
/** Text of a fetched page given to the model when max_content_tokens is not set. */
const FETCH_DEFAULT_TEXT_CHARS = 100_000;

export type FetchedDocument =
  | { ok: true; url: string; title: string; text?: string; pdfBase64?: string }
  | { ok: false; errorCode: string };

function titleOf(html: string): string {
  const m = /<title[^>]{0,200}>([\s\S]{0,500}?)<\/title>/i.exec(html.slice(0, 200_000));
  return m ? htmlToText(m[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

/** One web fetch, as the real tool does it: text and HTML as text, PDF as base64. */
async function fetchDocument(
  url: string,
  maxChars: number,
  signal: AbortSignal | null | undefined
): Promise<FetchedDocument> {
  const got = await fetchUrl(
    url,
    signal,
    FETCH_MAX_PDF_BYTES,
    "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.9,*/*;q=0.5"
  );
  if (!got) return { ok: false, errorCode: "url_not_accessible" };
  if (got.status === 429) return { ok: false, errorCode: "too_many_requests" };
  if (got.status !== 200) return { ok: false, errorCode: "url_not_accessible" };
  const type = got.contentType;
  const isPdf = type.includes("application/pdf") || got.bytes.subarray(0, 5).toString() === "%PDF-";
  if (isPdf) {
    if (got.bytes.length > FETCH_MAX_PDF_BYTES)
      return { ok: false, errorCode: "content_too_large" };
    return { ok: true, url: got.url, title: "", pdfBase64: got.bytes.toString("base64") };
  }
  const textual =
    /text\/|application\/(xhtml\+xml|xml|json|javascript|x-javascript|rss\+xml|atom\+xml)/.test(
      type
    ) || type === "";
  if (!textual) return { ok: false, errorCode: "unsupported_content_type" };
  const raw = got.bytes.subarray(0, FETCH_MAX_HTML_BYTES).toString("utf8");
  const html = /html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(raw.slice(0, 200));
  let text = html ? htmlToText(raw.slice(0, FETCH_MAX_HTML_BYTES)) : raw;
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[... cut at the content limit]`;
  return { ok: true, url: got.url, title: html ? titleOf(raw) : "", text };
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>`{}|\\^[\]]+/gi;

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.replace(/[.,;:!?)]+$/, ""));
    u.hash = "";
    let s = u.href;
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    if (u.pathname === "/" && !u.search) s = `${u.protocol}//${u.host}`;
    return s.toLowerCase();
  } catch {
    return "";
  }
}

function urlsIn(text: string, into: Set<string>) {
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const n = normalizeUrl(m[0]);
    if (n) into.add(n);
  }
}

/** A URL that looks like it carries a credential (user:password@, or a key / token parameter). */
function urlHasCredential(url: URL): boolean {
  if (url.username || url.password) return true;
  for (const key of url.searchParams.keys()) {
    if (/(^|[_-])(key|apikey|token|secret|password|passwd|pwd|auth|signature|sig)$/i.test(key)) {
      return true;
    }
  }
  return false;
}

type UrlSourceRule = { type: string; tools: string[] };
type UrlSources = {
  user: UrlSourceRule;
  client: UrlSourceRule;
  server: UrlSourceRule;
};

function urlSourceRule(value: unknown): UrlSourceRule {
  const v = (value || {}) as JsonRecord;
  const type = typeof v.type === "string" ? v.type : "all";
  const tools = Array.isArray(v.tools)
    ? (v.tools as JsonRecord[]).map((t) => String(t?.name || "")).filter(Boolean)
    : [];
  return { type, tools };
}

function ruleAllows(rule: UrlSourceRule, toolName: string): boolean {
  if (rule.type === "none") return false;
  if (rule.type === "only") return rule.tools.includes(toolName);
  if (rule.type === "except") return !rule.tools.includes(toolName);
  return true;
}

/**
 * The URLs the web fetch tool may open (the real API's rule: URLs that appeared earlier in user
 * messages, client tool results or web search / fetch results, as `url_sources` allows), and the
 * URLs the user wrote (a URL with a credential must come from there).
 */
function priorContextUrls(
  messages: unknown[],
  sources: UrlSources
): { allowed: Set<string>; user: Set<string> } {
  const allowed = new Set<string>();
  const user = new Set<string>();
  const toolNames = new Map<string, string>();
  for (const m of messages as JsonRecord[]) {
    const content = m?.content;
    if (m?.role === "assistant" && Array.isArray(content)) {
      for (const b of content as JsonRecord[]) {
        if ((b?.type === "tool_use" || b?.type === "server_tool_use") && b.id) {
          toolNames.set(String(b.id), String(b.name || ""));
        }
        if (b?.type === "web_search_tool_result" && ruleAllows(sources.server, "web_search")) {
          for (const r of Array.isArray(b.content) ? (b.content as JsonRecord[]) : []) {
            if (typeof r?.url === "string") urlsIn(r.url, allowed);
          }
        }
        if (b?.type === "web_fetch_tool_result" && ruleAllows(sources.server, "web_fetch")) {
          const res = b.content as JsonRecord | undefined;
          if (typeof res?.url === "string") urlsIn(res.url, allowed);
          const src = (res?.content as JsonRecord | undefined)?.source as JsonRecord | undefined;
          if (src?.type === "text" && typeof src.data === "string") urlsIn(src.data, allowed);
        }
      }
      continue;
    }
    if (m?.role !== "user") continue;
    if (typeof content === "string") {
      urlsIn(content, user);
      continue;
    }
    for (const b of Array.isArray(content) ? (content as JsonRecord[]) : []) {
      if (b?.type === "text" && typeof b.text === "string") urlsIn(b.text, user);
      if (b?.type === "tool_result") {
        const name = toolNames.get(String(b.tool_use_id || "")) || "";
        if (!ruleAllows(sources.client, name)) continue;
        const parts = typeof b.content === "string" ? [b.content] : [];
        for (const c of Array.isArray(b.content) ? (b.content as JsonRecord[]) : []) {
          if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
        for (const p of parts) urlsIn(p, allowed);
      }
    }
  }
  if (sources.user.type !== "none") for (const u of user) allowed.add(u);
  return { allowed, user };
}

async function searchWithPages(
  query: string,
  opts: SearchOptions,
  signal: AbortSignal | null | undefined,
  log?: Log
): Promise<WebSearchResultItem[]> {
  const { items, provider } = await runSearch(query, opts, log);
  if (process.env.TROUTEAI_WEB_SEARCH_READ_PAGES !== "0") {
    await Promise.all(
      items.slice(0, PAGES_READ_PER_SEARCH).map(async (item) => {
        if (!item.pageText) item.pageText = await fetchPageText(item.url, signal);
      })
    );
  }
  log?.info?.(
    "WEBSEARCH",
    `"${query.slice(0, 80)}": ${items.length} results via ${provider}, ${items.filter((i) => i.pageText).length} pages read`
  );
  return items;
}

// ── Native fallback ──────────────────────────────────────────────────────

function versionOf(id: string): number {
  const m = /(?:opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d))?(?:$|[^0-9])/.exec(id);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0;
}

/** A model that runs web search itself, for when TRouteAI's own search is not reachable. */
export async function resolveNativeWebSearchModel(): Promise<string | null> {
  const configured = (process.env.TROUTEAI_WEB_SEARCH_FALLBACK_MODEL || "").trim();
  if (configured) return configured.toLowerCase() === "off" ? null : configured;
  for (const provider of ["claude", "anthropic"]) {
    const connections = (await getProviderConnections({ provider }).catch(
      () => []
    )) as JsonRecord[];
    if (!connections.some((c) => c?.isActive !== false)) continue;
    const custom = ((await getCustomModels(provider).catch(() => [])) || []) as JsonRecord[];
    const ids = new Set<string>([
      ...getModelsByProviderId(provider).map((m) => m.id),
      ...custom.map((m) => String(m?.id || "")).filter(Boolean),
    ]);
    const visible = [...ids].filter((id) => {
      try {
        return !getModelIsHidden(provider, id);
      } catch {
        return true;
      }
    });
    const byVersion = (a: string, b: string) => versionOf(b) - versionOf(a);
    const pick = visible.filter((id) => id.includes("sonnet")).sort(byVersion)[0];
    if (pick) return `${provider}/${pick}`;
  }
  return null;
}

// ── The loop ─────────────────────────────────────────────────────────────

const newId = (prefix: string) => `${prefix}${randomBytes(12).toString("base64url")}`;

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

function addUsage(total: Usage, usage: unknown) {
  const u = (usage || {}) as JsonRecord;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  total.input_tokens += n(u.input_tokens);
  total.output_tokens += n(u.output_tokens);
  total.cache_creation_input_tokens += n(u.cache_creation_input_tokens);
  total.cache_read_input_tokens += n(u.cache_read_input_tokens);
}

type Emitter = {
  start(message: JsonRecord): void;
  block(block: JsonRecord): void;
  ping(): void;
  finish(message: JsonRecord): void;
  fail(message: string): void;
};

export type WebSearchEmulationArgs = {
  request: { signal?: AbortSignal | null };
  body: JsonRecord;
  /** One non-streaming model turn through TRouteAI's normal routing (Claude format in/out). */
  callModel: (body: JsonRecord) => Promise<Response>;
  apiKeyId?: string | null;
  log?: Log;
  /** Tests: replace the search (default: configured provider, else DuckDuckGo, + page text). */
  search?: (query: string, opts: SearchOptions) => Promise<WebSearchResultItem[]>;
  /** Tests: replace the choice of the native web search model. */
  nativeModel?: () => Promise<string | null>;
  /** Tests: replace the web fetch (default: a public-only GET, HTML as text, PDF as base64). */
  fetch?: (url: string, maxChars: number) => Promise<FetchedDocument>;
};

export async function runWebSearchEmulation(args: WebSearchEmulationArgs): Promise<Response> {
  const { body, callModel, log } = args;
  const signal = args.request?.signal ?? null;
  const search =
    args.search ||
    ((query: string, opts: SearchOptions) => searchWithPages(query, opts, signal, log));
  const nativeModel = args.nativeModel || resolveNativeWebSearchModel;
  const fetchDoc =
    args.fetch || ((url: string, maxChars: number) => fetchDocument(url, maxChars, signal));
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const searchTool = tools.find(isServerWebSearchTool) as JsonRecord | undefined;
  const fetchTool = tools.find(isServerWebFetchTool) as JsonRecord | undefined;
  const clientTools = tools.filter(
    (t) => !isServerWebSearchTool(t) && !isServerWebFetchTool(t)
  ) as JsonRecord[];
  const clientToolNames = new Set(clientTools.map((t) => String(t?.name || "")));
  const fnName = clientToolNames.has("web_search") ? "trouteai_web_search" : "web_search";
  const fetchFnName = clientToolNames.has("web_fetch") ? "trouteai_web_fetch" : "web_fetch";
  const usesOf = (tool: JsonRecord | undefined) =>
    Math.min(
      MAX_USES_CAP,
      Math.max(1, Number(tool?.max_uses) > 0 ? Number(tool?.max_uses) : DEFAULT_MAX_USES)
    );
  const maxUses = usesOf(searchTool);
  const maxFetches = usesOf(fetchTool);
  const fetchMaxChars =
    Number(fetchTool?.max_content_tokens) > 0
      ? Math.min(400_000, Math.ceil(Number(fetchTool?.max_content_tokens) * 3))
      : FETCH_DEFAULT_TEXT_CHARS;
  const fetchCitations = (fetchTool?.citations as JsonRecord | undefined)?.enabled === true;
  const urlSources: UrlSources = {
    user: urlSourceRule((fetchTool?.url_sources as JsonRecord | undefined)?.user_input),
    client: urlSourceRule((fetchTool?.url_sources as JsonRecord | undefined)?.client_tool_results),
    server: urlSourceRule((fetchTool?.url_sources as JsonRecord | undefined)?.server_tool_results),
  };
  const searchOptions: SearchOptions = {
    allowed: stringList(searchTool?.allowed_domains),
    blocked: stringList(searchTool?.blocked_domains),
    apiKeyId: args.apiKeyId,
  };
  const fetchDomains = {
    allowed: stringList(fetchTool?.allowed_domains),
    blocked: stringList(fetchTool?.blocked_domains),
  };
  const fnTool = {
    name: fnName,
    description:
      "Search the web for current information. Returns the top results with title, URL, a " +
      "summary and the text of the first pages. Use it when the answer needs recent or outside facts.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The search query" } },
      required: ["query"],
    },
  };
  const fetchFnTool = {
    name: fetchFnName,
    description:
      "Fetch the full content of a web page or PDF by its URL. Only URLs that appeared earlier " +
      "in the conversation (written by the user, in a tool result, or in web search / fetch " +
      "results) can be fetched.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to fetch" } },
      required: ["url"],
    },
  };
  const choice = body.tool_choice as JsonRecord | undefined;
  const forcedName =
    choice?.type === "tool" && searchTool && choice.name === searchTool.name
      ? fnName
      : choice?.type === "tool" && fetchTool && choice.name === fetchTool.name
        ? fetchFnName
        : choice?.type === "any" && clientTools.length === 0 && !(searchTool && fetchTool)
          ? searchTool
            ? fnName
            : fetchFnName
          : "";
  const forced = choice?.type === "any" || !!forcedName;
  const messages = [...((body.messages as unknown[]) || [])];
  const { allowed: fetchableUrls, user: userUrls } = priorContextUrls(messages, urlSources);
  const turnBody = (withSearch: boolean, withFetch: boolean, first: boolean): JsonRecord => {
    const serverFns = [
      ...(searchTool && withSearch ? [fnTool] : []),
      ...(fetchTool && withFetch ? [fetchFnTool] : []),
    ];
    const next: JsonRecord = {
      ...body,
      stream: false,
      messages,
      tools: [...clientTools, ...serverFns],
    };
    if ((next.tools as unknown[]).length === 0) delete next.tools;
    if (forced && first && forcedName && serverFns.some((f) => f.name === forcedName)) {
      next.tool_choice = { type: "tool", name: forcedName };
    } else if (body.tool_choice && (forced || serverFns.length === 0)) {
      if ((next.tools as unknown[] | undefined)?.length) {
        next.tool_choice = first && choice?.type === "any" ? { type: "any" } : { type: "auto" };
      } else delete next.tool_choice;
    }
    return next;
  };
  const isServerFn = (b: JsonRecord) =>
    b?.type === "tool_use" &&
    ((!!searchTool && b.name === fnName) || (!!fetchTool && b.name === fetchFnName));
  const checkFetchUrl = (url: string): string => {
    if (!url) return "invalid_tool_input";
    if (url.length > FETCH_MAX_URL) return "url_too_long";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "invalid_tool_input";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalid_tool_input";
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || isPrivateHost(host)) return "url_not_allowed";
    if (fetchDomains.blocked.some((d) => domainMatches(host, d))) return "url_not_allowed";
    if (fetchDomains.allowed.length && !fetchDomains.allowed.some((d) => domainMatches(host, d))) {
      return "url_not_allowed";
    }
    const normalized = normalizeUrl(url);
    if (urlHasCredential(parsed) && !userUrls.has(normalized)) return "url_not_allowed";
    if (!fetchableUrls.has(normalized)) return "url_not_in_prior_context";
    return "";
  };

  // First model turn before any byte goes out: its errors keep their normal status code.
  const firstRes = await callModel(turnBody(true, true, true));
  if (!firstRes.ok) return firstRes;
  let current = (await firstRes.json().catch(() => null)) as JsonRecord | null;
  if (!current || !Array.isArray(current.content)) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "The model answered in an unexpected format" },
      }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      }
    );
  }

  // The first search, also before any byte goes out: when no search works at all, a model with
  // its own web search takes the whole request instead.
  const firstCalls = searchTool
    ? (current.content as JsonRecord[]).filter((b) => b?.type === "tool_use" && b.name === fnName)
    : [];
  let prefetched: Map<string, WebSearchResultItem[] | Error> | null = null;
  if (firstCalls.length > 0) {
    prefetched = new Map();
    const firstQuery = String((firstCalls[0].input as JsonRecord | undefined)?.query || "").trim();
    try {
      prefetched.set(String(firstCalls[0].id), await search(firstQuery, searchOptions));
    } catch (error) {
      const native = await nativeModel().catch(() => null);
      if (native) {
        log?.warn?.("WEBSEARCH", `no web search reachable; sending this request to ${native}`);
        const routed = await callModel({ ...body, model: native });
        if (routed.ok) return routed;
        await routed.body?.cancel().catch(() => {});
      }
      prefetched.set(String(firstCalls[0].id), error as Error);
    }
  }

  const wantStream = body.stream === true;
  const total: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let searches = 0;
  let fetches = 0;
  const serverToolUsage = () => ({
    ...(searchTool ? { web_search_requests: searches } : {}),
    ...(fetchTool ? { web_fetch_requests: fetches } : {}),
  });

  let cancelled = false;
  const stopped = () => cancelled || !!signal?.aborted;
  const run = async (emit: Emitter) => {
    const out: JsonRecord[] = [];
    const push = (block: JsonRecord) => {
      out.push(block);
      emit.block(block);
    };
    emit.start(current as JsonRecord);
    let withSearch = true;
    let withFetch = true;
    for (let turn = 0; turn < MAX_USES_CAP + 2; turn++) {
      const msg = current as JsonRecord;
      addUsage(total, msg.usage);
      const content = (msg.content as JsonRecord[]) || [];
      const calls = content.filter(isServerFn);
      const clientCall = content.some((b) => b?.type === "tool_use" && !isServerFn(b));
      const results: JsonRecord[] = [];
      for (const block of content) {
        if (!isServerFn(block)) {
          push(block);
          continue;
        }
        if (block.name === fetchFnName && fetchTool) {
          const url = String((block.input as JsonRecord | undefined)?.url || "").trim();
          const srvId = newId("srvtoolu_");
          push({
            type: "server_tool_use",
            id: srvId,
            name: String(fetchTool.name || "web_fetch"),
            input: { url },
          });
          let errorCode = "";
          let doc: FetchedDocument | null = null;
          if (fetches >= maxFetches) {
            errorCode = "max_uses_exceeded";
          } else {
            fetches++; // failed fetches count against the limit, as in the real tool
            errorCode = checkFetchUrl(url);
            if (!errorCode) {
              doc = await fetchDoc(url, fetchMaxChars).catch(
                () => ({ ok: false, errorCode: "unavailable" }) as FetchedDocument
              );
              if (!doc.ok) errorCode = (doc as { errorCode: string }).errorCode;
            }
          }
          if (doc?.ok) {
            const docBlock: JsonRecord = doc.pdfBase64
              ? {
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: doc.pdfBase64 },
                }
              : {
                  type: "document",
                  source: { type: "text", media_type: "text/plain", data: doc.text || "" },
                  ...(doc.title ? { title: doc.title } : {}),
                };
            if (fetchCitations) docBlock.citations = { enabled: true };
            push({
              type: "web_fetch_tool_result",
              tool_use_id: srvId,
              content: {
                type: "web_fetch_result",
                url: doc.url,
                content: docBlock,
                retrieved_at: new Date().toISOString(),
              },
            });
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: [
                { type: "text", text: `Fetched ${doc.url}${doc.title ? ` (${doc.title})` : ""}:` },
                docBlock,
              ],
            });
            // Links on a fetched page can be fetched next, as in the real tool.
            fetchableUrls.add(normalizeUrl(doc.url));
            if (doc.text && ruleAllows(urlSources.server, "web_fetch")) {
              urlsIn(doc.text, fetchableUrls);
            }
          } else {
            push({
              type: "web_fetch_tool_result",
              tool_use_id: srvId,
              content: { type: "web_fetch_tool_result_error", error_code: errorCode },
            });
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content:
                errorCode === "url_not_in_prior_context"
                  ? "This URL cannot be fetched: only URLs that appeared earlier in the conversation (from the user, a tool result or a web search) can be. Search for it first or ask the user for it."
                  : errorCode === "max_uses_exceeded"
                    ? "The fetch limit for this request is reached. Answer now with what you have."
                    : `The page could not be fetched (${errorCode}).`,
            });
          }
          continue;
        }
        const query = String((block.input as JsonRecord | undefined)?.query || "").trim();
        const srvId = newId("srvtoolu_");
        push({
          type: "server_tool_use",
          id: srvId,
          name: String(searchTool?.name || "web_search"),
          input: { query },
        });
        let items: WebSearchResultItem[] | null = null;
        let errorCode = "";
        if (searches >= maxUses) {
          errorCode = "max_uses_exceeded";
        } else if (!query) {
          errorCode = "invalid_tool_input";
        } else {
          searches++;
          const pre = prefetched?.get(String(block.id));
          const got =
            pre !== undefined ? pre : await search(query, searchOptions).catch((e) => e as Error);
          if (got instanceof Error) errorCode = "unavailable";
          else items = got;
        }
        // Search results can be fetched next (combined search + fetch).
        if (items && ruleAllows(urlSources.server, "web_search")) {
          for (const it of items) fetchableUrls.add(normalizeUrl(it.url));
        }
        push({
          type: "web_search_tool_result",
          tool_use_id: srvId,
          content: items
            ? items.map((it) => ({
                type: "web_search_result",
                title: it.title,
                url: it.url,
                encrypted_content: encodeWebSearchContent(it),
                page_age: it.pageAge || null,
              }))
            : { type: "web_search_tool_result_error", error_code: errorCode },
        });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: items
            ? formatWebSearchResultsForModel(query, items)
            : errorCode === "max_uses_exceeded"
              ? "The search limit for this request is reached. Answer now with what you have."
              : "The web search is not available right now. Answer from what you know and say that you could not search.",
          ...(items ? {} : { is_error: true }),
        });
      }
      prefetched = null;
      const done = calls.length === 0 || clientCall || stopped();
      if (done) {
        emit.finish({
          ...msg,
          usage: { ...total, server_tool_use: serverToolUsage() },
        });
        return;
      }
      // Next turn: the model's own blocks (thinking keeps its signature) + the results.
      messages.push({ role: "assistant", content }, { role: "user", content: results });
      if (searches >= maxUses) withSearch = false;
      if (fetches >= maxFetches) withFetch = false;
      const res = await callModel(turnBody(withSearch, withFetch, false));
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = `The model request failed (HTTP ${res.status})`;
        try {
          const parsed = JSON.parse(text);
          message = String(parsed?.error?.message || parsed?.message || message);
        } catch {}
        emit.fail(message);
        return;
      }
      current = (await res.json().catch(() => null)) as JsonRecord | null;
      if (!current || !Array.isArray(current.content)) {
        emit.fail("The model answered in an unexpected format");
        return;
      }
    }
    emit.finish({
      ...(current as JsonRecord),
      usage: { ...total, server_tool_use: serverToolUsage() },
    });
  };

  if (!wantStream) {
    const blocks: JsonRecord[] = [];
    const result: { final: JsonRecord | null; failure: string } = { final: null, failure: "" };
    await run({
      start() {},
      block: (b) => blocks.push(b),
      ping() {},
      finish: (m) => {
        result.final = m;
      },
      fail: (m) => {
        result.failure = m;
      },
    });
    if (result.failure || !result.final) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: result.failure || "Web search failed" },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
    const f = result.final;
    return new Response(
      JSON.stringify({
        id: f.id,
        type: "message",
        role: "assistant",
        model: f.model,
        content: blocks,
        stop_reason: f.stop_reason ?? "end_turn",
        stop_sequence: f.stop_sequence ?? null,
        stop_details: f.stop_details ?? null,
        usage: f.usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: JsonRecord) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      let index = 0;
      const pinger = setInterval(() => send("ping", { type: "ping" }), PING_INTERVAL_MS);
      const chunks = (text: string, size: number) =>
        text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) || [];
      const emit: Emitter = {
        start(m) {
          send("message_start", {
            type: "message_start",
            message: {
              id: m.id,
              type: "message",
              role: "assistant",
              model: m.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: (m.usage as JsonRecord | undefined)?.input_tokens ?? 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          });
        },
        block(b) {
          const i = index++;
          if (b.type === "text") {
            send("content_block_start", {
              type: "content_block_start",
              index: i,
              content_block: { type: "text", text: "" },
            });
            for (const piece of chunks(String(b.text || ""), 200)) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: i,
                delta: { type: "text_delta", text: piece },
              });
            }
          } else if (b.type === "thinking") {
            send("content_block_start", {
              type: "content_block_start",
              index: i,
              content_block: { type: "thinking", thinking: "" },
            });
            for (const piece of chunks(String(b.thinking || ""), 400)) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: i,
                delta: { type: "thinking_delta", thinking: piece },
              });
            }
            if (typeof b.signature === "string" && b.signature) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: i,
                delta: { type: "signature_delta", signature: b.signature },
              });
            }
          } else if (b.type === "tool_use" || b.type === "server_tool_use") {
            send("content_block_start", {
              type: "content_block_start",
              index: i,
              content_block: { type: b.type, id: b.id, name: b.name, input: {} },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: i,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) },
            });
          } else {
            send("content_block_start", {
              type: "content_block_start",
              index: i,
              content_block: b,
            });
          }
          send("content_block_stop", { type: "content_block_stop", index: i });
        },
        ping() {
          send("ping", { type: "ping" });
        },
        finish(m) {
          send("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: m.stop_reason ?? "end_turn",
              stop_sequence: m.stop_sequence ?? null,
              stop_details: m.stop_details ?? null,
            },
            usage: m.usage,
          });
          send("message_stop", { type: "message_stop" });
        },
        fail(message) {
          send("error", { type: "error", error: { type: "api_error", message } });
        },
      };
      try {
        await run(emit);
      } catch (error) {
        emit.fail(error instanceof Error ? error.message : "Web search failed");
      } finally {
        clearInterval(pinger);
        if (!closed && !cancelled) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      }
    },
    cancel() {
      // The client went away: no further model turns or searches.
      cancelled = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
