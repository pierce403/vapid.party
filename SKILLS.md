---
skills:
  curator: Maintain repo-local memory and skills.
  audit-product-surface: Check UI and docs against shipped backend behavior.
  change-api-contract: Keep API behavior, schemas, and docs aligned.
  ship-change: Verify, commit, and push finished work.
---

# SKILLS.md

Use this index to choose which skill folder to open next. Read only the relevant `skills/<name>/SKILL.md` file unless a task needs multiple procedures.

## Catalog

- `curator`: Use when adding, revising, consolidating, or pruning `MEMORY.md`, `memory/`, `SKILLS.md`, or `skills/`.
- `audit-product-surface`: Use when editing landing pages, dashboard UI, README, OpenAPI, or `llms.txt`, especially around metrics, limits, quotas, or planned features.
- `change-api-contract`: Use when changing request/response behavior, auth, validation, database-backed fields, or public API examples.
- `ship-change`: Use at closeout to run the relevant checks, commit, push, and verify the worktree is clean.

## Skill Rules

- Keep skill bodies concise and procedural.
- Add a skill only for workflows likely to repeat.
- Update `SKILLS.md` whenever a skill is added, renamed, merged, or removed.
- Validate changed skills with the system skill validator before landing.
