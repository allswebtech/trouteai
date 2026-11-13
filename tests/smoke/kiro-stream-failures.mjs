// Kiro answers that fail inside the stream, through the whole TRouteAI server against the fake
// Kiro (mock-kiro.mjs failure markers): the client must get an error it retries, never a
// cut-off answer marked complete. Run by kiro-mock.sh after the conformance checks.
// Usage: node kiro-stream-failures.mjs <key-file> <base-url> [model]
import { readFileSync } from "node:fs";

const [keyFile, base, model = "kiro/claude-sonnet-5"] = process.argv.slice(2);
const key = readFileSync(keyFile, "utf8").trim().split("\n").pop();
const run = Date.now().toString(36);
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function claude(marker, stream = true) {
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      stream,
      messages: [{ role: "user", content: `Answer please. ${marker}` }],
    }),
  });
  const raw = await r.text();
  if (!stream) {
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    return { status: r.status, json, raw };
  }
  const events = [];
  let ev = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) ev = line.slice(7).trim();
    else if (line.startsWith("data: ")) {
      try {
        events.push({ event: ev, data: JSON.parse(line.slice(6)) });
      } catch {}
    }
  }
  const text = events
    .filter((e) => e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  const stopReason =
    events.find((e) => e.data?.type === "message_delta")?.data?.delta?.stop_reason ?? null;
  const errors = events
    .filter((e) => e.event === "error" || e.data?.type === "error")
    .map((e) => e.data.error);
  return {
    status: r.status,
    events,
    text,
    stopReason,
    errors,
    last: events[events.length - 1]?.data?.type,
  };
}

// 0. (first, before the failure checks put accounts on short cooldowns) A combo that names each Kiro account as its own step: one account at its monthly limit
// (402) must not end the request; the next account answers.
{
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "kiro-accounts",
        max_tokens: 50,
        messages: [{ role: "user", content: `pong ${i}` }],
      }),
    });
    const j = await r.json().catch(() => null);
    statuses.push(`${r.status}:${(j?.content || []).map((b) => b.text).join("")}`);
  }
  check(
    "combo of pinned accounts, first at its monthly limit (402): every request answered by the next account",
    statuses.every((s) => s === "200:pong"),
    statuses.join(" ")
  );
}
// 1. Exception after content (Claude stream)
{
  const m = `MOCK-MIDSTREAM-EXCEPTION-s${run}`;
  const a = await claude(m);
  check(
    "Claude stream, exception after content: text, then event: error (api_error), then message_stop; no stop_reason",
    a.status === 200 &&
      a.text === "Half an answer" &&
      a.errors.length === 1 &&
      a.errors[0]?.type === "api_error" &&
      /high load/.test(a.errors[0]?.message || "") &&
      a.stopReason === null &&
      a.last === "message_stop",
    JSON.stringify({ text: a.text, errors: a.errors, stop: a.stopReason, last: a.last })
  );
  const b = await claude(m);
  check(
    "the client's retry gets the full answer (end_turn)",
    b.text === "RETRY-OK" && b.stopReason === "end_turn",
    JSON.stringify({ text: b.text, stop: b.stopReason })
  );
}
// 2. Answer cut off before Kiro's closing frames (Claude stream)
{
  const a = await claude(`MOCK-CUTOFF-s${run}`);
  check(
    "Claude stream, cut off: thinking + text, then event: error 'before it was complete', no stop_reason",
    a.status === 200 &&
      a.text === "Half an answer" &&
      a.errors.length === 1 &&
      /before it was complete/.test(a.errors[0]?.message || "") &&
      a.stopReason === null &&
      a.last === "message_stop",
    JSON.stringify({ text: a.text, errors: a.errors, stop: a.stopReason })
  );
}
// 3. Exception before any content: TRouteAI itself asks again (the client sees one good answer)
{
  const a = await claude(`MOCK-EXCEPTION-FIRST-s${run}`);
  check(
    "exception before content: the server retries, the client gets RETRY-OK (200, end_turn), no error event",
    a.status === 200 &&
      a.text === "RETRY-OK" &&
      a.stopReason === "end_turn" &&
      a.errors.length === 0,
    JSON.stringify({ status: a.status, text: a.text, errors: a.errors })
  );
}
// 4. Non-streaming: never half an answer marked complete
{
  const a = await claude(`MOCK-MIDSTREAM-EXCEPTION-n${run}`, false);
  const text = (a.json?.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  check(
    "non-stream, exception after content: an error or the retried full answer, not 'Half an answer'",
    (a.status >= 500 && a.json?.type === "error") || (a.status === 200 && text === "RETRY-OK"),
    `${a.status} ${a.raw.slice(0, 160)}`
  );
}
// 5. OpenAI chat client, cut off: a finish_reason "error" chunk with the error, then [DONE]
{
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: `Answer please. MOCK-CUTOFF-o${run}` }],
    }),
  });
  const raw = await r.text();
  const chunks = raw
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)));
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
  const errChunk = chunks.find((c) => c.error);
  const finishes = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean);
  check(
    "OpenAI stream, cut off: text, then finish_reason error + error, then [DONE]; no 'stop'",
    r.status === 200 &&
      text === "Half an answer" &&
      errChunk?.choices?.[0]?.finish_reason === "error" &&
      /before it was complete/.test(errChunk?.error?.message || "") &&
      !finishes.includes("stop") &&
      raw.trimEnd().endsWith("data: [DONE]"),
    JSON.stringify({ text, finishes, err: errChunk?.error })
  );
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
