/**
 * The fields a client reads from each chat row of `GET /v1/models` to pick and size a model.
 *
 * Clients (OpenCode, coding agents, OpenRouter-style pickers) look for `supported_parameters`
 * to decide whether to send tools or reasoning settings, and for `max_input_tokens` beside
 * `context_length` to size a request. The rows are built from many sources (the registry,
 * synced lists, custom models, combos), and not every source writes both, so they are
 * completed here, once, from what the row already says. Nothing is guessed: a parameter is
 * listed only when the row's own capabilities say so, and an input limit only mirrors a
 * context length the row already has (the same rule the built-in auto rows use). A missing
 * output limit stays missing.
 */

type CatalogRow = Record<string, unknown>;

function isChatRow(row: CatalogRow): boolean {
  return row.type === undefined || row.type === null || row.type === "chat";
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The OpenRouter-style parameter names a row's capabilities imply. */
export function supportedParametersFor(capabilities: unknown): string[] {
  const caps = capabilities && typeof capabilities === "object" ? (capabilities as CatalogRow) : {};
  const params = ["max_tokens"];
  if (caps.temperature === true) params.push("temperature");
  if (caps.tool_calling === true) params.push("tools", "tool_choice");
  if (caps.reasoning === true || caps.thinking === true || caps.supportsThinking === true) {
    params.push("reasoning", "include_reasoning");
  }
  if (caps.structured_output === true) params.push("response_format", "structured_outputs");
  return params;
}

/** Complete one row; rows that are not chat models are returned as they are. */
export function completeCatalogRow<T extends CatalogRow>(row: T): T {
  if (!isChatRow(row)) return row;
  const next: CatalogRow = { ...row };
  if (!isPositiveNumber(next.max_input_tokens) && isPositiveNumber(next.context_length)) {
    next.max_input_tokens = next.context_length;
  }
  if (!Array.isArray(next.supported_parameters)) {
    next.supported_parameters = supportedParametersFor(next.capabilities);
  }
  return next as T;
}
