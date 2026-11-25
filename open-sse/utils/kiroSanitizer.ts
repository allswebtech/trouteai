/**
 * Kiro tool-schema sanitizer.
 *
 * Kiro / AWS CodeWhisperer rejects requests with HTTP 400 "Improperly formed
 * request" when a tool's `inputSchema.json` contains JSON-Schema keywords it
 * does not understand (`additionalProperties`, `anyOf`/`oneOf`/`allOf`/`not`,
 * `$ref`/`$defs`/`definitions`, `if`/`then`/`else`, etc.) or an empty
 * `required` array. It also rejects tool names longer than 64 characters.
 *
 * This pure helper flattens a root `oneOf`/`anyOf`/`allOf` into one object schema (stripping
 * the union whole would leave the tool without parameters), strips the unsupported keys
 * recursively without touching property NAMES (a property called `if` or `$ref` is data, not a
 * keyword), keeps the root an object whose `required` names only declared properties, and
 * hash-truncates over-long names, returning a `nameMap` (truncated → original) so the streamed
 * tool-call name can be mapped back for the client. See chatCore.ts (request wiring) and
 * translator/response/kiro-to-openai.ts (response reverse-mapping).
 */
import { createHash } from "node:crypto";

/** Max tool-name length Kiro accepts before it rejects the request. */
const MAX_TOOL_NAME_LENGTH = 64;

/** JSON-Schema keywords Kiro rejects anywhere in a tool schema. */
const STRIP_KEYS = new Set<string>([
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentEncoding",
  "contentMediaType",
]);

/** Keys whose value maps names chosen by the client to sub-schemas. */
const NAME_MAP_KEYS = new Set<string>(["properties", "patternProperties"]);

/** Root unions merged into one object schema, in this order. */
const ROOT_UNION_KEYS = ["allOf", "oneOf", "anyOf"] as const;

type SchemaObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is SchemaObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively drop unsupported JSON-Schema keys and empty `required` arrays. The entries of a
 * `properties` / `patternProperties` map keep their names; only their sub-schemas are cleaned.
 * Non-object/array values are returned untouched.
 */
function stripKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripKeys);

  const cleaned: SchemaObject = {};
  for (const [key, val] of Object.entries(value as SchemaObject)) {
    if (NAME_MAP_KEYS.has(key) && isPlainObject(val)) {
      const entries: SchemaObject = {};
      for (const [name, subSchema] of Object.entries(val)) entries[name] = stripKeys(subSchema);
      cleaned[key] = entries;
      continue;
    }
    if (STRIP_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(val) && val.length === 0) continue;
    cleaned[key] = stripKeys(val);
  }
  return cleaned;
}

/**
 * Merge root unions (and unions inside their branches) into one object schema. Properties are
 * merged, the first definition wins; `allOf` adds every branch's `required`, `oneOf` / `anyOf`
 * only the names every branch requires. `required` is not filtered here: a branch may require a
 * name that only the root or another branch declares.
 */
function flattenRootSchema(schema: SchemaObject): SchemaObject {
  const source: SchemaObject = { ...schema };
  const branchesByKey = new Map<string, unknown[]>();
  for (const keyword of ROOT_UNION_KEYS) {
    const branches = source[keyword];
    branchesByKey.set(keyword, Array.isArray(branches) ? branches : []);
    delete source[keyword];
  }

  const cleaned = stripKeys(source) as SchemaObject;
  cleaned.type = "object";
  if (!isPlainObject(cleaned.properties)) cleaned.properties = {};
  const properties = cleaned.properties as SchemaObject;
  const required = new Set<unknown>(Array.isArray(cleaned.required) ? cleaned.required : []);

  for (const keyword of ROOT_UNION_KEYS) {
    const branches = (branchesByKey.get(keyword) ?? []).map((branch) =>
      flattenRootSchema(isPlainObject(branch) ? branch : {})
    );
    if (branches.length === 0) continue;
    for (const branch of branches) {
      for (const [name, property] of Object.entries(branch.properties as SchemaObject)) {
        if (!Object.hasOwn(properties, name)) properties[name] = property;
      }
    }
    const branchRequired = branches.map(
      (branch) => (Array.isArray(branch.required) ? branch.required : []) as unknown[]
    );
    if (keyword === "allOf") {
      for (const names of branchRequired) names.forEach((name) => required.add(name));
    } else {
      const [first, ...rest] = branchRequired;
      for (const name of first) {
        if (rest.every((names) => names.includes(name))) required.add(name);
      }
    }
  }

  cleaned.required = [...required];
  return cleaned;
}

/**
 * The root schema as Kiro takes it: an object with `properties` and a `required` list (Kiro
 * needs the key, `[]` when empty) that names only declared properties, each once.
 */
function normalizeRootSchema(schema: SchemaObject): SchemaObject {
  const cleaned = flattenRootSchema(schema);
  const properties = cleaned.properties as SchemaObject;
  cleaned.required = [...new Set(cleaned.required as unknown[])].filter(
    (name): name is string => typeof name === "string" && Object.hasOwn(properties, name)
  );
  return cleaned;
}

/** A single Kiro tool entry (loose shape — upstream payloads vary). */
type KiroTool = {
  toolSpecification?: {
    name?: string;
    inputSchema?: { json?: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export interface SanitizeKiroToolsResult<T = unknown> {
  tools: T;
  /** Map of truncated tool name → original name, for response reverse-mapping. */
  nameMap: Map<string, string>;
}

/**
 * Sanitize a Kiro `tools` array in place-safely (returns new objects).
 *
 * - Flattens a root `allOf`/`oneOf`/`anyOf` into one object schema.
 * - Strips JSON-Schema keys Kiro rejects from each `inputSchema.json`, keeping property names
 *   that equal those keywords.
 * - Keeps the root an object with `properties` and a `required` list of declared properties.
 * - Hash-truncates tool names > 64 chars and records the mapping in `nameMap`.
 *
 * Inputs that are not arrays are returned untouched with an empty `nameMap`,
 * so this is safe to call unconditionally on the Kiro tools slot.
 */
export function sanitizeKiroTools<T>(tools: T): SanitizeKiroToolsResult<T> {
  const nameMap = new Map<string, string>();

  if (!tools || !Array.isArray(tools)) {
    return { tools, nameMap };
  }

  const sanitized = (tools as KiroTool[]).map((tool) => {
    const spec = tool?.toolSpecification;
    if (!spec) return tool;

    const originalName = spec.name;
    let name = originalName;
    if (typeof name === "string" && name.length > MAX_TOOL_NAME_LENGTH) {
      const hash = createHash("sha256").update(name).digest("hex").slice(0, 7);
      name = `${name.slice(0, 56)}_${hash}`;
      nameMap.set(name, originalName as string);
    }

    const schema = spec.inputSchema?.json;
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      const cleaned = normalizeRootSchema(schema as SchemaObject);
      return {
        ...tool,
        toolSpecification: {
          ...spec,
          name,
          inputSchema: { json: cleaned },
        },
      };
    }

    return {
      ...tool,
      toolSpecification: { ...spec, name },
    };
  });

  return { tools: sanitized as T, nameMap };
}
