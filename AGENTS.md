# Agent Guidelines for vapid.party

## Scope
These instructions apply to the entire repository.

## Self-improvement directive
- When you learn a durable workflow, command, pitfall, or convention, record it where future agents will look.
- Keep `AGENTS.md` concise and canonical; put longer reusable knowledge in `MEMORY.md`, `memory/`, `SKILLS.md`, or `skills/<name>/SKILL.md`.
- Prefer updates that make the next run faster or safer; avoid one-session trivia.

## Responsibilities
- Keep the Web Push relay honest about shipped behavior.
- Preserve wallet/API-key auth boundaries and per-app VAPID key isolation.
- Keep API handlers, Zod schemas, OpenAPI docs, LLM docs, README examples, and UI copy aligned.
- Verify changes with the relevant local workflow before landing.

## Git hygiene (required)
- Always `git commit` and `git push` whenever you finish a discrete piece of work (after `npm run lint` / `npm run build` if relevant).

## Core practices
- Avoid pretend data: don’t display “sample” counts, quotas, or marketing stats unless they are backed by real logic/data. If something isn’t implemented, hide it or label it explicitly as a placeholder.
- Prefer truth over polish: if a value is unknown, render “—” or omit the UI instead of inventing a default that looks like real usage.
- Keep product surface honest: UI/README/API docs should not claim limits/metrics/features that the backend doesn’t enforce or record.

## Implementation notes
- If a UI element implies user data (e.g., “subscribers”), it must be computed from persisted data (DB) and named clearly (e.g., “subscriber count” vs “subscription limit”).
- Keep “demo/dev shortcuts” (mock auth, fixtures) clearly gated (env flag) and never shipped as the default behavior.
- Public docs must distinguish enforced behavior from stored configuration or planned features.

## Style and structure (per recurse.bot guidance)
- Keep instructions concise and actionable; prefer bullet points over long prose.
- Update this file when workflows, conventions, or sharp edges change.
- Avoid redundant/conflicting directives; add scoped AGENTS files only when necessary.
- `AGENTS.md` is canonical. Use symlinks for harness-specific instruction files when needed.
- Use `MEMORY.md` as the compact map for durable notes, and `SKILLS.md` as the compact catalog for reusable procedures.
- Keep detailed procedures in `skills/<name>/SKILL.md`; use `curator` as the default skill for updating the skill library.

## Project overview
- Next.js 14 app-router project for a Web3-authenticated Web Push notification relay.
- Data lives in Postgres via `postgres`; migrations are in `scripts/migrate.ts` and `lib/db.ts`.
- Auth is split between wallet bearer tokens for app management and `X-API-Key` for push subscription/send endpoints.
- VAPID keypairs are generated per app and stored with app records.

## Project shape
- `app/api/`: API route handlers; keep `runtime = 'nodejs'` for routes that use Node-only libraries.
- `lib/types.ts`: Zod schemas and TypeScript API types; update this before or with API behavior changes.
- `lib/db.ts`: table creation, mapping, CRUD, subscription counting, and rate-limit log operations.
- `lib/notifications.ts`: web-push delivery, targeting, expired subscription cleanup, and per-minute send limiting.
- `public/openapi.yaml` and `public/llms.txt`: machine-readable API docs that must stay in sync with shipped handlers.
- `components/` and `app/dashboard/`: product surface; do not display unsupported metrics or limits.

## Local workflows
- Dev: `npm run dev`
- Lint: `npm run lint`
- Tests: `npm test`
- Build: `npm run build`
- DB migrate: `npm run db:migrate`

## Known sharp edges
- `maxSubscriptions` is enforced on subscribe requests.
- `maxNotificationsPerMinute` is enforced on send requests.
- `maxNotificationsPerDay` exists in stored app config but is not currently enforced by a daily window.
- `npm run build` fetches Google Fonts through `next/font` in `app/layout.tsx`; sandboxed builds may need network approval or self-hosted fonts.
- `npm test` is wired to Jest; confirm real test files/config exist before treating it as a meaningful pass.
- For GitHub auth, prefer `gh`/HTTPS over SSH. If SSH signing fails, run `gh auth setup-git` and use an HTTPS origin.
