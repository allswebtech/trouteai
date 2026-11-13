// Terminal output for the production server (`trouteai`, `npm start`, `app.cjs`): only
// warnings and errors, unless APP_LOG_LEVEL asks for more (`trouteai --verbose` sets it
// to info). The log file in DATA_DIR/logs is not affected.
const RANK = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

/** Level for the terminal: APP_LOG_LEVEL when set to a known level, otherwise "warn". */
export function resolveTerminalLogLevel(value) {
  const level = String(value || "")
    .trim()
    .toLowerCase();
  return level in RANK ? level : "warn";
}

/** True when the terminal should show informational messages too. */
export function wantsInfoLogs(value) {
  return RANK[resolveTerminalLogLevel(value)] <= RANK.info;
}

/** Mute console methods below the terminal level. */
export function applyTerminalLogLevel(value) {
  const rank = RANK[resolveTerminalLogLevel(value)];
  const mute = () => {};
  if (rank > RANK.debug) console.debug = mute;
  if (rank > RANK.info) {
    console.log = mute;
    console.info = mute;
  }
  if (rank > RANK.warn) console.warn = mute;
  if (rank > RANK.error) console.error = mute;
}
