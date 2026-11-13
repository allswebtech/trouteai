// Mock Anthropic Messages upstream that behaves like a Claude subscription account, for the
// usage-limit tests (quota-e2e.mjs). Each API key (x-api-key) is one "account".
//
//   POST /v1/messages        answer, or refuse with a Claude-style 429 when the account is limited
//   POST /__control          {key, mode, resetInSec?, claim?}  mode: ok | limit | plain429 |
//                            overflow-kiro | overflow-openai | overflow-openai-completion |
//                            overflow-anthropic (a provider's own "context too long" 400) |
//                            overflow-kiro-slow (the same after 3.5 s, past the keepalive
//                            threshold) | responses-overflow (POST /v1/responses: a 200 stream
//                            that fails with context_length_exceeded after response.created)
//   GET  /__stats            {hits: {<key>: n}, models: {<key>: [model,...]},
//                            last: {<key>: {bytes, tail}}}  (tail: the body still ends with
//                            the TAIL-MARKER the context test puts in a long tool result)
//   POST /__reset            clear hits and modes
//
// On every answer it sends the anthropic-ratelimit-unified-* headers the way Claude does
// (names and meaning checked in the Claude Code 2.1.319 binary): utilization is a 0..1
// fraction, *-reset is epoch seconds, -status is allowed | allowed_warning | rejected, and a
// limited account gets 429 with -status rejected, -representative-claim and -reset.
//
// Usage: node mock-anthropic.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] || 20998);
const accounts = new Map(); // key -> { mode, resetAt (epoch s), claim }
const hits = {};
const models = {};
const last = {};
const OVERFLOW_BODIES = {
  "overflow-kiro": {
    message: "Input is too long.",
    reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
  },
  "overflow-openai": {
    error: {
      message:
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens. Please reduce the length of the messages.",
      type: "invalid_request_error",
      param: "messages",
      code: null,
    },
  },
  "overflow-openai-completion": {
    error: {
      message:
        "This model's maximum context length is 128000 tokens. However, you requested 140000 tokens (100000 in the messages, 40000 in the completion). Please reduce the length of the messages or completion.",
      type: "invalid_request_error",
      param: "messages",
      code: null,
    },
  },
  "overflow-anthropic": {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 1022310 tokens > 1000000 maximum",
    },
  },
};

const nowSec = () => Math.floor(Date.now() / 1000);

function account(key) {
  if (!accounts.has(key)) accounts.set(key, { mode: "ok", resetAt: 0, claim: "five_hour" });
  return accounts.get(key);
}

function limitedFor(acc, model) {
  if (acc.mode !== "limit") return false;
  if (acc.resetAt && nowSec() >= acc.resetAt) {
    acc.mode = "ok"; // the window reset by itself, like the real service
    return false;
  }
  // a per-model weekly claim only refuses that model family
  if (acc.claim === "seven_day_opus") return /opus/i.test(model);
  if (acc.claim === "seven_day_sonnet") return /sonnet/i.test(model);
  return true;
}

