# Service Boundary Migration Plan

## Objective

Make NoxConnect the single public API and the only holder/executor of GitHub,
Slack, and managed-AI credentials, while NoxTicket, NoxFeed, NoxSpot, and NoxCue
own their product rules, product data projections, configuration validation, and
provider-neutral output intents.

The public API remains under `app.unticket.ai/api/v1`. Product Workers are
called through private Cloudflare service bindings; they are not exposed as a
second authenticated public API.

## Boundary rule

NoxConnect owns:

- authentication, organization membership, and project-token authorization;
- service enablement and the standard `service_not_enabled` response;
- GitHub and Slack OAuth, token storage, refresh, and provider clients;
- managed-AI credentials and provider invocation;
- project/repository/identity mapping and provider webhook verification;
- shared routing, outbox, retry, queue, audit, and failure infrastructure;
- public API versioning, OpenAPI, and service discovery aggregation.

Each product service owns:

- its domain validation and configuration schema;
- its product data lifecycle and projections;
- prompts, copy, labels, templates, deduplication keys, and workflow policy;
- provider-neutral commands (for example a GitHub issue intent or Slack
  message), never provider credentials;
- processing provider receipts returned by NoxConnect.

## Health scorecard

Every milestone records the following dimensions for every affected service:

| Dimension | Passing condition |
|---|---|
| Contract | Versioned request/response schemas reject unknown or unsafe input and pass compatibility tests. |
| Isolation | Product Worker environment and generated types contain no GitHub, Slack, or Anthropic credential binding. |
| Runtime | Worker typecheck and dry-run build pass with current Cloudflare types. |
| Service call | A real local service-binding call returns the expected versioned response. |
| Data | Local D1 migrations apply and the milestone's create/read/update/dedup flow succeeds. |
| Async | Queue/outbox calls are idempotent and a retry does not duplicate provider-visible work. |
| Public API | Existing route, authentication, authorization, status code, and response envelope remain compatible. |
| Regression | Repository unit/integration tests and production builds pass. |

A milestone is healthy only when all applicable dimensions pass. A skipped
dimension must include a written reason; it is not silently counted as green.

## Milestone 0 — Baseline and isolated worktrees

1. Preserve the user's dirty NoxConnect, NoxCue, and NoxFeed checkouts.
2. Use the existing clean `feat/api-standardization` NoxConnect worktree.
3. Create clean worktrees from current remote heads for NoxCue, NoxFeed, and
   NoxSpot.
4. Confirm that no independent NoxTicket repository exists; create a local
   service repository during Milestone 3.
5. Run and record each repository's current tests, typecheck, and build.

Gate: all pre-existing failures are recorded before migration code is changed.

### Baseline result — 2026-09-06

| Repository | Result |
|---|---|
| NoxConnect | Healthy: 172 test files / 1,328 tests, Functions typecheck, and production frontend build passed. |
| NoxCue | Healthy after required `wrangler types`: 10 test files / 67 tests, typecheck, and dry-run Worker bundle passed. A fresh worktree cannot typecheck until generated bindings exist. |
| NoxFeed service | Healthy: 2 test files / 13 tests and dry-run Worker bundle passed. |
| NoxSpot API | Functional baseline healthy: 23 test files / 180 tests passed. Dependency audit is pre-existing red: 1 critical, 5 high, and 1 low vulnerability. |
| NoxSpot widget | Healthy: 16 test files / 153 tests and loader/core/standalone/package builds passed. |
| NoxTicket | No independent repository or Worker exists; creation is part of Milestone 3. |

Isolation worktrees:

- NoxConnect: `feat/api-standardization` at `ed7ebac`;
- NoxCue: `feat/service-boundaries-noxcue` from `origin/main`;
- NoxFeed: `feat/service-boundaries-noxfeed` from `origin/initial`;
- NoxSpot: `feat/service-boundaries-noxspot` from `origin/main`.

## Milestone 1 — Bounded connection capabilities

1. Define versioned provider-neutral command and receipt schemas for:
   - GitHub issue create/update/comment/label operations;
   - Slack message delivery;
   - managed-AI structured completion.
2. Require organization and project scope plus an idempotency key on every
   mutating command.
