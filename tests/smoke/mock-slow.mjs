// Fake OpenAI-compatible provider whose answers are slow on purpose, for the checks of what
// programs in front of TRouteAI need (tests/smoke/fit.sh). The model name picks the behaviour:
//   fast        a normal answer, with usage in the last stream chunk
//   slow-first  waits SLOW_FIRST_MS before sending anything (a model that thinks first)
//   pause-mid   sends one chunk, is silent for PAUSE_MS, then finishes
//   hang        sends one chunk, then nothing until the connection is closed
// Usage: node mock-slow.mjs <port>
import http from "node:http";

const port = Number(process.argv[2] || 21173);
const SLOW_FIRST_MS = Number(process.env.SLOW_FIRST_MS || 4000);
const PAUSE_MS = Number(process.env.PAUSE_MS || 4000);
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(model, delta, extra = {}, finish = null) {
  const payload = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", async () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: ["fast", "slow-first", "pause-mid", "hang"].map((id) => ({
              id,
              object: "model",
            })),
          })
        );
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      const model = String(parsed.model || "fast");
      if (model === "slow-first") await sleep(SLOW_FIRST_MS);
      if (res.destroyed) return;

      if (!parsed.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion",
            created: 1,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "fake answer" },
                finish_reason: "stop",
              },
            ],
            usage,
          })
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk(model, { role: "assistant", content: "fake " }));
      if (model === "hang") return; // stays open until the client goes away
      if (model === "pause-mid") await sleep(PAUSE_MS);
      if (res.destroyed) return;
      res.write(chunk(model, { content: "answer" }));
      res.write(chunk(model, {}, { usage }, "stop"));
      res.end("data: [DONE]\n\n");
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`slow mock on http://127.0.0.1:${port}/v1`));
