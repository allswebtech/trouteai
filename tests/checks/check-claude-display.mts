// The claude (Claude subscription) provider: thinking.display values the backend refuses
// ("updates" from newer Claude Code got 400 "thinking.adaptive.display: Input should be
// 'summarized', 'omitted'" live on 2026-11-10) become "summarized"; the accepted values stay.
// No network: fetch is replaced and the request TRouteAI would send is read back.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-claude-display.mts
import { getExecutor } from "../../open-sse/executors/index.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const realFetch = globalThis.fetch;
async function sentThinking(display: string | undefined) {
  let sent: Record<string, any> | null = null;
  globalThis.fetch = (async (url: unknown, init: { body?: string }) => {
    if (String(url).includes("/v1/messages")) sent = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as never;
  try {
    const executor = await getExecutor("claude");
    await executor.execute({
      model: "claude-sonnet-5",
      body: {
        model: "claude-sonnet-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "adaptive", ...(display === undefined ? {} : { display }) },
        output_config: { effort: "high" },
      },
      stream: false,
      credentials: { accessToken: "sk-ant-oat01-test", providerSpecificData: {} },
      clientHeaders: { "x-app": "cli", "user-agent": "claude-cli/2.1.321 (external, cli)" },
      log: null,
    } as never);
  } finally {
    globalThis.fetch = realFetch;
  }
  return (sent as Record<string, any> | null)?.thinking;
}

const updates = await sentThinking("updates");
check(
  '"updates" becomes "summarized"',
  updates?.display === "summarized" && updates?.type === "adaptive",
  JSON.stringify(updates)
);
check('"summarized" stays', (await sentThinking("summarized"))?.display === "summarized");
check('"omitted" stays', (await sentThinking("omitted"))?.display === "omitted");
check("no display: nothing added", (await sentThinking(undefined))?.display === undefined);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
