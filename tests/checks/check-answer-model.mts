// Who answered and under which name: the routing headers on answers and errors, and the model
// name echoed back to the client in every dialect. In-process, no server, no network.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-answer-model.mts
import {
  buildTRouteAISseMetadataComment,
  buildTRouteAIResponseMetaHeaders,
  mergeFallbackTokens,
  withTRouteAIRoutingHeaders,
} from "../../src/domain/trouteaiResponseMeta.ts";
import {
  createModelEchoTransform,
  echoModelInObject,
  echoModelInSseLine,
} from "../../open-sse/services/responseModelEcho.ts";
import { checkSemanticCache } from "../../open-sse/handlers/chatCore/semanticCache.ts";
import {
  checkIdempotencyCache,
  composeIdempotencyKey,
} from "../../open-sse/handlers/chatCore/idempotency.ts";
import { generateSignature, setCachedResponse } from "../../src/lib/semanticCache.ts";
import { saveIdempotency } from "../../src/lib/idempotencyLayer.ts";
import { withCodexPreferredModel } from "../../src/app/api/v1/responses/route.ts";
import { buildClientRawRequest } from "../../src/sse/handlers/chat/clientRawRequest.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// 1. The meta builder names the requested model and the fallback reason
{
  const h = buildTRouteAIResponseMetaHeaders({
    model: "claude-opus-5.5",
    provider: "kiro",
    requestedModel: "claude-opus-5-5",
    fallback: "combo-step",
    fallbackAttempts: 1,
  });
  check(
    "meta headers: requested model, fallback token and attempts",
    h["X-TRouteAI-Requested-Model"] === "claude-opus-5-5" &&
      h["X-TRouteAI-Fallback"] === "combo-step" &&
      h["X-TRouteAI-Fallback-Attempts"] === "1" &&
      h["X-TRouteAI-Model"] === "claude-opus-5.5",
    JSON.stringify(h)
  );
  const plain = buildTRouteAIResponseMetaHeaders({ model: "m", provider: "kiro" });
  check(
    "meta headers: no fallback headers on a first-choice answer",
    !("X-TRouteAI-Fallback" in plain) && !("X-TRouteAI-Fallback-Attempts" in plain)
  );
}

// 2. Outer layers add their facts to what inner layers set
{
  check(
    "fallback tokens: order kept, repeats dropped",
    mergeFallbackTokens("family", "combo-step, family", null, "global") ===
      "family, combo-step, global"
  );
  const inner = new Response("{}", {
    status: 200,
    headers: {
      "X-TRouteAI-Model": "claude-opus-4.8",
      "X-TRouteAI-Provider": "kiro",
      "X-TRouteAI-Fallback": "family",
    },
  });
  const out = withTRouteAIRoutingHeaders(inner, {
    requestedModel: "my-combo",
    model: "claude-opus-5.5",
    provider: "claude",
    fallback: "combo-step",
    fallbackAttempts: 2,
  });
  check(
    "routing headers: the inner model and provider win, tokens and attempts add up",
    out.headers.get("X-TRouteAI-Model") === "claude-opus-4.8" &&
      out.headers.get("X-TRouteAI-Provider") === "kiro" &&
      out.headers.get("X-TRouteAI-Requested-Model") === "my-combo" &&
      out.headers.get("X-TRouteAI-Fallback") === "family, combo-step" &&
      out.headers.get("X-TRouteAI-Fallback-Attempts") === "2"
  );
  const again = withTRouteAIRoutingHeaders(out, { fallback: "global", fallbackAttempts: 1 });
  check(
    "routing headers: a second outer layer appends again",
    again.headers.get("X-TRouteAI-Fallback") === "family, combo-step, global" &&
      again.headers.get("X-TRouteAI-Fallback-Attempts") === "3"
  );
  // fetch() answers have immutable headers: the helper must clone, not throw
  const locked = Response.redirect("http://127.0.0.1/x", 302);
  let threw = false;
  let cloned: Response | null = null;
  try {
    cloned = withTRouteAIRoutingHeaders(locked, { requestedModel: "x" });
  } catch {
    threw = true;
  }
  check(
    "routing headers: immutable headers are cloned, not thrown on",
    !threw && cloned?.headers.get("X-TRouteAI-Requested-Model") === "x"
  );
  const err = withTRouteAIRoutingHeaders(
    new Response('{"error":{"message":"no"}}', { status: 503 }),
    { requestedModel: "claude-opus-5-5", model: "claude-opus-5.5", provider: "kiro" }
  );
  check(
    "routing headers: an error answer gets them too",
    err.status === 503 &&
      err.headers.get("X-TRouteAI-Requested-Model") === "claude-opus-5-5" &&
      err.headers.get("X-TRouteAI-Model") === "claude-opus-5.5"
  );
}

