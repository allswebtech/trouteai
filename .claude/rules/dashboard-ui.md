---
paths:
  - "src/app/(dashboard)/**"
  - "src/app/login/**"
  - "src/shared/components/**"
  - "src/i18n/**"
  - "src/app/globals.css"
---

# Dashboard

The people who use the dashboard are often not technical. Every screen needs one obvious next
action, plain words and no jargon.

- **Text** lives in `src/i18n/messages/en.json`, in a camelCase namespace per feature. No text
  literals in components. The dashboard is English only.
- **Colours** come from the CSS variables in `src/app/globals.css` (`--color-primary`,
  `--color-surface`, `--color-border`, …). No hex values in components, no gradients. Every
  change must look right in the light and the dark theme.
- **Sidebar.** Ids are in `src/shared/constants/sidebarVisibility/types.ts`, entries in
  `sections.ts`. The default simple menu is the allow-list `MINIMAL_SHOWN` in
  `src/shared/constants/sidebarVisibility.ts`; a new entry is hidden there unless you add it.
- **Provider icons** resolve in `src/shared/components/ProviderIcon.tsx`; a new local icon needs
  its id in `KNOWN_SVGS` or `KNOWN_PNGS`.
- **Scripts.** An inline `<script>` needs the request nonce
  (`nonce={readCspNonce(await headers())}`). No third-party script origin, ever.
- **White-label.** The app name, logo and credit line are settings. Never hard-code a brand, a
  sponsor or an external link into a page.
- **Light.** No polling while the tab is hidden; use the live WebSocket (`/live-ws`) where a
  page already has it.
- **Check order.** English, light theme, desktop width first. When that is clean, check the
  dark theme and a phone width.
