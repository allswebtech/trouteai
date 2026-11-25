// The Claude path against the published API reference, model by model: what leaves for each
// model on both Claude providers (`anthropic` API key, `claude` subscription). Requests go
// in-process through /v1/messages to a fake service (fetch is replaced). Every id, key and
// text is made up.
//   1. sampling parameters: none leaves for a model that refuses them;
//   2. thinking.display "updates": only with its beta and only on the models that take it;
//   3. thinking off and manual budgets: what each model accepts, and the request still answers;
//   4. a system turn inside `messages` stays there on the models that take it.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-claude-reference.mts
// API-key accounts go through a request queue (60 a minute by default); this check sends far
// more than that in a few seconds, so it switches the queue off for its own run.
process.env.RATE_LIMIT_AUTO_ENABLE = "false";
const { POST: messagesPost } = await import("../../src/app/api/v1/messages/route.ts");
const { POST: countPost } = await import("../../src/app/api/v1/messages/count_tokens/route.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");

const write = (line: string) => process.stdout.write(line + "\n");
for (const k of ["log", "info", "warn", "debug", "error"] as const) console[k] = () => {};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---- the fake service ---------------------------------------------------------------------------
type Sent = { url: string; headers: Record<string, string>; body: any };
let sent: Sent[] = [];
globalThis.fetch = (async (input: unknown, init: { headers?: any; body?: string } = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/\/v1\/messages/.test(url)) return new Response("{}", { status: 404 });
  const headers: Record<string, string> = {};
  new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
  const body = JSON.parse(String(init.body || "{}"));
  sent.push({ url, headers, body });
  if (url.includes("/count_tokens")) {
    return new Response('{"input_tokens":7}', { headers: { "content-type": "application/json" } });
  }
  return new Response(
    JSON.stringify({
      id: "msg_fake_1",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } }
  );
}) as never;

await createProviderConnection({
  provider: "anthropic",
  authType: "apikey",
  name: "api-key",
  apiKey: "sk-ant-api03-fake-reference",
  isActive: true,
});
await createProviderConnection({
  provider: "claude",
  authType: "oauth",
  name: "subscription",
  email: "reference@example.invalid",
  accessToken: "sk-ant-oat01-fake-reference",
  refreshToken: "sk-ant-ort01-fake-reference",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  providerSpecificData: {
    cliUserID: "e".repeat(64),
    accountUUID: "00000000-0000-4000-8000-0000000000ee",
  },
  isActive: true,
});

const CLAUDE_CODE = { "user-agent": "claude-cli/2.1.319 (external, cli)", "x-app": "cli" };
const USER = [{ role: "user", content: [{ type: "text", text: "Fix the failing test." }] }];
const PROVIDERS = ["anthropic", "claude"] as const;

async function send(
  provider: string,
  model: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  route: "messages" | "count" = "messages"
) {
  sent = [];
  const request = new Request(
    `http://localhost/v1/messages${route === "count" ? "/count_tokens" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...CLAUDE_CODE, ...headers },
      body: JSON.stringify({
        max_tokens: 1000,
        messages: USER,
        ...body,
        model: `${provider}/${model}`,
      }),
    }
  );
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000));
  const res = await Promise.race([
    route === "count" ? countPost(request) : messagesPost(request, {}),
    timeout,
  ]);
  if (!res) return { status: 0, up: null as Sent | null };
  await res.text().catch(() => "");
  return { status: res.status, up: sent[0] ?? null };
}

// ---- 1. sampling parameters -----------------------------------------------------------------------
// Removed (a 400 at any value) on Fable 5/5.1/5.2, Opus 5.5, Opus 5, Opus 4.8, Opus 4.7 and
// Sonnet 5; a 400 at any non-default value on Sonnet 5.5 and Haiku 5.5, where leaving them out
// is the default. Allowed on Opus 4.6, Sonnet 4.6 and Haiku 4.5.
{
  const REFUSE = [
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ];
  // Opus 4.6 is left out: an older rule (translator/paramSupport.ts) drops temperature for
  // every Opus 4 model, which fails no request.
  const ALLOW = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
  const SAMPLING = ["temperature", "top_p", "top_k"];
  for (const provider of PROVIDERS) {
    const leaks: string[] = [];
    for (const model of REFUSE) {
      // the client's own values, with thinking on, and the gateway's own defaults
      for (const [variant, body] of [
        ["client values", { temperature: 0.3, top_k: 5 }],
        [
          "client values, thinking on",
          { temperature: 0.3, top_p: 0.9, thinking: { type: "adaptive" } },
        ],
        ["nothing sent", {}],
      ] as const) {
        const { status, up } = await send(provider, model, body);
        const left = SAMPLING.filter((p) => up && p in up.body);
        if (status !== 200 || !up || left.length > 0) {
          leaks.push(`${model} [${variant}]: ${status} ${left.join("+")}`);
        }
      }
    }
    check(
      `sampling (${provider}): no temperature, top_p or top_k leaves for a model that refuses them`,
      leaks.length === 0,
      leaks.slice(0, 6).join(" | ")
    );
    const kept: string[] = [];
    for (const model of ALLOW) {
      const { up } = await send(provider, model, { temperature: 0.3 });
      // With thinking on (the subscription path turns it on for Claude Code) the service
      // requires temperature 1; otherwise the client's value goes through.
      const thinkingOn = ["adaptive", "enabled"].includes(up?.body?.thinking?.type);
      const want = thinkingOn ? 1 : 0.3;
      if (up?.body?.temperature !== want) kept.push(`${model}: ${up?.body?.temperature}`);
    }
    check(
      `sampling (${provider}): Sonnet 4.6 and Haiku 4.5 still get the client's temperature (1 when thinking is on)`,
      kept.length === 0,
      kept.join(" | ")
    );
  }
  const counted = await send("anthropic", "claude-opus-5-5", { temperature: 0.3 }, {}, "count");
  check(
    "sampling: a count for a model that refuses them carries no temperature",
    counted.status === 200 && !!counted.up && !("temperature" in counted.up.body),
    JSON.stringify(counted.up?.body?.temperature)
  );
}

