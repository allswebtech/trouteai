// What each chat row of GET /v1/models tells a client (no network, temporary DATA_DIR):
// supported_parameters names tools only where the model calls tools and reasoning only where
// it thinks, max_input_tokens mirrors a known context length, and no limit is invented.
// Every model of the built-in registry is run through the same steps the route runs.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-models-catalog.mts
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.ts";
import {
  enrichCatalogModelEntry,
  getCanonicalModelMetadata,
} from "../../src/lib/modelMetadataRegistry.ts";
import { completeCatalogRow } from "../../src/app/api/v1/models/catalogRowFields.ts";
import { finalizeCatalogResponse } from "../../src/app/api/v1/models/catalogResponse.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
type Row = Record<string, any>;
const params = (row: Row): string[] =>
  Array.isArray(row.supported_parameters) ? row.supported_parameters : [];

// ── one row at a time ───────────────────────────────────────────────────────────────────
const tools = completeCatalogRow({ id: "p/a", capabilities: { tool_calling: true } });
check(
  "a tool-calling model lists tools and tool_choice",
  params(tools).includes("tools") && params(tools).includes("tool_choice")
);
const noTools = completeCatalogRow({ id: "p/b", capabilities: { tool_calling: false } });
check("a model without tool calling does not list tools", !params(noTools).includes("tools"));
const thinking = completeCatalogRow({ id: "p/c", capabilities: { reasoning: true } });
check("a thinking model lists reasoning", params(thinking).includes("reasoning"));
const plain = completeCatalogRow({ id: "p/d" });
check(
  "a row with no capabilities lists only max_tokens",
  JSON.stringify(params(plain)) === JSON.stringify(["max_tokens"]),
  JSON.stringify(params(plain))
);
const sized = completeCatalogRow({ id: "p/e", context_length: 200000 });
check("max_input_tokens mirrors a known context length", sized.max_input_tokens === 200000);
check("a missing output limit is not invented", !("max_output_tokens" in sized));
const ownInput = completeCatalogRow({
  id: "p/f",
  context_length: 400000,
  max_input_tokens: 272000,
});
check("a row's own input limit is kept", ownInput.max_input_tokens === 272000);
const unsized = completeCatalogRow({ id: "p/g" });
check("no context length, no input limit", !("max_input_tokens" in unsized));
const own = completeCatalogRow({ id: "p/h", supported_parameters: ["tools"] });
check(
  "a row's own supported_parameters are kept",
  JSON.stringify(own.supported_parameters) === '["tools"]'
);
const embed = completeCatalogRow({ id: "p/i", type: "embedding", context_length: 8192 });
check(
  "rows that are not chat models are left alone",
  !("supported_parameters" in embed) && !("max_input_tokens" in embed)
);

// ── through the route's last step ───────────────────────────────────────────────────────
const res = finalizeCatalogResponse(
  new Request("http://127.0.0.1/v1/models"),
  [
    {
      id: "fake/claude-opus-mock",
      object: "model",
      created: 1,
      owned_by: "fake",
      root: "claude-opus-mock",
      context_length: 200000,
      capabilities: { tool_calling: true },
    },
    {
      id: "fake-combo",
      object: "model",
      created: 1,
      owned_by: "combo",
      context_length: 128000,
      max_output_tokens: 8192,
      capabilities: { tool_calling: true, reasoning: true },
    },
  ],
  () => undefined,
  {}
);
const body = (await res.json()) as { data: Row[] };
const [modelRow, comboRow] = body.data;
check(
  "the response carries the completed fields for a model row",
  modelRow?.max_input_tokens === 200000 && params(modelRow).includes("tools"),
  JSON.stringify(modelRow)
);
check(
  "the response carries the completed fields for a combo row",
  comboRow?.max_input_tokens === 128000 &&
    params(comboRow).includes("tools") &&
    params(comboRow).includes("reasoning"),
  JSON.stringify(comboRow)
);

