# TRouteAI

The project guide for every AI coding agent is AGENTS.md:

@AGENTS.md

## Claude Code

- **Skills** (`.claude/skills/`): `/verify` runs the checks in the right order and reports the
  numbers; `/add-provider`, `/add-migration` and `/add-dashboard-page` walk through the common
  changes.
- **Rules** (`.claude/rules/`) load by themselves when you work in that part of the code: the
  routing engine, the Kiro provider, API routes, the dashboard, the database, packaging.
- **Reviewer** (`.claude/agents/trouteai-reviewer.md`): a subagent that reviews a change against
  this project's security and compatibility rules.
- **Settings** (`.claude/settings.json`) deny reading `.env` files, data folders and databases.
  Do not work around a denied read; ask the person instead.
- Personal notes and overrides go in `CLAUDE.local.md` and `.claude/settings.local.json`; git
  ignores both.
