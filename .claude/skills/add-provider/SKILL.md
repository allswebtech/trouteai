---
name: add-provider
description: Add a new AI provider to TRouteAI (catalog entry, routing entry, models, icon, connection test). Use when asked to add, support or integrate a provider, a gateway or an OpenAI-compatible or Anthropic-compatible service.
argument-hint: [provider name or its API docs URL]
---

# Add a provider

Provider to add: $ARGUMENTS

First read the provider's own API documentation and write down: the base URL, how the key is
sent (Bearer header, `x-api-key`, something else), the request format (OpenAI chat completions,
OpenAI responses, Anthropic messages, or its own), the model ids, and whether it has a models
endpoint. Do not guess any of these; if the documentation is not reachable, ask.

Copy a small existing provider at every step. For an OpenAI-format API-key provider that is
`cerebras`.

1. **Catalog entry** (what the dashboard shows). Add it to the matching family file in
   `src/shared/constants/providers/apikey/` (`gateways.ts`, `frontier-labs.ts`,
   `inference-hosts.ts`, `enterprise-cloud.ts`, `regional.ts`, `specialty-media.ts`).
   Required: `id`, `name`, `icon` (a Material icon name), `color` (`#RRGGBB`). Useful: `alias`,
   `website`, `textIcon`, `hasFree`, `freeNote`. The catalog is validated with Zod when the app
   starts (`src/shared/validation/providerSchema.ts`); a wrong entry stops the start with a
   `[PROVIDER VALIDATION]` message.
2. **Routing entry** (how requests are sent). Create
   `open-sse/config/providers/registry/<id>/index.ts` exporting a `RegistryEntry`
   (`open-sse/config/providers/shared.ts`): `id`, `alias`, `format`, `executor: "default"`,
   `baseUrl`, `authType`, `authHeader`, `models: [{ id, name }]`. Nothing is discovered
   automatically: import it and add it to `REGISTRY` in `open-sse/config/providers/index.ts`.
3. **Models.** The static list is the `models` array of the routing entry. For live discovery
   add the provider to
   `src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts`.
4. **Icon.** Put `public/providers/<id>.svg` (or `.png`) in place and add the id to
   `KNOWN_SVGS` (or `KNOWN_PNGS`) in `src/shared/components/ProviderIcon.tsx`. Use the
   provider's own mark only when its licence allows it; otherwise leave the generic icon.
5. **Connection test.** OpenAI-format entries are tested automatically
   (`src/lib/providers/validation/openaiFormat.ts`, using the first model). Only a provider
   with its own check needs an entry in `SPECIALTY_VALIDATORS` in
   `src/lib/providers/validation.ts`.
6. **Executor.** Not needed for OpenAI-format providers: `open-sse/executors/default.ts` handles
   them. Write `open-sse/executors/<id>.ts` and register it in `open-sse/executors/index.ts`
   only when the provider needs its own request or response shape.
7. **Optional.** A short onboarding text under
   `providers.onboardingProviderDescriptions.<id>` in `src/i18n/messages/en.json`; free-tier and
   pricing data only when you have the provider's published numbers.

Rules:

- Never put a real API key in code, a test or a fixture.
- Public client identifiers of a provider's CLI are stored through
  `open-sse/utils/publicCreds.ts` and read with `resolvePublicCred()`, never as literals.
- Do not add a runtime dependency for one provider.

Finish with the `verify` skill. Then start the app with a throwaway data folder, open
**Providers**, and confirm the new provider appears with its icon and that "Test connection"
gives a clear result for a wrong key. Say plainly that a real request was not tested unless the
person gave you a key for it.