// ── every model of the registry ─────────────────────────────────────────────────────────
let total = 0;
const wrong: string[] = [];
const noContext: Record<string, string[]> = {};
const noOutput: Record<string, string[]> = {};
for (const [alias, models] of Object.entries(PROVIDER_MODELS as Record<string, Row[]>)) {
  for (const model of models) {
    total++;
    const id = `${alias}/${model.id}`;
    const row: Row = completeCatalogRow(
      enrichCatalogModelEntry({ id, object: "model", created: 1, owned_by: alias, root: model.id })
    );
    const p = params(row);
    if (!p.includes("max_tokens")) wrong.push(`${id}: no supported_parameters`);
    if (row.capabilities?.tool_calling === true && !p.includes("tools"))
      wrong.push(`${id}: tools missing`);
    if (row.capabilities?.tool_calling === false && p.includes("tools"))
      wrong.push(`${id}: tools listed`);
    if (row.capabilities?.reasoning === true && !p.includes("reasoning"))
      wrong.push(`${id}: reasoning missing`);
    if (
      typeof model.contextLength === "number" &&
      row.context_length !== model.contextLength &&
      typeof row.context_length !== "number"
    )
      wrong.push(`${id}: registry context length lost`);
    if (typeof model.maxOutputTokens === "number" && typeof row.max_output_tokens !== "number")
      wrong.push(`${id}: registry output limit lost`);
    if (typeof row.context_length === "number" && typeof row.max_input_tokens !== "number")
      wrong.push(`${id}: no input limit beside a context length`);
    if (typeof row.context_length !== "number") (noContext[alias] ||= []).push(model.id);
    if (typeof row.max_output_tokens !== "number") (noOutput[alias] ||= []).push(model.id);
  }
}
check(
  `every registry model row is complete (${total} models)`,
  wrong.length === 0,
  wrong.slice(0, 5).join("; ")
);

// ── Claude and Kiro: every row complete and true ────────────────────────────────────────
// Numbers: Anthropic's model table for Claude (also for Claude served by Kiro); models.dev's
// Amazon Bedrock entries for Kiro's other models; Kiro's changelog for GPT-5.6 (1M).
// A row passes when it has a context length, an input limit, an output limit, and the model's
// own (not guessed) answers for tools, thinking and vision.
type Expected = [number, number, boolean, boolean, boolean]; // context, output, tools, thinking, vision
const M1: Expected = [1000000, 128000, true, true, true];
const K200: Expected = [200000, 64000, true, true, true];
const CLAUDE_TABLE: Record<string, Expected> = {
  "claude-fable-5-2": M1,
  "claude-fable-5-1": M1,
  "claude-fable-5": M1,
  "claude-opus-5-5": M1,
  "claude-opus-5": M1,
  "claude-opus-4-8": M1,
  "claude-opus-4-7": M1,
  "claude-opus-4-6": M1,
  "claude-sonnet-5-5": M1,
  "claude-sonnet-5": M1,
  "claude-sonnet-4-6": M1,
  "claude-haiku-5-5": M1,
  "claude-opus-4-5": K200,
  "claude-sonnet-4-5": K200,
  "claude-haiku-4-5": K200,
};
// The registries spell one model three ways: claude-opus-4-5-20251101, claude-opus-4.5, claude-opus-4-5.
const claudeKey = (id: string) => id.replace(/-\d{8}$/, "").replace(/(\d)\.(\d)/g, "$1-$2");
const KIRO_OTHER: Record<string, Expected> = {
  "deepseek-3.2": [163840, 81920, true, true, false],
  "minimax-m2.5": [196608, 98304, true, true, false],
  "minimax-m2.1": [196608, 131072, true, true, false],
  "glm-5": [202752, 131072, true, true, false],
  "qwen3-coder-next": [262144, 65536, true, false, false],
  "gpt-5.6-sol": M1,
  "gpt-5.6-terra": M1,
  "gpt-5.6-luna": M1,
};
const expectedFor = (alias: string, id: string): Expected | undefined =>
  CLAUDE_TABLE[claudeKey(id)] ?? (alias === "kr" ? KIRO_OTHER[id] : undefined);