// ---- 2. thinking.display "updates": its beta AND a model that takes it ----------------------------
// The reference lists "updates" on Fable 5/5.1/5.2 (Mythos 5.1/5.2), Opus 5.5 and Sonnet 5.5,
// behind thinking-display-updates-2026-08-18. Anywhere else it becomes "summarized".
{
  const TAKES = [
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
  ];
  const OTHERS = ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-5-5"];
  const BETA = "thinking-display-updates-2026-08-18";
  const body = { thinking: { type: "adaptive", display: "updates" } };
  for (const provider of PROVIDERS) {
    const wrong: string[] = [];
    for (const model of [...TAKES, ...OTHERS]) {
      for (const withBeta of [true, false]) {
        const { status, up } = await send(
          provider,
          model,
          body,
          withBeta ? { "anthropic-beta": BETA } : {}
        );
        const display = up?.body?.thinking?.display;
        const betaUp = String(up?.headers?.["anthropic-beta"] || "")
          .split(",")
          .includes(BETA);
        const want = withBeta && TAKES.includes(model) ? "updates" : "summarized";
        if (status !== 200 || display !== want || (display === "updates" && !betaUp)) {
          wrong.push(
            `${model}${withBeta ? " +beta" : ""}: ${status} ${display}${betaUp ? " (beta sent)" : ""}`
          );
        }
      }
    }
    check(
      `display (${provider}): "updates" leaves only with its beta and only for the models that take it`,
      wrong.length === 0,
      wrong.slice(0, 6).join(" | ")
    );
  }
}

