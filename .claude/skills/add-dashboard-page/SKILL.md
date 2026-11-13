---
name: add-dashboard-page
description: Add a page to the TRouteAI dashboard with its sidebar entry, texts and management API route. Use when asked for a new dashboard page, screen, tab or settings section.
argument-hint: [what the page is for]
---

# Add a dashboard page

Page wanted: $ARGUMENTS

Before building, decide whether it needs a page at all. The dashboard is for non-technical
people and the default menu is deliberately short. A setting usually belongs on an existing
page.

1. **Route.** `src/app/(dashboard)/dashboard/<slug>/page.tsx`. Copy a small page such as
   `audit/page.tsx`.
2. **Texts.** Every visible text goes in `src/i18n/messages/en.json`: page texts in a camelCase
   namespace for the feature, the sidebar label under `sidebar.<key>`, the breadcrumb under
   `breadcrumbs.<slug>` (plus `PATH_LABELS` in `src/shared/components/Breadcrumbs.tsx`). Plain
   words, short sentences, no jargon.
3. **Sidebar.** Add the id to `HIDEABLE_SIDEBAR_ITEM_IDS` in
   `src/shared/constants/sidebarVisibility/types.ts` and the entry
   (`{ id, href, i18nKey, subtitleKey, icon }`) to the right group in
   `src/shared/constants/sidebarVisibility/sections.ts`. The default simple menu is the
   allow-list `MINIMAL_SHOWN` in `src/shared/constants/sidebarVisibility.ts`: a new page is
   hidden there unless you add it, and it should be added only when most users need it.
4. **API route** under `src/app/api/<area>/route.ts` (copy
   `src/app/api/settings/thinking-budget/route.ts`): `requireManagementAuth` first, the body
   checked with `validateBody` and a Zod schema, data through a `src/lib/db/` module, errors
   without raw messages.
5. **Look.** Colours only from the CSS variables in `src/app/globals.css`; no hex values, no
   gradients. Reuse the components in `src/shared/components/`.

Check it in a real browser, started with `DATA_DIR=$(mktemp -d)` and a spare port:

1. English, light theme, desktop width first: the page loads without console errors, every
   state has a text (empty, loading, error), and the main action is obvious.
2. Then the dark theme and a phone width.
3. Signed out, the page and its API route must redirect or answer 401.

Finish with the `verify` skill.