// 3. The echo writes the client's string into every place a dialect names the model
{
  const start = echoModelInSseLine(
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5.5"}}',
    "claude-opus-5-5"
  );
  check(
    "echo: Anthropic message_start.message.model",
    JSON.parse(start.slice(6)).message.model === "claude-opus-5-5",
    start
  );
  const chunk = echoModelInSseLine('data: {"model":"claude-opus-5.5","choices":[]}', "a-b");
  const resp = echoModelInSseLine(
    'data: {"type":"response.created","response":{"model":"claude-opus-5.5"}}',
    "a-b"
  );
  check(
    "echo: OpenAI chunk model and Responses response.model",
    JSON.parse(chunk.slice(6)).model === "a-b" && JSON.parse(resp.slice(6)).response.model === "a-b"
  );
  const body = echoModelInObject(
    { type: "message", model: "claude-opus-5.5", content: [] },
    "claude-opus-5-5"
  ) as { model: string };
  check("echo: JSON body model", body.model === "claude-opus-5-5");
  const untouched = "event: message_start";
  check(
    "echo: event lines and [DONE] pass untouched",
    echoModelInSseLine(untouched, "x") === untouched &&
      echoModelInSseLine("data: [DONE]", "x") === "data: [DONE]"
  );
  // a frame split across two reads is still rewritten
  const enc = new TextEncoder();
  const ts = createModelEchoTransform("claude-opus-5-5");
  const w = ts.writable.getWriter();
  const frame =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5.5"}}\n\n';
  void w.write(enc.encode(frame.slice(0, 40)));
  void w.write(enc.encode(frame.slice(40)));
  void w.close();
  const out = await new Response(ts.readable).text();
  check(
    "echo: split frame rewritten",
    out.includes('"model":"claude-opus-5-5"') && !out.includes("5.5"),
    out
  );
}

// 4. A cache hit and an idempotent replay answer under the name this client sent, with headers
{
  const backend = "fake-backend-model";
  const messages = [{ role: "user", content: "repeatable question" }];
  const stored = { id: "chatcmpl-fake", object: "chat.completion", model: backend, choices: [] };
  setCachedResponse(generateSignature(backend, messages, 0, undefined, undefined), backend, stored);
  const hitFor = (asked: string) =>
    checkSemanticCache({
      semanticCacheEnabled: true,
      body: { model: backend, messages, temperature: 0 },
      clientRawRequest: { headers: {} },
      model: backend,
      provider: "fake-provider",
      stream: false,
      reqLogger: { logConvertedResponse: () => {} },
      effectiveServiceTier: null,
      connectionId: null,
      startTime: Date.now(),
      log: null,
      persistAttemptLogs: () => {},
      echoModel: asked,
      requestedModel: asked,
    });
  const first = await hitFor("client-name-a");
  const second = await hitFor("client-name-b");
  const a = first ? JSON.parse(await first.response.text()) : null;
  const b = second ? JSON.parse(await second.response.text()) : null;
  check(
    "cache hit: the body names the client's string, per client, the store is not changed",
    a?.model === "client-name-a" && b?.model === "client-name-b" && stored.model === backend,
    `${a?.model} ${b?.model} ${stored.model}`
  );
  check(
    "cache hit: headers name the requested and the answering model",
    first?.response.headers.get("X-TRouteAI-Requested-Model") === "client-name-a" &&
      first?.response.headers.get("X-TRouteAI-Model") === backend &&
      first?.response.headers.get("X-TRouteAI-Cache") === "HIT"
  );

  const rawKey = "fake-idempotency-key-1";
  const key = composeIdempotencyKey({
    rawKey,
    provider: "fake-provider",
    model: backend,
    messages,
  });
  saveIdempotency(key, { ...stored }, 200);
  const replay = await checkIdempotencyCache({
    clientRawRequest: { headers: { "idempotency-key": rawKey } },
    provider: "fake-provider",
    model: backend,
    body: { messages },
    effectiveServiceTier: null,
    startTime: Date.now(),
    log: null,
    echoModel: "client-name-a",
    requestedModel: "client-name-a",
  });
  const r = replay.hit ? JSON.parse(await replay.hit.response.text()) : null;
  check(
    "idempotent replay: the body and the headers name the client's string",
    r?.model === "client-name-a" &&
      replay.hit?.response.headers.get("X-TRouteAI-Requested-Model") === "client-name-a" &&
      replay.hit?.response.headers.get("X-TRouteAI-Model") === backend &&
      replay.hit?.response.headers.get("X-TRouteAI-Idempotent") === "true",
    JSON.stringify(r)
  );
}

// 5. The end-of-stream comment carries the requested model, the reasons and the attempts
{
  const comment = buildTRouteAISseMetadataComment({
    provider: "kiro",
    model: "claude-opus-4.8",
    requestedModel: "claude-opus-5-5",
    fallback: "refusal, combo-step",
    fallbackAttempts: 2,
  });
  check(
    "stream end comment: requested model, fallback and attempts in the SSE comment form",
    comment.includes(": x-trouteai-requested-model=claude-opus-5-5\n") &&
      comment.includes(": x-trouteai-model=claude-opus-4.8\n") &&
      comment.includes(": x-trouteai-fallback=refusal, combo-step\n") &&
      comment.includes(": x-trouteai-fallback-attempts=2\n"),
    comment.replace(/\n/g, " | ")
  );
}

// 6. /v1/responses: a bare name rewritten to codex/<name> is still reported as the client sent it
{
  const req = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.5", input: "hi" }),
  });
  const r = await withCodexPreferredModel(req);
  const raw = r.clientBody ? buildClientRawRequest(req, r.clientBody) : null;
  check(
    "responses: routed as codex/<name>, the client's own body keeps the name it sent",
    r.body?.model === "codex/gpt-5.5" &&
      r.clientBody?.model === "gpt-5.5" &&
      (raw?.body as { model?: string } | undefined)?.model === "gpt-5.5",
    `${r.body?.model} ${r.clientBody?.model}`
  );
  const plain = await withCodexPreferredModel(
    new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "am/some-model", input: "hi" }),
    })
  );
  check(
    "responses: a provider/model name is not rewritten and needs no separate body",
    plain.body?.model === "am/some-model" && plain.clientBody === undefined
  );
}

if (failed > 0) process.exitCode = 1;
