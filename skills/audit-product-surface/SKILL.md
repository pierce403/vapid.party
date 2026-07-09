---
name: audit-product-surface
description: Audit vapid.party UI, README, OpenAPI, llms.txt, and dashboard copy against shipped backend behavior. Use when editing product copy, landing-page features, metrics, limits, quotas, subscriber counts, billing or upgrade language, API examples, or any surface that could imply data, enforcement, or features not backed by persisted state and code.
---

# Audit Product Surface

## Overview

Keep the product surface truthful. Every count, limit, metric, feature claim, and workflow promise must be backed by code, persisted data, or an explicit placeholder label.

## Workflow

1. Inventory changed surfaces:
   - `app/page.tsx`, `components/`, and `app/dashboard/`
   - `README.md`
   - `public/openapi.yaml`
   - `public/llms.txt`
2. Trace each claim to implementation:
   - request validation: `lib/types.ts`
   - persistence and counts: `lib/db.ts`
   - auth and API responses: `lib/api-utils.ts` and `app/api/**/route.ts`
   - delivery and rate limiting: `lib/notifications.ts`
3. Replace unsupported claims with precise wording, `--`, omission, or explicit future/planned language.
4. Keep public examples aligned with actual request/response shapes.
5. Run the relevant checks before closeout.

## Current Truths To Preserve

- `maxSubscriptions` is enforced on subscribe requests through `countSubscriptionsByApp`.
- `maxNotificationsPerMinute` is enforced on send requests through `rate_limit_logs`.
- `maxNotificationsPerDay` is stored app config, but no daily enforcement window currently uses it.
- Subscription targeting supports `subscriptionIds`, `userId`, `channelId`, and broadcast-to-all when no targeting is provided.
- Push delivery results are based on actual send attempts and failed subscription cleanup.

## Red Flags

- "sample", "demo", "upgrade", "unlimited", "global", "instant", hard-coded counts, or unimplemented analytics.
- Limits shown as usage metrics when they are only configuration.
- UI showing subscriber counts unless the count comes from persisted subscription data.
- Docs claiming auth, limits, or fields that are not enforced or returned by route handlers.
