/**
 * Which sign-in flow a provider uses, shared by the OAuth route and the provider list so the two
 * cannot drift apart.
 */

/** Providers that use the PKCE browser callback flow (like Codex). */
export const PKCE_CALLBACK_PROVIDERS = new Set(["codex", "xai-oauth", "grok-cli"]);

/**
 * Providers whose device flow runs in the user's browser (auth.openai.com blocks
 * datacenter IPs but allows CORS), so the server never polls — it only persists
 * the final tokens via the `device-complete` action. See src/lib/oauth/codexDeviceFlow.ts.
 */
export const BROWSER_DEVICE_FLOW_PROVIDERS = new Set(["codex"]);

/**
 * Providers whose PKCE flow has been retired but whose import-token path is
 * still active. Returning 410 Gone on `authorize` / `start-callback-server` /
 * `poll-callback` (instead of 400) tells callers the action is permanently
 * gone and points them at /import-token. windsurf/devin-cli were retired
 * 2026-05-29 because app.devin.ai/editor/signin returned 404 post-rebrand.
 * Phase 2 will reintroduce browser login via Firebase OAuth + RegisterUser.
 */
export const RETIRED_PKCE_PROVIDERS = new Set(["windsurf", "devin-cli"]);
