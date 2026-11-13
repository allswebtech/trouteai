---
paths:
  - "package.json"
  - "next.config.mjs"
  - "app.cjs"
  - "bin/**"
  - "scripts/**"
  - ".github/workflows/**"
---

# Packaging, start-up and release

- **The npm package ships a prebuilt app.** `files` in `package.json` decides what ships; `tests/`
  and `scripts/release/` do not.
- **Runtime dependencies use exact versions**, and only what the server needs at runtime is in
  `dependencies`. The build output works only with the exact `next` version that built it. Users
  do not get our `.npmrc` or `overrides`, so a build-only package in `dependencies` pulls its
  peers onto every user's machine.
- **`serverExternalPackages`.** A package added there (`next.config.mjs`) must also be in
  `dependencies`. Rebuild and check `.build/next/trouteai-externals.json`.
- **Start-up chain.** `bin/trouteai.mjs` (settings file, port check, banner) or `app.cjs` /
  `npm start` → `scripts/dev/run-next.mjs` → `scripts/build/bootstrap-env.mjs` (env files and
  generated secrets). A change in one must be tried with all three ways of starting.
- **Quiet terminal.** In production the terminal shows the banner, the ready line, and real
  warnings and errors only (`scripts/dev/terminalLog.mjs`). Do not add start-up noise.
- **Secrets** (`JWT_SECRET`, `API_KEY_SECRET`, `STORAGE_ENCRYPTION_KEY`) are generated on the
  first start into `DATA_DIR/server.env`, mode 0600. Never print them.
- **The release build** (`node scripts/build/build.mjs --release`) hides local `NEXT_PUBLIC_*`
  values, builds with an empty data folder and strips the local folder path. Keep all three.
- **Version numbers and publishing** are the maintainers' decision. Do not run `npm version`,
  `npm publish` or `npm run release` unless a maintainer asked for exactly that.