3. Add NoxConnect executors that resolve credentials internally and return only
   bounded receipts such as provider ID, URL, state, and timestamps.
4. Reject token-, authorization-, cookie-, and secret-shaped fields at the
   service boundary.
5. Keep provider calls behind queues/outbox where the existing operation is
   asynchronous.

Gate: contract tests, credential non-leakage tests, duplicate-command tests,
executor tests, typecheck, and a local RPC smoke call all pass.

### Milestone 1 result — 2026-09-06

| Dimension | Result |
|---|---|
| Contract | Green: strict version-1 GitHub issue, Slack message, managed-AI command, and bounded receipt schemas added. |
| Isolation | Green at the boundary: recursive credential-shaped field rejection is tested for commands and receipts. Product Worker secret removal is completed in product milestones. |
| Scope | Green: organization and project are mandatory; repository mismatch is rejected before credential resolution. |
| Data | Green: all 83 migrations, including the idempotent capability-run ledger, applied to a fresh local D1 database. |
| Async | Green: repeated identical commands return the stored receipt and do not repeat the provider call; Slack uses the existing durable outbox. |
| Runtime | Green: Functions typecheck and production build passed. |
| Regression | Green: 173 test files / 1,336 tests and OpenAPI normalization check passed. |
| Service call | Deferred to Milestone 2 because Milestone 1 defines the NoxConnect executor boundary; product RPC producers are introduced next. |

## Milestone 2 — Service-owned discovery and configuration

1. Add a versioned `describe()` RPC to each product service with its identity,
   focus, capabilities, required connections, operations, and config metadata.
2. Add service-owned configuration parse/validate/project methods.
3. Make NoxConnect aggregate manifests and expose the existing discovery API.
4. Retain a pinned manifest snapshot so disabled or temporarily unavailable
   services remain discoverable with an explicit state.
5. Keep enablement and connection readiness in NoxConnect; combine those states
   with the service-provided manifest.

Gate: discovery/config API snapshots remain compatible, config revisions still
enforce `If-Match`, invalid service config is rejected by the owning service,
and unavailable-binding tests return a bounded degraded state.

### Milestone 2 result — 2026-09-06

| Dimension | Result |
|---|---|
| Contract | Green: strict version-1 service-manifest and config-validation envelopes reject unknown fields, invalid capability references, and service identity mismatches. |
| Ownership | Green: NoxCue, NoxFeed, and NoxSpot now publish their own manifests; NoxFeed owns validation and normalization of its writable config. NoxTicket follows in Milestone 3 because no Worker exists yet. |
| Runtime state | Green: NoxConnect uses bound manifests when reachable and pinned snapshots only for discovery fallback. Snapshot-backed services are `unavailable`; setup and capabilities are blocked rather than falsely ready. |
| Config safety | Green: service validation composes with NoxConnect's revision/`If-Match` compare-and-swap and safely falls back to the pinned validator during migration. |
| Service call | Green for active extracted services: real local workerd service-binding RPC calls returned NoxCue (5 capabilities) and NoxFeed (4 capabilities) manifests. NoxSpot's retired Worker cannot boot independently because it still requires NoxCue; that dependency is resolved in Milestone 6. |
| Runtime | Green: NoxConnect Functions typecheck, NoxCue typecheck/dry-run bundle, and NoxFeed dry-run bundle passed. NoxSpot's unit runtime passed; its deployable replacement is a Milestone 6 deliverable. |
| Regression | Green: NoxConnect discovery/config/OpenAPI tests, NoxCue tests, NoxFeed tests, and NoxSpot tests passed. Full repository gates are recorded in the milestone commits. |

## Milestone 3 — NoxTicket service extraction

1. Create the local `noxticket-service` Worker repository with generated types,
   observability, tests, and a private RPC entrypoint.
2. Move board stages, feature metadata, spec linking, spec lifecycle, attachment
   policy, and Slack presentation into NoxTicket.
3. Have NoxTicket prepare GitHub issue intents; have NoxConnect execute them and
   return receipts; have NoxTicket commit the product projection.
4. Convert `/api/features`, `/api/specs`, and NoxTicket config routes into thin
   authenticated/scoped adapters.
5. Keep raw GitHub credentials and Slack routing entirely in NoxConnect.

