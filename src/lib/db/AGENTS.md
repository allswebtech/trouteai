# src/lib/db/: SQLite persistence

One module per domain; each owns its tables. Every schema change is a numbered SQL migration.
Routes and services never contain SQL: they call functions from these modules. List the modules
with `ls src/lib/db/*.ts` and the migrations with `ls src/lib/db/migrations`.

## Core

- `core.ts`: `getDbInstance()` returns the one database handle. The base schema is `SCHEMA_SQL`;
  `runMigrations()` is called from here at start.
- `adapters/`: the SQLite drivers (better-sqlite3, Node's built-in `node:sqlite`, sql.js) behind
  one interface, chosen by `driverFactory.ts`. Driver-specific code belongs here and nowhere else.
- `migrationRunner.ts`: runs `migrations/NNN_name.sql` in name order, each in a transaction, and
  records them in `_trouteai_migrations`. Before pending migrations run on an existing database,
  `createPreMigrationBackup()` copies it into `DATA_DIR/db_backups`.
- `caseMapping.ts`: `rowToCamel()` turns snake_case rows into camelCase objects.
- `encryption.ts`: `encryptConnectionFields()` encrypts provider credentials before they are
  stored.
- `src/lib/localDb.ts`: re-exports only. No logic there.

## Modules to know

| Module                               | What it stores                                |
| ------------------------------------ | --------------------------------------------- |
| `providers.ts`                       | Provider connections and their credentials    |
| `models.ts`                          | Custom and synced model lists                 |
| `combos.ts`                          | Combos and their steps                        |
| `apiKeys.ts`                         | API keys                                      |
| `settings.ts`, `databaseSettings.ts` | App settings and database settings            |
| `secrets.ts`                         | Generated secrets that must survive a restart |
| `quotaSnapshots.ts`, `quotaPools.ts` | Usage-limit snapshots and shared usage pools  |
| `files.ts`, `batches.ts`             | Uploaded files and batch jobs                 |
| `backup.ts`, `cleanup.ts`            | Backup retention, and removal of old data     |
| `healthCheck.ts`                     | Database health check                         |

## Rules

- **Migrations only add.** New tables, columns and indexes. Never `DROP`, never rename: during
  an update the old and the new version share one database file for a moment, and a rollback
  runs old code on the new schema.
- Name a migration `NNN_short_name.sql` with the next free three-digit number. Two files with
  one number stop the start.
- Write SQL that can run twice (`IF NOT EXISTS`) and that every driver supports.
- Never store a credential in plain text, and never log a secret or a key.

## Adding a module

1. Create `src/lib/db/<module>.ts` with small functions that use `getDbInstance()` from
   `./core` (copy a small module such as `featureFlags.ts`).
2. Add `export * from "./db/<module>";` to `src/lib/localDb.ts`.
3. New tables or columns: add a migration.

## Do not

- Write SQL in a route or a service.
- Call `prepare()` outside `src/lib/db/`.
- Put logic in `localDb.ts`, or import everything from it; import the specific module.
- Change the schema without a migration.