function rateHeaders(acc, limited) {
  const fiveReset = acc.claim === "five_hour" && acc.resetAt ? acc.resetAt : nowSec() + 4 * 3600;
  const weekReset = acc.claim === "seven_day" && acc.resetAt ? acc.resetAt : nowSec() + 5 * 86400;
  const h = {
    "anthropic-ratelimit-unified-status": limited ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-5h-utilization": String(
      limited && acc.claim === "five_hour" ? 1 : 0.42
    ),
    "anthropic-ratelimit-unified-5h-reset": String(fiveReset),
    "anthropic-ratelimit-unified-5h-status":
      limited && acc.claim === "five_hour" ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-7d-utilization": String(
      limited && acc.claim === "seven_day" ? 1 : 0.31
    ),
    "anthropic-ratelimit-unified-7d-reset": String(weekReset),
    "anthropic-ratelimit-unified-7d-status":
      limited && acc.claim === "seven_day" ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-overage-status": "rejected",
  };
  if (limited) {
    h["anthropic-ratelimit-unified-representative-claim"] = acc.claim;
    h["anthropic-ratelimit-unified-reset"] = String(acc.resetAt);
    h["retry-after"] = String(Math.max(0, acc.resetAt - nowSec()));
  }
  return h;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function json(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

http
  .createServer(async (req, res) => {
    const body = await readBody(req);
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      // keep defaults
    }

    if (req.url === "/__control" && req.method === "POST") {
      const acc = account(parsed.key);
      acc.mode = parsed.mode || "ok";
      acc.claim = parsed.claim || "five_hour";
      acc.resetAt = parsed.resetInSec ? nowSec() + Number(parsed.resetInSec) : 0;
      return json(res, 200, { ok: true, key: parsed.key, ...acc });
    }
    if (req.url === "/__stats") return json(res, 200, { hits, models, last });
    if (req.url === "/__reset" && req.method === "POST") {
      accounts.clear();
      for (const k of Object.keys(hits)) delete hits[k];
      for (const k of Object.keys(models)) delete models[k];
      for (const k of Object.keys(last)) delete last[k];
      return json(res, 200, { ok: true });
    }
    if (req.url.endsWith("/models")) {
      return json(res, 200, {
        data: [
          { id: "claude-opus-mock", type: "model" },
          { id: "claude-sonnet-mock", type: "model" },
        ],
      });
    }

    const key = String(req.headers["x-api-key"] || req.headers.authorization || "none").replace(
      /^Bearer\s+/i,
      ""
    );
    const model = String(parsed.model || "unknown");
    hits[key] = (hits[key] || 0) + 1;
    (models[key] ||= []).push(model);
    last[key] = { bytes: body.length, tail: body.includes("TAIL-MARKER") };
    const acc = account(key);

    if (req.url.endsWith("/responses")) {
      // OpenAI Responses API upstream (openai-compatible node, apiType "responses")
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
      const response = {
        id: "resp_mock",
        object: "response",
        model,
        status: "in_progress",
        output: [],
      };
      res.write(ev({ type: "response.created", response }));
      if (acc.mode === "responses-overflow") {
        return res.end(
          ev({
            type: "response.failed",
            response: {
              ...response,
              status: "failed",
              error: {
                code: "context_length_exceeded",
                message:
                  "Your input exceeds the context window of this model. Please adjust your input and try again.",
              },
            },
          })
        );
      }
      res.write(
        ev({
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: `Hello from account ${key}`,
        })
      );
      return res.end(
        ev({
          type: "response.completed",
          response: {
            ...response,
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
          },
        })
      );
    }
    if (acc.mode === "overflow-kiro-slow") {
      await new Promise((r) => setTimeout(r, 3500));
      return json(res, 400, OVERFLOW_BODIES["overflow-kiro"]);
    }
    if (OVERFLOW_BODIES[acc.mode]) {
      return json(res, 400, OVERFLOW_BODIES[acc.mode]);
    }
    if (acc.mode === "plain429") {
      return json(res, 429, {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Too many requests, slow down",
        },
      });
    }
    const limited = limitedFor(acc, model);
    if (limited) {
      return json(
        res,
        429,
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "This request would exceed your account's rate limit. Please try again later.",
          },
        },
        rateHeaders(acc, true)
      );
    }

    const text = `Hello from account ${key}`;
    const usage = { input_tokens: 5, output_tokens: 4 };
    const headers = rateHeaders(acc, false);
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", ...headers });
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.write(
        ev("message_start", {
          message: {
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        })
      );
      res.write(
        ev("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        })
      );
      res.write(
        ev("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text },
        })
      );
      res.write(ev("content_block_stop", { index: 0 }));
      res.write(
        ev("message_delta", {
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 },
        })
      );
      res.end(ev("message_stop", {}));
      return;
    }
    return json(
      res,
      200,
      {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage,
      },
      headers
    );
  })
  .listen(port, "127.0.0.1", () => console.log(`mock anthropic on ${port}`));
