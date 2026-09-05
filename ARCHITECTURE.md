# Architecture

A high-level map of how noxconnect fits together. For maintainer-level detail (every API route, config key, and convention), see [CLAUDE.md](./CLAUDE.md).

## Overview

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────┐
│ React SPA / │────▶│ NoxConnect Pages API │────▶│ D1 + R2      │
│ API clients │     │ auth + control plane │     │ shared state │
└─────────────┘     └──────┬───────┬───────┘     └──────▲───────┘
                           │       │ private bindings    │
                  provider │       ├────────▶ NoxFeed response
                  access   │       ├────────▶ NoxSpot response/capture
 GitHub + Slack ◀──────────┘       └────────▶ NoxCue response/ingest
       │                                      │
       └── webhooks ──▶ Queue + cron Worker ──┘
```

- **Frontend** — React 19 + TypeScript + Vite SPA. TanStack Query reads NoxConnect APIs; browser code does not receive GitHub or Slack tokens or call provider APIs directly. Tailwind provides styling and product/admin views are lazy-loaded.
- **API** — Cloudflare Pages Functions under `functions/api/`. New code is TypeScript with zod validation at the boundary; data access uses the native D1 binding (`DB.prepare().bind()`, `DB.batch()`).
- **Database** — Cloudflare D1 (SQLite). Schema in `migrations/`, applied with `wrangler d1 migrations apply`.
- **Cron Worker** — a sibling Worker in `cron/` that imports shared helpers from `functions/lib/`. It reconciles GitHub state every 30 minutes and consumes the background-work queue.
- **Queue + R2** — durable background work (narration, bootstrap, repo sync) runs on a Cloudflare Queue with retries and a dead-letter queue; the `events` table is archived to R2 after 90 days.

## Multi-tenancy

NoxConnect is multi-tenant. Each GitHub organisation is an `org` row, and core tables (`repos`, `pull_requests`, `issues`, `members`, `config`, `features`, `teams`, `ai_settings`) carry an `org_id` foreign key. The auth middleware (`functions/_middleware.js`) resolves and verifies the caller's organization and scopes every query by `org_id`. An unconfigured organization can be bootstrapped only by a caller GitHub verifies as an active organization owner; membership alone never grants the NoxConnect admin role.

## Authentication and credentials

Credentials are separated by caller and cannot be substituted for one another:

- **Browser users** — GitHub OAuth creates an opaque, hashed-at-rest NoxConnect session in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie. GitHub access and refresh tokens remain encrypted server-side. Browser mutations require a separate CSRF cookie/header proof.
- **Native users** — NoxConnect brokers GitHub device approval, stores provider credentials encrypted, and returns a 15-minute `nox_at_…` access token plus a rotating 30-day `nox_rt_…` refresh token. Only hashes of those NoxConnect credentials are stored. Native sign-out revokes the server session.
- **Native abuse control** — provider-facing device-start and legacy-exchange operations fail closed behind the `NATIVE_AUTH_RATE_LIMITER` binding before they call GitHub. Device polling also enforces GitHub's per-code interval atomically.
- **Automation** — expiring `nox_sk_live_…` or `nox_sk_test_…` secrets are bound to one organization, exactly one enabled project, and explicit NoxFeed/NoxSpot/NoxCue read/write scopes. Values are shown once, stored only as hashes, audited, rotatable, and revocable.
- **Public capture** — NoxCue source keys and origin-bound NoxSpot capture are limited to their ingestion contracts; they do not grant management access.
- **Internal services** — Workers use private versioned service bindings and receive bounded product data, never provider tokens.
- **Legacy local compatibility** — a GitHub bearer can temporarily authenticate local development and one-time native upgrades. Supported native releases immediately exchange it for a NoxConnect session; it is deprecated and is not the public automation contract.

## Data freshness: three redundant paths

GitHub data stays current via three mechanisms, in priority order:

1. **Webhooks** (`functions/api/webhook.js`) — real-time, HMAC-verified. The running source of truth.
2. **Cron reconcile** (every 30 min) — catches deletes (GitHub fires no delete webhooks), deliveries missed during deploys, and label changes on pre-install issues.
3. **Manual sync / backfill** — admin-triggered from the UI for first sync or recovery. Rate-limited to bound cost.

## Background work

Slow webhook follow-up (LLM narration, install bootstrap, repo backfill) is enqueued to the `noxconnect-tasks` Queue rather than run inline. The cron Worker's `queue()` handler dispatches by task type with retries; terminal failures are recorded to the `op_failures` table and surfaced to admins in Settings.

## Project routing

NoxConnect owns explicit project enablement, the shared repository-to-project map, and named project Slack destinations. GitHub repositories are mirror records, not projects by default: an admin must enable a NoxConnect project before it participates in routing. An enabled project can group multiple repositories; a repository belongs to at most one project. NoxFeed resolves pull-request traffic by repository, while NoxCue resolves its linked project after any source-specific override. Both then fall back to their organization route. An organization-wide Slack workspace can serve every project; a project-owned workspace is accepted only for that project.

## AI narration

A bounded server-side Anthropic integration narrates pull-request activity. NoxConnect owns the provider credential; customers can enable or disable managed AI through `ai_settings` but never supply keys or endpoints. Narration is paced and fails closed to deterministic summaries when unavailable. Provider credentials remain server-side and are never returned to the browser.

## Where to look

| Concern | Path |
|---|---|
| Tabs / pages | `src/pages/`, `src/components/tabs/` |
| GitHub data hooks | `src/hooks/useGitHub.ts` |
| API routes | `functions/api/` |
| Shared server helpers | `functions/lib/` |
| Project routing core | `functions/lib/project-routing.ts`, `functions/api/projects/routing*` |
| DB schema | `migrations/` |
| Cron + queue consumer | `cron/src/` |
