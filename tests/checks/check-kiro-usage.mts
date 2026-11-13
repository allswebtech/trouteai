// Check that Kiro's context-usage percentage becomes the token total of the model's own window
// (1M for Claude Opus/Sonnet 5.x), so Claude Code sees the real size and compacts in time.
// Run from the repository root: DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-kiro-usage.mts
import { KiroExecutor } from "../../open-sse/executors/kiro.ts";
import { crc32 } from "../../open-sse/executors/kiro/eventstream.ts";

const enc = new TextEncoder();
// One AWS event-stream frame: prelude (total, headers length, CRC), string headers, payload, CRC.
function frame(eventType: string, payload: unknown): Uint8Array {
  const headerBytes: number[] = [];
  for (const [name, value] of [
    [":event-type", eventType],
    [":message-type", "event"],
    [":content-type", "application/json"],
  ]) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    headerBytes.push(n.length, ...n, 7, v.length >> 8, v.length & 0xff, ...v);
  }
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headerBytes.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.slice(0, 8)));
  out.set(headerBytes, 12);
  out.set(body, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(out.slice(0, total - 4)));
  return out;
}

async function promptTokens(model: string, percent: number): Promise<number | null> {
  const frames = [
    frame("assistantResponseEvent", { content: "hello" }),
    frame("contextUsageEvent", { contextUsagePercentage: percent }),
  ];
  const upstream = new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(f);
        c.close();
      },
    })
  );
  const executor = new KiroExecutor();
  const sse = await executor.transformEventStreamToSSE(upstream, model).text();
  const usages = [...sse.matchAll(/"usage":(\{[^}]*\})/g)].map((m) => JSON.parse(m[1]));
  return usages.length ? usages[usages.length - 1] : null;
}

let failed = 0;
for (const [model, percent, want] of [
  ["claude-opus-5.5", 50, 500000],
  ["claude-sonnet-5", 10, 100000],
  ["claude-haiku-4.5", 50, 100000],
  ["some-unknown-kiro-model", 50, 100000],
] as const) {
  // Kiro's share already includes the answer (measured 2026-11-10), so it is the total; the
  // input is the total minus the output estimate.
  const usage = await promptTokens(model, percent);
  const total = Number(usage?.total_tokens);
  const got = Number(usage?.prompt_tokens);
  const out = Number(usage?.completion_tokens);
  const ok = total === want && got === want - out && out > 0;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${model} at ${percent}%: total ${total} (want ${want}) = prompt ${got} + output ${out}`
  );
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
