// Minimal OpenAI-compatible upstream for smoke tests: GET /v1/models and
// POST /v1/chat/completions (JSON or SSE stream). Usage: node mock-upstream.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] || 20997);
const text = "Hello from mock upstream";

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-mock", object: "model" }],
          })
        );
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        // keep defaults
      }
      const base = { id: "chatcmpl-mock", created: 1, model: "gpt-mock" };
      const usage = { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (choice, extra = {}) =>
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [choice], ...extra })}\n\n`;
        res.write(
          chunk({
            index: 0,
            delta: { role: "assistant", content: "Hello " },
            finish_reason: null,
          })
        );
        res.write(
          chunk({
            index: 0,
            delta: { content: "from mock upstream" },
            finish_reason: null,
          })
        );
        res.write(chunk({ index: 0, delta: {}, finish_reason: "stop" }, { usage }));
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage,
        })
      );
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock upstream on http://127.0.0.1:${port}/v1`));
