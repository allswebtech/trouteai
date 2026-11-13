# open-sse/services/: routing engine and shared services

The modules here decide where a request goes and what happens when a provider fails: combo
routing, rate limits, usage limits, token refresh, fallback and runtime state. `combo.ts` is the
core. List them with `ls open-sse/services/*.ts`; larger services have their own folder
(`combo/`, `accountFallback/`, `rateLimitManager/`, `tokenRefresh/`, `usage/`, `autoCombo/`,
`compression/`).

## Combo routing

- `combo.ts`: `handleComboChat()` is the entry point for a model name that is a combo. It tries
  the combo's steps with the combo's strategy until one succeeds or all have failed. Each step
  ends in `handleChatCore()` (`open-sse/handlers/chatCore.ts`).
- Strategies are listed in `ROUTING_STRATEGY_VALUES`
  (`src/shared/constants/routingStrategies.ts`); add a strategy there first.
- `combo/targetExhaustion.ts`: what to mark as used up when a step hits a usage limit. A step
  pinned to one account marks only that account.

## Services by area

- **Limits:** `rateLimitManager.ts` (per key and provider, checked before a request is sent),
  `usage.ts` and `usage/` (provider usage and reset times), `tokenLimitCounter.ts`.
- **Accounts and tokens:** `tokenRefresh.ts` and `tokenRefresh/` (OAuth token refresh),
  `accountFallback.ts` (switching accounts on a limit, model lockout), `sessionManager.ts`.
- **Routing decisions:** `wildcardRouter.ts`, `intentClassifier.ts`, `taskAwareRouter.ts`,
  `targetRequestSanitizer.ts` (last parameter clean-up before the executor), `thinkingBudget.ts`,
  `contextManager.ts`.
- **Fallback:** `modelDeprecation.ts`, `modelFamilyFallback.ts`, `emergencyFallback.ts`.
- **State and detection:** `backgroundTaskDetector.ts`, `ipFilter.ts`, `signatureCache.ts`,
  `contextHandoff.ts`.
- **Prompt compression** (`compression/`, off unless a user turns it on): `strategySelector.ts`,
  `lite.ts`, `caveman.ts`, `engines/`, `stats.ts`, `types.ts`.

## Adding a service

1. Create `open-sse/services/<name>.ts` and export its main function.
2. Call it from `open-sse/handlers/chatCore.ts` (every request) or `combo.ts` (combos only).
3. Add a check under `tests/checks/` when it changes what a client receives.

## Do not

- Call the database synchronously for every request in `combo.ts`; read from the caches.
- Keep state that two concurrent requests share; keep it request-scoped.
- Read provider settings directly; use the getters of `open-sse/config/providerRegistry.ts`.
- Hard-code a fallback chain; define it in `modelFamilyFallback.ts`.
- Start a timer or a poll that runs while no request is being served.
