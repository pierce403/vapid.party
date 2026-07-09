---
name: change-api-contract
description: Change vapid.party API behavior while keeping handlers, Zod schemas, database code, OpenAPI, llms.txt, README examples, and dashboard snippets aligned. Use when adding or modifying API routes, auth behavior, request fields, response fields, validation errors, rate limits, VAPID key behavior, subscription targeting, or public API examples.
---

# Change API Contract

## Overview

Treat API behavior as a contract spread across route handlers, schemas, persistence, generated-looking docs, and examples. Update the full set in one change.

## Workflow

1. Locate the route in `app/api/**/route.ts`.
2. Update request validation and shared types in `lib/types.ts`.
3. Update persistence or query logic in `lib/db.ts` when fields, limits, or relationships change.
4. Update auth helpers in `lib/api-utils.ts` only when auth behavior changes.
5. Update delivery behavior in `lib/notifications.ts` for send, targeting, or push payload changes.
6. Sync public docs:
   - `public/openapi.yaml`
   - `public/llms.txt`
   - `README.md`
   - dashboard code snippets in `app/dashboard/page.tsx`
7. Run focused tests or add them when behavior is not already covered.
8. Run lint/build before closeout.

## Contract Checklist

- Status codes match docs and error examples.
- Error responses use `{ success: false, error, code, details? }`.
- Validation failures return HTTP 422 when Zod parsing fails.
- CORS behavior remains consistent with existing routes.
- Wallet-auth endpoints do not accept API-key auth by accident.
- API-key endpoints do not expose owner-only fields by accident.
- API keys and VAPID private keys are never shown in public docs or logs.
- `public/openapi.yaml` and `public/llms.txt` include new fields, targeting rules, and examples.

## Validation Commands

```bash
npm run lint
npm run build
```

Run `npm test` when tests exist or when the change adds test coverage.
