// How close TRouteAI's /v1/messages is to the Anthropic Messages API, for one model (made for
// Kiro models). kiro-mock.sh runs it against a fake Kiro (mock-kiro.mjs scripts the answers);
// it also works against a server with a real account. One line per check, exits 1 on a failure.
//   node anthropic-conformance.mjs <key-file> <base-url> <model>
// The key file holds the API key on its second line. ONLY=basic,errors runs single groups.
import { readFileSync } from "node:fs";
const [keyFile, base, model] = process.argv.slice(2);
const key = readFileSync(keyFile, "utf8").split("\n")[1].trim();
const H = {
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
};
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 260)})` : ""}`
  );
};
const post = async (body, headers = H, path = "/v1/messages") => {
  const t = Date.now();
  const res = await fetch(base + path, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json, ms: Date.now() - t };
};
const sse = (text) =>
  text
    .split("\n\n")
    .map((b) => {
      const ev = /^event: (.+)$/m.exec(b)?.[1];
      const data = /^data: (.+)$/m.exec(b)?.[1];
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {}
      return ev ? { ev, json } : null;
    })
    .filter(Boolean);
const user = (text) => [{ role: "user", content: text }];
const textOf = (j) =>
  (j?.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

const jobs = {
  async basic() {
    const r = await post({
      model,
      max_tokens: 100,
      messages: user("Reply with the single word: pong"),
    });
    const j = r.json || {};
    check(
      "basic: 200 and a message object",
      r.status === 200 && j.type === "message" && j.role === "assistant",
      `${r.status} ${r.text.slice(0, 120)}`
    );
    check("basic: id starts with msg_", /^msg_/.test(j.id || ""), j.id);
    check(
      "basic: model names the model that answered",
      typeof j.model === "string" && model.endsWith(j.model.replace(/^.*\//, "")),
      j.model
    );
    check(
      "basic: text content, stop_reason end_turn, stop_sequence null",
      /pong/i.test(textOf(j)) && j.stop_reason === "end_turn" && j.stop_sequence === null,
      JSON.stringify({ t: textOf(j), s: j.stop_reason, q: j.stop_sequence })
    );
    check(
      "basic: usage has input_tokens and output_tokens > 0",
      j.usage?.input_tokens > 0 && j.usage?.output_tokens > 0,
      JSON.stringify(j.usage)
    );
  },
  async stream() {
    const r = await post({
      model,
      max_tokens: 100,
      stream: true,
      messages: user("Count from 1 to 5, digits separated by spaces, nothing else."),
    });
    const ev = sse(r.text);
    const names = ev.map((e) => e.ev).filter((n) => n !== "ping");
    check(
      "stream: content-type text/event-stream",
      /text\/event-stream/.test(r.headers.get("content-type") || ""),
      r.headers.get("content-type")
    );
    check(
      "stream: starts message_start, ends message_delta + message_stop",
      names[0] === "message_start" &&
        names.at(-2) === "message_delta" &&
        names.at(-1) === "message_stop",
      names.join(",")
    );
    const starts = names.filter((n) => n === "content_block_start").length;
    check(
      "stream: every content block is started and stopped",
      starts > 0 && starts === names.filter((n) => n === "content_block_stop").length,
      names.join(",")
    );
    const ms = ev.find((e) => e.ev === "message_start")?.json?.message || {};
    check(
      "stream: message_start carries id, model, usage.input_tokens",
      /^msg_/.test(ms.id || "") &&
        typeof ms.model === "string" &&
        typeof ms.usage?.input_tokens === "number" &&
        typeof ms.usage?.cache_read_input_tokens === "number",
      JSON.stringify({ id: ms.id, model: ms.model, usage: ms.usage })
    );
    const md = ev.find((e) => e.ev === "message_delta")?.json || {};
    check(
      "stream: message_delta has stop_reason end_turn and usage.output_tokens",
      md.delta?.stop_reason === "end_turn" && md.usage?.output_tokens > 0,
      JSON.stringify(md)
    );
    const text = ev
      .filter((e) => e.json?.delta?.type === "text_delta")
      .map((e) => e.json.delta.text)
      .join("");
    check("stream: text arrives as text_delta", /1\s*2\s*3\s*4\s*5/.test(text), text);
  },
  async stopSequence() {
    const r = await post({
      model,
      max_tokens: 200,
      stop_sequences: ["STOPHERE"],
      messages: user("Write exactly this line and nothing else: alpha beta STOPHERE gamma delta"),
    });
    const j = r.json || {};
    check(
      "stop_sequences: output ends before the stop text",
      r.status === 200 && /alpha beta/.test(textOf(j)) && !/STOPHERE|gamma/.test(textOf(j)),
      textOf(j)
    );
    check(
      "stop_sequences: stop_reason stop_sequence + stop_sequence value",
      j.stop_reason === "stop_sequence" && j.stop_sequence === "STOPHERE",
      JSON.stringify({ s: j.stop_reason, q: j.stop_sequence })
    );
    const s = await post({
      model,
      max_tokens: 200,
      stream: true,
      stop_sequences: ["STOPHERE"],
      messages: user("Write exactly this line and nothing else: alpha beta STOPHERE gamma delta"),
    });
    const ev = sse(s.text);
    const text = ev
      .filter((e) => e.json?.delta?.type === "text_delta")
      .map((e) => e.json.delta.text)
      .join("");
    const md = ev.find((e) => e.ev === "message_delta")?.json?.delta || {};
    check(
      "stop_sequences (stream): cut before the stop text, stop_reason stop_sequence",
      /alpha beta/.test(text) &&
        !/STOPHERE|gamma/.test(text) &&
        md.stop_reason === "stop_sequence" &&
        md.stop_sequence === "STOPHERE",
      JSON.stringify({ text, md })
    );
  },
  async maxTokens() {
    const r = await post({
      model,
      max_tokens: 20,
      messages: user("Write the numbers from 1 to 300 separated by spaces."),
    });
    const j = r.json || {};
    check(
      "max_tokens 20: stop_reason max_tokens and a short answer",
      j.stop_reason === "max_tokens" && j.usage?.output_tokens <= 30,
      JSON.stringify({ s: j.stop_reason, out: j.usage?.output_tokens, len: textOf(j).length })
    );
  },
  async tools() {
    const tools = [
      {
        name: "get_weather",
        description: "Get the weather for a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
    const r = await post({
      model,
      max_tokens: 300,
      tools,
      tool_choice: { type: "any" },
      messages: user("What is the weather in Paris? Use the tool."),
    });
    const j = r.json || {};
    const tu = (j.content || []).find((c) => c.type === "tool_use");
    check(
      "tools: tool_use block, stop_reason tool_use",
      !!tu &&
        tu.name === "get_weather" &&
        /paris/i.test(JSON.stringify(tu.input)) &&
        j.stop_reason === "tool_use",
      JSON.stringify({ c: j.content, s: j.stop_reason })
    );
    check("tools: tool_use id starts with toolu_", /^toolu_/.test(tu?.id || ""), tu?.id);
    if (tu) {
      const r2 = await post({
        model,
        max_tokens: 300,
        tools,
        messages: [
          ...user("What is the weather in Paris? Use the tool."),
          { role: "assistant", content: j.content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: tu.id, content: "Sunny, 21 degrees" }],
          },
        ],
      });
      check(
        "tools: tool_result round trip answers with the result",
        r2.status === 200 && /21|sunny/i.test(textOf(r2.json)),
        `${r2.status} ${textOf(r2.json)}`
      );
    }
  },
  async thinking() {
    const r = await post({
      model,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      messages: user("Think it through: what is 17 * 23? Answer with the number only."),
    });
    const j = r.json || {};
    const th = (j.content || []).find((c) => c.type === "thinking");
    check("thinking: answer 391", /391/.test(textOf(j)), textOf(j));
    check(
      "thinking: a thinking block comes first, with a signature",
      !!th &&
        j.content[0].type === "thinking" &&
        typeof th.signature === "string" &&
        th.signature.length > 20,
      JSON.stringify(
        (j.content || []).map((c) => ({
          type: c.type,
          sig: (c.signature || "").length,
          len: (c.thinking || c.text || "").length,
        }))
      )
    );
    if (th) {
      const r2 = await post({
        model,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [
          ...user("Think it through: what is 17 * 23? Answer with the number only."),
          { role: "assistant", content: j.content },
          { role: "user", content: "Now add 9 to it. Number only." },
        ],
      });
      check(
        "thinking: next turn with the thinking block sent back works",
        r2.status === 200 && /400/.test(textOf(r2.json)),
        `${r2.status} ${textOf(r2.json) || r2.text.slice(0, 200)}`
      );
    }
  },
  // Claude Code's case: streaming, thinking, a tool call, then the tool result with the signed
  // thinking block sent back (the open tool-use cycle the real API keeps the thinking for).
  async thinkingStreamTools() {
    const tools = [
      {
        name: "get_time",
        description: "Current time in a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
    const ask = user("Think first, then use the tool to get the time in Tokyo.");
    const r = await post({
      model,
      max_tokens: 4000,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools,
      messages: ask,
    });
    const evs = sse(r.text);
    const blocks = [];
    for (const { ev, json } of evs) {
      if (ev === "content_block_start")
        blocks[json.index] = {
          ...json.content_block,
          signature: json.content_block.signature || "",
          thinking: json.content_block.thinking || "",
          partial: "",
        };
      if (ev === "content_block_delta") {
        const b = blocks[json.index];
        if (json.delta.type === "thinking_delta") b.thinking += json.delta.thinking;
        if (json.delta.type === "signature_delta") b.signature += json.delta.signature;
        if (json.delta.type === "input_json_delta") b.partial += json.delta.partial_json;
      }
    }
    const th = blocks.find((b) => b?.type === "thinking");
    const tu = blocks.find((b) => b?.type === "tool_use");
    check(
      "stream thinking: signature_delta closes the thinking block",
      !!th && th.signature.length > 20,
      JSON.stringify(blocks.map((b) => b && { t: b.type, sig: b.signature?.length || 0 }))
    );
    if (!th || !tu)
      return check(
        "stream thinking: tool_use block",
        false,
        JSON.stringify(blocks.map((b) => b?.type))
      );
    const content = blocks
      .map((b) =>
        b.type === "thinking"
          ? { type: "thinking", thinking: b.thinking, signature: b.signature }
          : b.type === "tool_use"
            ? { type: "tool_use", id: b.id, name: b.name, input: JSON.parse(b.partial || "{}") }
            : { type: "text", text: b.text || "" }
      )
      .filter((c) => c.type !== "text" || c.text);
    const r2 = await post({
      model,
      max_tokens: 4000,
      stream: false,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools,
      messages: [
        ...ask,
        { role: "assistant", content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "09:41" }] },
      ],
    });
    check(
      "stream thinking: tool_result turn with the signed thinking sent back answers",
      r2.status === 200 && /9:41|09:41/.test(textOf(r2.json)),
      `${r2.status} ${textOf(r2.json) || r2.text.slice(0, 200)}`
    );
    const bad = content.map((c) =>
      c.type === "thinking" ? { ...c, signature: c.signature.slice(0, -6) + "AAAAAA" } : c
    );
    const r3 = await post({
      model,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools,
      messages: [
        ...ask,
        { role: "assistant", content: bad },
        { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "09:41" }] },
      ],
    });
    check(
      "stream thinking: a broken signature still gets an answer (sent again without it)",
      r3.status === 200 && /9:41|09:41/.test(textOf(r3.json)),
      `${r3.status} ${textOf(r3.json) || r3.text.slice(0, 200)}`
    );
  },
  async system() {
    const r = await post({
      model,
      max_tokens: 100,
      system: [
        {
          type: "text",
          text: "You always answer in upper case.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Say: hello world", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });
    check(
      "system blocks + cache_control accepted and followed",
      r.status === 200 && /HELLO WORLD/.test(textOf(r.json)),
      `${r.status} ${textOf(r.json)}`
    );
    check(
      "usage reports cache fields as numbers",
      typeof r.json?.usage?.cache_read_input_tokens === "number" &&
        typeof r.json?.usage?.cache_creation_input_tokens === "number",
      JSON.stringify(r.json?.usage)
    );
  },
  async prefill() {
    const r = await post({
      model,
      max_tokens: 100,
      messages: [
        ...user("Name one primary colour, lower case, one word."),
        { role: "assistant", content: "The colour is" },
      ],
    });
    check(
      "assistant prefill: the answer continues it (no repeat of the prefill)",
      r.status === 200 &&
        !/^\s*The colour is/i.test(textOf(r.json)) &&
        /red|blue|yellow|green/i.test(textOf(r.json)),
      `${r.status} ${JSON.stringify(textOf(r.json))} ${r.json ? "" : r.text.slice(0, 160)}`
    );
  },
  async countTokens() {
    const r = await post(
      { model, messages: user("Hello there, how are you today?") },
      H,
      "/v1/messages/count_tokens"
    );
    check(
      "count_tokens: 200 with input_tokens",
      r.status === 200 && r.json?.input_tokens > 0,
      `${r.status} ${r.text.slice(0, 160)}`
    );
  },
  async errors() {
    const shape = (r, type) =>
      r.json?.type === "error" &&
      r.json?.error?.type === type &&
      typeof r.json?.error?.message === "string";
    const a = await post(
      { model, max_tokens: 10, messages: user("hi") },
      { ...H, "x-api-key": "sk-wrong" }
    );
    check(
      "wrong key: 401 authentication_error in Anthropic's error shape",
      a.status === 401 && shape(a, "authentication_error"),
      `${a.status} ${a.text.slice(0, 200)}`
    );
    const b = await post({ model, max_tokens: 10 });
    check(
      "missing messages: 400 invalid_request_error",
      b.status === 400 && shape(b, "invalid_request_error"),
      `${b.status} ${b.text.slice(0, 200)}`
    );
    const c = await post("{not json");
    check(
      "broken JSON: 400 invalid_request_error",
      c.status === 400 && shape(c, "invalid_request_error"),
      `${c.status} ${c.text.slice(0, 200)}`
    );
    const d = await post({ model: "no-such-model-xyz", max_tokens: 10, messages: user("hi") });
    check(
      "unknown model: 404 not_found_error",
      d.status === 404 && shape(d, "not_found_error"),
      `${d.status} ${d.text.slice(0, 200)}`
    );
  },
};
const only = (process.env.ONLY || "").split(",").filter(Boolean);
await Promise.all(
  Object.entries(jobs)
    .filter(([n]) => !only.length || only.includes(n))
    .map(([n, f]) => f().catch((e) => check(`${n}: ran`, false, e.message)))
);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
