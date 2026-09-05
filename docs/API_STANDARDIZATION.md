# NoxConnect API standardization

This document tracks the eight local standardization gates for the API served by
`app.unticket.ai`. NoxConnect remains the shared foundation; the product services
remain bounded by capability and storage ownership.

Last integrated verification: **2026-09-05**, rebased on `origin/main` at
`43068d4`.

## Progress

| Step | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Inventory services, routes, storage, and compatibility | Complete | Five-service matrix and compatibility rules below |
| 2 | Service and capability discovery | Complete | `/api/v1/services`; every capability includes checked operation metadata |
| 3 | Per-service setup and readiness | Complete | consistent `/setup` and `/health` routes for all five services |
| 4 | Service-scoped config ownership and validation | Complete | strict `/config` schemas and explicit service/resource ownership |
| 5 | Authentication, authorization, and project scoping | Complete | HttpOnly browser sessions + CSRF; brokered native sessions; hashed, expiring, one-project API tokens; server-enforced service/resource scopes; secure GitHub-owner admin bootstrap |
| 6 | Safe writes, revisions, errors, and compatibility | Complete | ETag/If-Match CAS, coded v1 errors, normalized legacy boundary |
| 7 | OpenAPI, machine guidance, and overview | Complete | 63 paths and 86 classified operations, generated reference, agent guide, this overview |
| 8 | Local verification | Complete | full regression suite plus an 88-check real multi-Worker end-to-end run |

## Service ownership

| Service | Focus | Service-level config | Resource-owned config |
|---|---|---|---|
| NoxConnect | Connections and shared workspace control | service toggles, new-repository policy | GitHub/Slack connections, people, projects, Slack routing |
| NoxTicket | Planning and delivery workflow | feature repository, board stages | features, specifications, attachments |
| NoxFeed | Current work and communication | project scope, release-notes prompt | feed data and organization AI settings |
| NoxSpot | Website feedback capture | none | sites, widget environments/fields, per-site delivery |
| NoxCue | Customer-health monitoring | none | sources, ingest keys, metrics, digest schedule/delivery |

## Compatibility rules

- Existing `/api/*` routes and the current UI remain operational during migration.
- New automation starts at `/api/v1/services` and follows advertised operations.
- Provider credentials remain server-side and are never returned by discovery,
  setup, config, or health endpoints.
- NoxSpot and NoxCue do not receive artificial organization-wide config documents;
  their site/source resources remain authoritative.
- Service config writes are partial, admin-only, and compare-and-swap protected.
- The shared settings row remains the backing store until a separate data migration
  is justified; the v1 contract does not expose that storage detail.

## What each step changed

### 1. Inventory and boundaries

The API surface was classified into the five services above. Shared provider
connections, identity, projects, delivery routing, and organization policy stay
with NoxConnect. Product data remains with the product that owns it. Existing UI
routes were treated as compatibility contracts rather than rewritten in place.

### 2. Capability discovery

`GET /api/v1/services` and `GET /api/v1/services/{service}` now expose focus,
description, enablement, blockers, access level, and every supported operation.
An operation has a stable ID, method, path, authentication mode, and description.
A test fails if an advertised operation is missing from OpenAPI or IDs collide.

### 3. Setup and health

Every service has the same bounded control-plane routes:

- `GET /api/v1/services/{service}/setup`
- `GET /api/v1/services/{service}/health`

Setup reports required/optional connections, blockers, capability state, and
section state. Health reports `healthy`, `degraded`, `blocked`, or `disabled`
with individual required/optional checks.

### 4. Configuration ownership

Every service has `GET /api/v1/services/{service}/config`. NoxConnect,
NoxTicket, and NoxFeed accept strict partial PATCH documents for only their owned
fields. The response names writable fields. NoxSpot and NoxCue report
`mode: resource`; their sites and sources remain authoritative and a service-level
PATCH returns a coded response with the correct child-resource links.

### 5. Access and tenant isolation

