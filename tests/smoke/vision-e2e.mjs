// Images through the whole TRouteAI server against the fake Kiro (mock-kiro.mjs): a model that
// sees gets the image bytes (checked on what reached the fake Kiro), a model that cannot see
// answers 400 naming the model and the images, in the Anthropic and the OpenAI dialect, also
// through combos. The vision bridge is switched off per request so nothing leaves the machine.
// Usage: node vision-e2e.mjs <key-file> <base-url> <mock-kiro-url>
import { readFileSync } from "node:fs";

const [keyFile, base, mockUrl] = process.argv.slice(2);
const apiKey = readFileSync(keyFile, "utf8").split("\n")[1].trim();
// A 1x1 PNG; these bytes must arrive at the fake Kiro unchanged.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function send(dialect, model, image) {
  const anthropic = dialect === "anthropic";
  const imagePart = anthropic
    ? image.startsWith("data:")
      ? { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }
      : { type: "image", source: { type: "url", url: image } }
    : { type: "image_url", image_url: { url: image } };
  const res = await fetch(base + (anthropic ? "/v1/messages" : "/v1/chat/completions"), {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "content-type": "application/json",
      "x-trouteai-disabled-guardrails": "vision-bridge",
      ...(anthropic
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "What is in this picture?" }, imagePart] },
      ],
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
const received = async () => (await fetch(mockUrl + "/__received")).json();
const answerText = (json) =>
  json?.content?.map?.((b) => b.text || "").join("") || json?.choices?.[0]?.message?.content || "";
const errorMessage = (json) => json?.error?.message || "";
const DATA_URL = `data:image/png;base64,${PNG}`;

// 1. Models that see: the bytes reach Kiro.
for (const [dialect, model] of [
  ["anthropic", "kiro/claude-sonnet-5"],
  ["openai", "kiro/claude-sonnet-5"],
  ["anthropic", "kiro/gpt-5.6-sol"],
  ["openai", "kiro/gpt-5.6-sol"],
]) {
  const before = (await received()).length;
  const r = await send(dialect, model, DATA_URL);
  const got = (await received()).slice(before);
  const img = got[0]?.images?.[0];
  check(
    `${dialect} ${model}: 200 and the image bytes reach Kiro`,
    r.status === 200 &&
      got.length === 1 &&
      img?.source?.bytes === PNG &&
      img?.format === "png" &&
      /I see 1 image/.test(answerText(r.json)),
    `status ${r.status} sent ${got.length} ${r.text.slice(0, 120)}`
  );
}

// 2. Models that cannot see: 400 in the client's dialect, naming the model and the images.
for (const [dialect, model] of [
  ["anthropic", "kiro/deepseek-3.2"],
  ["openai", "kiro/glm-5"],
]) {
  const before = (await received()).length;
  const r = await send(dialect, model, DATA_URL);
  const msg = errorMessage(r.json);
  const shapeOk =
    dialect === "anthropic"
      ? r.json?.type === "error" && r.json?.error?.type === "invalid_request_error"
      : !!r.json?.error;
  check(
    `${dialect} ${model} (text-only): 400 naming the model and images, nothing sent`,
    r.status === 400 &&
      shapeOk &&
      msg.includes(model.split("/")[1]) &&
      /images/.test(msg) &&
      (await received()).length === before,
    `status ${r.status} ${r.text.slice(0, 160)}`
  );
}

// 3. A combo whose first step cannot see: served by the seeing step, the blind one never called.
for (const dialect of ["anthropic", "openai"]) {
  const before = (await received()).length;
  const r = await send(dialect, "vision-mixed", DATA_URL);
  const got = (await received()).slice(before);
  check(
    `${dialect} mixed combo: the seeing step answers with the image, the text-only one is skipped`,
    r.status === 200 &&
      got.length === 1 &&
      got[0].modelId === "claude-sonnet-5" &&
      got[0].images?.[0]?.source?.bytes === PNG,
    `status ${r.status} models ${got.map((g) => g.modelId).join(",")}`
  );
}

// 4. A combo with no step that sees: 400 naming its models.
{
  const r = await send("anthropic", "vision-blind", DATA_URL);
  const msg = errorMessage(r.json);
  check(
    "combo of text-only models: 400 naming its models and images",
    r.status === 400 && msg.includes("deepseek-3.2") && msg.includes("glm-5") && /images/.test(msg),
    `status ${r.status} ${msg.slice(0, 200)}`
  );
}

// 5. An image URL Kiro cannot be given: a named error, never an answer without the image.
for (const dialect of ["anthropic", "openai"]) {
  const before = (await received()).length;
  const r = await send(dialect, "kiro/claude-sonnet-5", "http://127.0.0.1:9/private.png");
  check(
    `${dialect} image URL on a private address: 400 that says so, nothing sent`,
    r.status === 400 &&
      /image URL/i.test(errorMessage(r.json)) &&
      (await received()).length === before,
    `status ${r.status} ${r.text.slice(0, 160)}`
  );
}

process.exit(failed > 0 ? 1 : 0);
