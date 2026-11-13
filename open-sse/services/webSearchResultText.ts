/**
 * Shared pieces of TRouteAI's own run of Anthropic's web search server tool (see
 * src/sse/handlers/webSearchEmulation.ts): the `encrypted_content` TRouteAI puts on each
 * `web_search_result` it returns, and the text a model reads for search results.
 *
 * The real API's `encrypted_content` is opaque page content the client sends back in later
 * turns. TRouteAI's is `trouteai1.` + base64url(JSON {s: snippet, t: page text}), so a later
 * turn can give the model the same text again.
 */

const PREFIX = "trouteai1.";

export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  pageText?: string;
  pageAge?: string | null;
};

export function encodeWebSearchContent(item: { snippet?: string; pageText?: string }): string {
  const json = JSON.stringify({ s: item.snippet || "", t: item.pageText || "" });
  return PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

export function decodeWebSearchContent(value: unknown): { snippet: string; pageText: string } {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return { snippet: "", pageText: "" };
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8")
    );
    return {
      snippet: typeof parsed?.s === "string" ? parsed.s : "",
      pageText: typeof parsed?.t === "string" ? parsed.t : "",
    };
  } catch {
    return { snippet: "", pageText: "" };
  }
}

/** The search results as the model reads them (tool result text). */
export function formatWebSearchResultsForModel(
  query: string,
  items: WebSearchResultItem[]
): string {
  if (items.length === 0) return `No web results were found for "${query}".`;
  const lines = [`Web search results for "${query}":`];
  items.forEach((item, i) => {
    lines.push("", `[${i + 1}] ${item.title || item.url}`, `URL: ${item.url}`);
    if (item.pageAge) lines.push(`Date: ${item.pageAge}`);
    if (item.snippet) lines.push(`Summary: ${item.snippet}`);
    if (item.pageText) lines.push(`Page text: ${item.pageText}`);
  });
  lines.push(
    "",
    "Answer from these results and name the sources you used (title and URL). Say so if they do not answer the question."
  );
  return lines.join("\n");
}

/**
 * Text for an assistant message's earlier web search blocks (`server_tool_use` +
 * `web_search_tool_result`), for upstreams that take no such blocks (OpenAI format, Kiro).
 */
export function webSearchBlockToText(block: Record<string, unknown>): string {
  if (block.type === "server_tool_use") {
    const input = (block.input || {}) as Record<string, unknown>;
    const query = typeof input.query === "string" ? input.query : "";
    if (query) return `[Searched the web for: ${query}]`;
    const url = typeof input.url === "string" ? input.url : "";
    return url ? `[Fetched the web page: ${url}]` : "";
  }
  if (block.type === "web_search_tool_result") {
    const content = block.content;
    if (!Array.isArray(content)) {
      const code = (content as Record<string, unknown> | null)?.error_code;
      return `[The web search failed${typeof code === "string" ? `: ${code}` : ""}]`;
    }
    const items: WebSearchResultItem[] = content
      .filter((r) => r && typeof r === "object")
      .map((r) => {
        const rec = r as Record<string, unknown>;
        const decoded = decodeWebSearchContent(rec.encrypted_content);
        return {
          title: typeof rec.title === "string" ? rec.title : "",
          url: typeof rec.url === "string" ? rec.url : "",
          snippet: decoded.snippet,
          pageText: decoded.pageText,
          pageAge: typeof rec.page_age === "string" ? rec.page_age : null,
        };
      });
    return items.length
      ? formatWebSearchResultsForModel("the search above", items).replace(
          /\n\nAnswer from these[^]*$/,
          ""
        )
      : "[The web search found nothing]";
  }
  return "";
}
