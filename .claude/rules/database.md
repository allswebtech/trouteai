---
paths:
  - "src/lib/db/**"
  - "src/lib/localDb.ts"
---

# Database

- **Migrations only add.** New tables, new columns, new indexes. Never `DROP`, never rename:
  during an update the old and the new version share one SQLite file for a moment, and a
  rollback runs old code on the new schema.
- **File name:** `src/lib/db/migrations/NNN_short_name.sql`, the next free three-digit number.
  Files run in name order; two files with one number stop the start.
- **Write SQL that can run twice** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- **Backup.** `createPreMigrationBackup()` copies the database into `DATA_DIR/db_backups`
  before pending migrations run on an existing database. Do not remove or bypass it.
- **Three drivers.** better-sqlite3, the built-in `node:sqlite`, and sql.js. Use SQL and calls
  that all three support; driver-specific code belongs in `src/lib/db/adapters/`.
- **Credentials are encrypted at rest** with `encryptConnectionFields()`
  (`src/lib/db/encryption.ts`). Never log a secret or a key.
- **One module per domain** in `src/lib/db/<module>.ts`, using `getDbInstance()` from
  `./core`. `src/lib/localDb.ts` only re-exports; put no logic there.
