import pkg from "../../../package.json" with { type: "json" };

export const APP_CONFIG = {
  name: "TRouteAI",
  description: "Self-hosted AI Router",
  version: pkg.version,
};

export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system",
};