Browser GitHub OAuth now ends in a random, hashed-at-rest NoxConnect session
cookie; the GitHub token remains encrypted server-side. Browser mutations use a
separate CSRF cookie/header proof. Native GitHub device approval is brokered by
NoxConnect: the native app stores only a 15-minute `nox_at_…` access token and a
rotating 30-day `nox_rt_…` refresh token, while provider credentials stay encrypted
server-side. Existing NoxFeed installs exchange their legacy provider credential
once and replace it in Keychain. Automation tokens are organization- and one-project-bound,
expire within 365 days, are shown once, and store only a SHA-256 hash. Service
read/write and project scopes are enforced before handlers run, token lifecycle actions are
audited, and API tokens cannot mint other API tokens. New-organization admin
bootstrap requires a verified active GitHub organization owner.

Each automation token belongs to exactly one enabled project. Collection reads
are filtered to that project, direct references outside it return
`resource_not_found`, and disabled services return `service_not_enabled` before
product code runs. Automation currently covers project-owned NoxFeed, NoxSpot,
and NoxCue operations. Organization-wide NoxConnect configuration and the
organization-owned NoxTicket feature repository require a human session rather
than pretending they can be safely project-scoped.

### 6. Safe writes and errors

Config reads return a SHA-256 revision in both the JSON body and `ETag`. PATCH
requires that value in `If-Match`; stale reads return `412` and the current ETag.
The D1 update uses compare-and-swap so a race occurring after validation is also
rejected. API v1 errors use `{ apiVersion, error: { code, message, details? } }`.
Legacy handlers keep their old response shape, and errors are normalized when
they cross into v1.

All v1 responses are JSON, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and link to `/openapi.json` as the service
description.

### 7. Contract and guidance

OpenAPI now covers service discovery/control, NoxConnect resources, NoxTicket
features/specs/attachments, NoxFeed work/activity/AI settings, NoxSpot sites and
public capture, and NoxCue sources/keys/events/metrics. The capability catalog and
OpenAPI are mechanically checked for alignment. Every operation classifies its
authentication and change/retry safety, and every non-empty response has a
machine-readable body. The developer page renders all 86 operations directly
from that contract. Agent guidance documents the supported first-party auth
boundary, safe human OAuth handoffs, config concurrency, resource ownership,
routing, retry behavior, and errors.

NoxCue ingestion now has a stable same-origin public gateway at
`/api/cues/public/v1/events`. It forwards through the private service binding,
so client snippets no longer depend on a temporary Worker hostname.

### 8. Verification

The final gate runs focused contract/security tests, the complete Vitest suite,
ESLint, Pages Functions TypeScript checking, the production Vite build, OpenAPI
JSON parsing and linting, `git diff --check`, and a clean multi-Worker runtime.
The exact setup is documented in [LOCAL_E2E.md](./LOCAL_E2E.md).

## Final verification results

- Focused documentation/API contract run: passed.
- Complete Vitest run: 172 files and 1,327 tests passed.
- ESLint: passed.
- Pages Functions TypeScript check: passed.
- Production Vite build: passed.
- HTML validation: passed.
- OpenAPI: valid JSON; 63 paths and 86 operations; deterministic drift check
  passed. Redocly validates the contract with one pre-existing ambiguity warning
  between the project-routing and project-archive path templates.
- Patch hygiene: `git diff --check` passed.
- Dependency audit: production and complete dependency trees both report zero
  known vulnerabilities after refreshing the lockfile within existing semver
  ranges (React Router 7.18.3, Vite 7.3.6, and Vitest 4.1.11).
- Local end-to-end runtime: Wrangler 4.129.0 started NoxConnect, NoxSpot,
  NoxFeed, NoxCue, the cron Worker, and a disposable RPC caller against one fresh
  local D1 database. All 88 readiness and functional checks passed, including
  live GitHub identity plus opaque browser- and native-session authentication,
  native access/refresh rotation, CSRF rejection,
  project-scoped API-token create/list/rotate/revoke and adversarial isolation,
  private RPC, service-bound NoxCue ingest,
  persisted metrics, NoxSpot Queue submission, config compare-and-swap, and
  webhook HMAC verification. No production provider credential was loaded.
- API-token lifecycle: actual local HTTP calls created a one-time
  `nox_sk_test_…` secret, listed only redacted metadata, enforced service
  scopes, rotated it, rejected the previous value immediately, revoked the
  replacement, and rejected the revoked value. A token was also prevented from
  managing other tokens.
- Browser verification rendered all operations in five service groups, had
  no console warnings/errors or horizontal overflow, and scored 100 for
  accessibility, best practices, SEO, and agentic browsing in mobile Lighthouse.
