// Stand-in Claude Messages upstream for the load playback (load-e2e.mjs). Each API key
// (x-api-key) is one account; three are known:
//
//   alpha, bravo   take LOAD_SLOTS requests at once (default 3) and answer after
//                  LOAD_ANSWER_MS (default 1500), streamed or not, as the body asks. One more
//                  at once gets the upstream's "500 encountered unexpectedly high load".
//   charlie        quota used up: the Claude-style usage-limit 429 with a reset about three
//                  weeks away (seven_day claim, like mock-anthropic.mjs "limit").
//
// Every request is recorded: {id, account, stream, arrival, start, end, outcome}; id is the
// "load-req-<n>" the client puts in its message, times are Date.now() on this machine.
//
//   POST /v1/messages   answer or refuse as above
//   GET  /__stats       {slots, answerMs, records: [...], inFlight: {alpha, bravo}}
//   POST /__reset       clear the records; {"answerMs": n} sets a new answer time
//
// Usage: node mock-load.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] || 20994);
const SLOTS = Math.max(1, Number(process.env.LOAD_SLOTS || 3));
let ANSWER_MS = Math.max(0, Number(process.env.LOAD_ANSWER_MS || 1500));
const EXHAUSTED = new Set(["charlie"]);
const RESET_AT = Math.floor(Date.now() / 1000) + 21 * 86400;
const inFlight = { alpha: 0, bravo: 0, charlie: 0 };
const records = [];

function json(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function rateHeaders(limited) {
  const now = Math.floor(Date.now() / 1000);
  const h = {
    "anthropic-ratelimit-unified-status": limited ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": String(now + 4 * 3600),
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": limited ? "1" : "0.31",
    "anthropic-ratelimit-unified-7d-reset": String(limited ? RESET_AT : now + 5 * 86400),
    "anthropic-ratelimit-unified-7d-status": limited ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-overage-status": "rejected",
  };
  if (limited) {
    h["anthropic-ratelimit-unified-representative-claim"] = "seven_day";
    h["anthropic-ratelimit-unified-reset"] = String(RESET_AT);
    h["retry-after"] = String(Math.max(0, RESET_AT - now));
  }
  return h;
}

function answer(res, key, model, stream) {
  const text = `Hello from account ${key}`;
  const headers = rateHeaders(false);
  if (!stream) {
    return json(
      res,
      200,
      {
        id: "msg_load",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 4 },
      },
      headers
    );
  }
  res.writeHead(200, { "content-type": "text/event-stream", ...headers });
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.write(
    ev("message_start", {
      message: {
        id: "msg_load",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    })
  );
  res.write(ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
  res.write(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
  res.write(ev("content_block_stop", { index: 0 }));
  res.write(
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })
  );
  res.end(ev("message_stop", {}));
}

http
  .createServer(async (req, res) => {
    const arrival = Date.now();
    const body = await readBody(req);
    if (req.url === "/__stats") {
      return json(res, 200, { slots: SLOTS, answerMs: ANSWER_MS, records, inFlight });
    }
    if (req.url === "/__reset" && req.method === "POST") {
      records.length = 0;
      try {
        const n = Number(JSON.parse(body || "{}").answerMs);
        if (Number.isFinite(n) && n >= 0) ANSWER_MS = n;
      } catch {
        // keep the answer time
      }
      return json(res, 200, { ok: true, answerMs: ANSWER_MS });
    }
    if (req.url.endsWith("/models")) {
      return json(res, 200, { data: [{ id: "claude-opus-mock", type: "model" }] });
    }
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      // keep defaults
    }
    const key = String(req.headers["x-api-key"] || req.headers.authorization || "none").replace(
      /^Bearer\s+/i,
      ""
    );
    const model = String(parsed.model || "unknown");
    const id = (body.match(/load-req-(\d+)/) || [])[1] ?? null;
    const rec = {
      id: id === null ? null : Number(id),
      account: key,
      stream: !!parsed.stream,
      arrival,
      start: null,
      end: null,
      outcome: "",
    };
    records.push(rec);

    if (EXHAUSTED.has(key)) {
      rec.end = Date.now();
      rec.outcome = "usage-limit-429";
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
        rateHeaders(true)
      );
    }
    if (!(key in inFlight)) {
      rec.end = Date.now();
      rec.outcome = "unknown-key-401";
      return json(res, 401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      });
    }
    if (inFlight[key] >= SLOTS) {
      rec.end = Date.now();
      rec.outcome = "high-load-500";
      return json(res, 500, {
        type: "error",
        error: { type: "api_error", message: "encountered unexpectedly high load" },
      });
    }
    inFlight[key]++;
    rec.start = Date.now();
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      inFlight[key]--;
      rec.end = Date.now();
      rec.outcome = outcome;
    };
    res.on("close", () => finish("client-gone"));
    await new Promise((r) => setTimeout(r, ANSWER_MS));
    if (done) return;
    finish("answered");
    answer(res, key, model, !!parsed.stream);
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`mock load on ${port} (slots ${SLOTS}, answer ${ANSWER_MS} ms)`)
  );