// ---- 3. thinking off and manual budgets -----------------------------------------------------------
// Reference: `disabled` is a 400 on Fable 5/5.1/5.2 and Opus 5.5 (omit `thinking`, lower effort),
// a 400 on Sonnet 5.5 (send `between_tools`, no other field, effort high or below), accepted on
// Opus 5 and Haiku 5.5 only at effort high or below, accepted on Opus 4.8/4.7 and Sonnet 5.
// `between_tools` is Sonnet 5.5 only. A budget is a 400 on every adaptive-only model.
{
  type Want = { thinking: unknown; effort?: string };
  const OFF: Record<string, Want> = {
    "claude-fable-5": { thinking: undefined, effort: "low" },
    "claude-fable-5-1": { thinking: undefined, effort: "low" },
    "claude-fable-5-2": { thinking: undefined, effort: "low" },
    "claude-opus-5-5": { thinking: undefined, effort: "low" },
    "claude-sonnet-5-5": { thinking: { type: "between_tools" } },
    "claude-opus-5": { thinking: { type: "disabled" } },
    "claude-haiku-5-5": { thinking: { type: "disabled" } },
    "claude-opus-4-8": { thinking: { type: "disabled" } },
    "claude-sonnet-5": { thinking: { type: "disabled" } },
  };
  const OFF_XHIGH: Record<string, Want> = {
    "claude-opus-5-5": { thinking: undefined, effort: "low" },
    "claude-sonnet-5-5": { thinking: { type: "between_tools" }, effort: "high" },
    "claude-opus-5": { thinking: { type: "disabled" }, effort: "high" },
    "claude-haiku-5-5": { thinking: { type: "disabled" }, effort: "high" },
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const provider of PROVIDERS) {
    const wrong: string[] = [];
    const run = async (label: string, model: string, body: Record<string, unknown>, want: Want) => {
      const { status, up } = await send(provider, model, body);
      const got = { thinking: up?.body?.thinking, effort: up?.body?.output_config?.effort };
      const ok =
        status === 200 &&
        same(got.thinking, want.thinking) &&
        (want.effort === undefined || got.effort === want.effort);
      if (!ok) wrong.push(`${model} [${label}]: ${status} ${JSON.stringify(got)}`);
    };
    for (const [model, want] of Object.entries(OFF)) {
      await run("disabled", model, { thinking: { type: "disabled" } }, want);
    }
    for (const [model, want] of Object.entries(OFF_XHIGH)) {
      await run(
        "disabled, xhigh",
        model,
        { thinking: { type: "disabled" }, output_config: { effort: "xhigh" } },
        want
      );
    }
    // a client's between_tools on a model other than Sonnet 5.5 is that model's own "off"
    await run(
      "between_tools",
      "claude-opus-5-5",
      { thinking: { type: "between_tools" } },
      OFF["claude-opus-5-5"]
    );
    await run(
      "between_tools",
      "claude-opus-4-8",
      { thinking: { type: "between_tools" } },
      OFF["claude-opus-4-8"]
    );
    check(
      `thinking off (${provider}): each model gets the reference's way to turn thinking off, and answers`,
      wrong.length === 0,
      wrong.slice(0, 6).join(" | ")
    );
    const budget: string[] = [];
    for (const model of [
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-opus-4-7",
      "claude-sonnet-5",
    ]) {
      const { status, up } = await send(provider, model, {
        max_tokens: 4000,
        thinking: { type: "enabled", budget_tokens: 2048 },
      });
      const th = up?.body?.thinking;
      if (status !== 200 || th?.budget_tokens !== undefined || th?.type === "enabled") {
        budget.push(`${model}: ${status} ${JSON.stringify(th)}`);
      }
    }
    const old = await send(provider, "claude-sonnet-4-6", {
      max_tokens: 4000,
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    check(
      `thinking budget (${provider}): no budget leaves for an adaptive-only model; Sonnet 4.6 keeps its own`,
      budget.length === 0 && old.up?.body?.thinking?.budget_tokens === 2048,
      [...budget, `sonnet-4-6: ${JSON.stringify(old.up?.body?.thinking)}`].join(" | ")
    );
  }
}

// ---- 4. a system turn inside `messages` stays where the client put it ------------------------------
// The reference takes `role: "system"` inside `messages` on Opus 5, Opus 5.5, Opus 4.8, Fable 5,
// 5.1, 5.2, Mythos 5, 5.1, 5.2, Sonnet 5.5 and Haiku 5.5 (not Sonnet 5), with no beta header, so
// the cached prefix stays valid. Every other model gets it lifted into the top-level system.
{
  const TAKES = [
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-fable-5-2",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ];
  const LIFTS = ["claude-sonnet-5", "claude-opus-4-6", "claude-sonnet-4-6"];
  const turn = { role: "system", content: [{ type: "text", text: "Answer briefly from now on." }] };
  const conversation = [
    { role: "user", content: [{ type: "text", text: "Fix the failing test." }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
    { role: "user", content: [{ type: "text", text: "Now the next one." }] },
    turn,
  ];
  const system = [{ type: "text", text: "You are a coding agent." }];
  for (const provider of PROVIDERS) {
    for (const client of ["Claude Code", "plain"] as const) {
      const headers = client === "plain" ? { "user-agent": "fake-client/1.0", "x-app": "" } : {};
      const wrong: string[] = [];
      for (const model of [...TAKES, ...LIFTS]) {
        const { status, up } = await send(
          provider,
          model,
          { system, messages: conversation },
          headers
        );
        const msgs = up?.body?.messages || [];
        const sys = JSON.stringify(up?.body?.system || "");
        const inMessages = msgs.some((m: any) => m.role === "system");
        const keptAsSent = JSON.stringify(msgs[msgs.length - 1]) === JSON.stringify(turn);
        const lifted = !inMessages && sys.includes("Answer briefly from now on.");
        const ok =
          status === 200 &&
          (TAKES.includes(model) ? keptAsSent && !sys.includes("Answer briefly") : lifted);
        if (!ok)
          wrong.push(
            `${model}: ${status} ${inMessages ? "in messages" : "not in messages"}${lifted ? ", lifted" : ""}`
          );
      }
      check(
        `system turn (${provider}, ${client} client): kept in messages where the model takes it, lifted otherwise`,
        wrong.length === 0,
        wrong.slice(0, 6).join(" | ")
      );
    }
    // A system turn that breaks the placement rules (here: before the first user turn) and a
    // `developer` turn are still lifted, even on a model that takes system turns.
    const { status, up } = await send(provider, "claude-opus-5-5", {
      system,
      messages: [turn, { role: "developer", content: "Use tabs." }, ...conversation.slice(0, 3)],
    });
    const msgs = up?.body?.messages || [];
    check(
      `system turn (${provider}): a misplaced system turn and a developer turn are still lifted`,
      status === 200 &&
        !msgs.some((m: any) => m.role === "system" || m.role === "developer") &&
        JSON.stringify(up?.body?.system).includes("Use tabs."),
      `${status} ${msgs.map((m: any) => m.role).join(",")}`
    );
  }
}

write(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