const rowGaps = (alias: string, modelId: string, row: Row): string[] => {
  const id = `${alias}/${modelId}`;
  const gaps: string[] = [];
  const expected = expectedFor(alias, modelId);
  if (!expected) return [`${id}: not in the source table of this check`];
  const [context, output, tools, thinking, vision] = expected;
  const meta = getCanonicalModelMetadata({ provider: alias, model: modelId });
  if (row.context_length !== context) gaps.push(`${id}: context ${row.context_length}`);
  if (row.max_input_tokens !== context) gaps.push(`${id}: input ${row.max_input_tokens}`);
  if (row.max_output_tokens !== output) gaps.push(`${id}: output ${row.max_output_tokens}`);
  if (meta?.capabilities.supportsTools !== tools)
    gaps.push(`${id}: tools ${meta?.capabilities.supportsTools}`);
  if (row.capabilities?.supportsThinking !== thinking)
    gaps.push(`${id}: thinking ${row.capabilities?.supportsThinking}`);
  if (row.capabilities?.vision !== vision) gaps.push(`${id}: vision ${row.capabilities?.vision}`);
  if (tools && !params(row).includes("tools"))
    gaps.push(`${id}: tools not in supported_parameters`);
  if (thinking !== params(row).includes("reasoning"))
    gaps.push(`${id}: reasoning in supported_parameters is ${!thinking}`);
  return gaps;
};

const staticGaps: string[] = [];
let staticCount = 0;
for (const alias of ["cc", "anthropic", "kr"]) {
  for (const model of (PROVIDER_MODELS as Record<string, Row[]>)[alias] || []) {
    staticCount++;
    const row = completeCatalogRow(
      enrichCatalogModelEntry({
        id: `${alias}/${model.id}`,
        object: "model",
        created: 1,
        owned_by: alias,
        root: model.id,
      })
    );
    staticGaps.push(...rowGaps(alias, model.id, row));
  }
}
check(
  `every Claude and Kiro registry model has its true limits and capabilities (${staticCount} models)`,
  staticCount > 30 && staticGaps.length === 0,
  staticGaps.slice(0, 6).join("; ")
);

// Kiro's live model list names its Claude models with dots (claude-opus-5.5). Such a row carries
// Kiro's own numbers when Kiro sends them; the metadata must agree and fill the capabilities.
const KIRO_LIVE_CLAUDE = [
  "claude-opus-5.5",
  "claude-sonnet-5.5",
  "claude-haiku-5.5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
];
const liveGaps: string[] = [];
for (const modelId of KIRO_LIVE_CLAUDE) {
  const [context, output] = CLAUDE_TABLE[claudeKey(modelId)];
  for (const sent of [{}, { context_length: context, max_output_tokens: output }]) {
    const row = completeCatalogRow(
      enrichCatalogModelEntry({
        id: `kr/${modelId}`,
        object: "model",
        created: 1,
        owned_by: "kr",
        root: modelId,
        ...sent,
      })
    );
    liveGaps.push(...rowGaps("kr", modelId, row));
  }
}
check(
  `every Claude model of Kiro's live list has its true limits and capabilities (${KIRO_LIVE_CLAUDE.length} models)`,
  liveGaps.length === 0,
  liveGaps.slice(0, 6).join("; ")
);

const count = (m: Record<string, string[]>) => Object.values(m).reduce((n, l) => n + l.length, 0);
console.log(
  `INFO  registry models with no known context length: ${count(noContext)} of ${total}; with no known output limit: ${count(noOutput)} of ${total}`
);
if (process.env.MODELS_CATALOG_LIST_MISSING) {
  for (const [alias, list] of Object.entries(noContext))
    console.log(`NO-CONTEXT  ${alias}: ${list.join(", ")}`);
  for (const [alias, list] of Object.entries(noOutput))
    console.log(`NO-OUTPUT  ${alias}: ${list.join(", ")}`);
}
process.exit(failed ? 1 : 0);