Gate: create/update/close feature, create/update/archive/restore spec, attachment
authorization, workflow config, duplicate receipt, and Slack test flows succeed
through the local public façade and service binding.

## Milestone 4 — NoxCue service extraction

1. Move source config, ingest-key lifecycle, custom metrics, feature catalog,
   project metric selection, digest calculation, dashboard projection, and
   retention policy into NoxCue.
2. Preserve NoxCue's existing incident keying and atomic occurrence deduplication.
3. Move incident title/body/labels and incident state transitions into NoxCue.
   NoxConnect executes the returned GitHub intent and returns a receipt.
4. Remove `ANTHROPIC_API_KEY` from NoxCue. NoxCue prepares a bounded AI request;
   NoxConnect executes it and returns structured output.
5. Convert NoxCue public/admin routes and cron work into façade/RPC calls.

Gate: event ingestion, idempotency, error-group deduplication, incident repeat,
GitHub receipt processing, metrics, dashboard auth/projection, endpoint health,
digest, and no-secret checks all pass locally.

## Milestone 5 — NoxFeed service extraction

1. Move current-work/feed projection, narration gating/deduplication, release
   metadata, fallback summaries, and daily-summary selection into NoxFeed.
2. Keep all prompt and Slack presentation policy in NoxFeed.
3. Route bounded AI requests and Slack message intents through NoxConnect.
4. Convert feed, narration triggers, daily cron, and Slack tests into façade/RPC
   orchestration.

Gate: PR opened, draft-to-ready, merged narration reuse, release-note generation,
daily summary, fallback, duplicate webhook, and separate Slack route flows pass.

## Milestone 6 — NoxSpot service extraction

1. Move the embedded `workers/noxspot-capture` runtime into the NoxSpot
   repository without changing its public capture URLs.
2. Move site configuration, report validation, screenshot retention, telemetry,
   digest aggregation, resolution summaries, share projection, and product audit
   policy into NoxSpot.
3. Keep GitHub and Slack execution in NoxConnect using command/receipt contracts.
4. Keep the private NoxSpot-to-NoxCue telemetry binding; it is an internal
   service capability and carries only a source-scoped ingest credential.
5. Remove the embedded Worker after parity tests prove the relocated service.

Gate: origin-bound config, report, browser error batch, screenshot store/read/
expiry, telemetry, GitHub issue idempotency, Slack delivery, digest, share login,
and project isolation flows pass.

## Milestone 7 — Public façade and documentation compatibility

1. Ensure every product route authenticates and authorizes before invoking a
   product binding.
2. Enforce project-token scope on reads, writes, queues, provider commands, and
   receipt callbacks.
3. Standardize disabled services as `409 service_not_enabled` with service and
   remediation fields; reserve `503 service_unavailable` for binding/runtime
   failures.
4. Update OpenAPI, developer documentation, deployment documentation, and the
   service capability page to distinguish public APIs from private RPC.
5. Add static checks preventing product modules from importing provider clients
   and preventing product Workers from declaring provider secrets.

Gate: OpenAPI checks, authorization matrix, disabled/degraded behavior, project
cross-access denial, documentation tests, and all existing API compatibility
tests pass.

## Milestone 8 — End-to-end certification

1. Start the local product Workers and NoxConnect façade with persistent local
   D1/R2/Queue state and service bindings.
2. Seed two organizations and multiple projects to test tenant and project
   isolation.
3. Exercise actual HTTP and RPC calls for every advertised operation, including
   retries and disabled/unavailable service states.
4. Run all repository tests, typechecks, builds, Wrangler type generation, and
   dry-run bundles.
5. Record the final service health matrix, changes by repository, known risks,
   deployment dependency order, rollback points, and required secret changes.

Gate: every advertised capability is either demonstrated healthy or explicitly
marked blocked with evidence. No deployment or remote mutation is part of this
local migration.

## Commit and rollback discipline

- Commit each milestone independently in each affected repository.
- Do not remove old code until parity tests pass through the new binding.
- Keep adapters reversible for one release by supporting the previous internal
  contract version while emitting only the new version.
- Never copy provider secrets into fixtures, commands, service config, or logs.
- Do not deploy, merge, or push as part of local certification unless separately
  requested.
