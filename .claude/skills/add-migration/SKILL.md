---
name: add-migration
description: Add a database change to TRouteAI the safe way (an additive SQL migration and its database module). Use when a change needs a new table, column or index, or new stored data.
argument-hint: [what needs to be stored]
---

# Add a database change

Change wanted: $ARGUMENTS

**The one rule: migrations only add.** New tables, new columns, new indexes. Never `DROP`, never
rename a table or a column, never change what an existing column means. During an update the old
and the new version share one SQLite file for a moment, and a rollback runs old code on the new
schema. If the change seems to need a rename or a removal, stop and propose an additive design
(a new column, the old one left in place).

1. **Find the next number:** `ls src/lib/db/migrations | tail -3`. Files are named
   `NNN_short_name.sql` and run in name order, so keep three digits. Two files with the same
   number stop the app at start.
2. **Write the migration** as plain SQL that can run twice without harm:
   `CREATE TABLE IF NOT EXISTS …`, `CREATE INDEX IF NOT EXISTS …`,
   `ALTER TABLE … ADD COLUMN …` with a default so existing rows stay valid. Copy the style of
   the newest file in the folder.
3. **Use SQL every driver runs.** The app works on better-sqlite3, on Node's built-in
   `node:sqlite` and on sql.js. No extension functions, no driver-specific syntax.
4. **Database code** goes in `src/lib/db/<module>.ts` (copy a small one such as
   `featureFlags.ts`): import `getDbInstance` from `./core`, export small functions, and add
   `export * from "./db/<module>"` to `src/lib/localDb.ts`. Routes never contain SQL.
5. **Secrets** stored in the database go through `encryptConnectionFields()`
   (`src/lib/db/encryption.ts`) or the secrets module. Never store a credential in plain text
   and never log one.

Check it on a copy, never on real data:

- Fresh database: start the app with `DATA_DIR=$(mktemp -d)` and a spare port; it must start
  without a migration error.
- Existing database: start the previous build once in a temporary data folder, then start the
  new build on the same folder. The migration must apply, and a backup must appear in
  `db_backups/` inside that folder.
- Then the old build must still start on the migrated folder (the rollback case).

Finish with the `verify` skill and say which of the three starts you ran.
