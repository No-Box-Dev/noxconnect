# Service Boundary Migration Plan

## Objective

Make NoxHere the single public platform/API, NoxConnect the only
holder/executor of GitHub, Slack, and managed-AI credentials, and NoxTicket,
NoxFeed, NoxSpot, and NoxCue the owners of their product rules, product data,
configuration validation, and provider-neutral output intents.

The public API remains under `https://app.noxhere.com/api/v1` during the split
and may later gain the equivalent `https://api.noxhere.com/v1` hostname without
changing its contract. NoxConnect and product Workers are called through private
Cloudflare service bindings; they are not exposed as additional authenticated
public APIs.

## Target deployment and repository topology

| Repository / deployable | Responsibility | Public exposure | Persistent state |
|---|---|---|---|
| `noxhere` | Web app, public API gateway, sessions, API tokens, tenant/project authorization, service enablement, OpenAPI | `app.noxhere.com` | NoxHere identity/control D1 only |
| `noxconnect` | GitHub/Slack OAuth and webhooks, provider credentials, provider-neutral capability execution, routes, outbox and delivery | Only provider callback/webhook paths forwarded by NoxHere | NoxConnect connection/delivery D1 and queue/DLQ |
| `noxticket` | Features, workflow, specifications and attachments | Private service binding | NoxTicket D1 and R2 |
| `noxfeed` | Feed projections, narration, release notes and summaries | Private service binding | NoxFeed D1 and queue/DLQ |
| `noxcue` | Sources, event ingestion, metrics, incidents and digests | NoxHere-forwarded ingest route plus private RPC | NoxCue D1, queue/DLQ and chart storage |
| `noxspot` | Sites, capture, screenshots, reports and digests | NoxHere-forwarded capture routes plus private RPC | NoxSpot D1, queue/DLQ and screenshot R2 |

Repository separation is an ownership boundary, not a reason to use public
service-to-service HTTP. All internal calls use versioned service-binding RPC.
Each deployable has its own migrations, tests, generated Worker binding types,
observability, and rollback version.

## Boundary rule

NoxHere owns:

- browser/native sessions and project-scoped API token authorization;
- organization membership, project scope, and service enablement;
- the public API contract, OpenAPI, developer documentation, and gateway;
- authentication and authorization before any internal RPC call.

NoxConnect owns:

- GitHub and Slack OAuth, token storage, refresh, and provider clients;
- managed-AI credentials and provider invocation;
- project/repository/identity mapping and provider webhook verification;
- connection routing, outbox, retry, queue, audit, and delivery failures.

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

## Forward-port status — 2026-09-10

The previously certified boundary work has been forward-ported to current main
on `feat/clean-service-split`. This establishes the private NoxConnect
capability executor, service-owned manifests, NoxTicket RPC adapters, standard
service errors, and provider-credential boundary checks without regressing the
current public API.

| Deployable | Repository boundary | Credential boundary | Storage boundary | Current state |
|---|---|---|---|---|
| NoxHere | Target defined | Public authentication remains in the current Pages code | Still shares the legacy database during extraction | Not yet extracted to its own repository/deployment |
| NoxConnect | Private capability Worker implemented | GitHub, Slack and managed-AI execution stays here | Connection/outbox rows still share the legacy database | Code boundary ready; data migration pending |
| NoxTicket | Private `No-Box-Dev/NoxTicket` repository created | No provider credentials or clients | Dedicated `noxticket` D1 and `noxticket-spec-attachments` R2 provisioned with owned migration | Storage PR ready; traffic not cut over |
| NoxFeed | Service branch published | No provider credentials or clients in the product Worker | Demo storage only; feed projections still live in legacy NoxConnect D1 | Policy boundary ready; data/job extraction pending |
| NoxCue | Current upstream forward-ported with private AI RPC | Direct managed-AI credential removed | Still bound to legacy NoxConnect D1/queue | Policy boundary ready; schema/queue extraction pending |
| NoxSpot | Capture service branch published and NoxHere callback fixed | No provider credentials or clients in capture Worker | Still bound to legacy NoxConnect D1/queue; R2 is already product-specific | Runtime boundary ready; config/queue extraction pending |

No production route is switched merely because a repository exists. Cutover is
allowed only after owned schemas are populated, dual-read parity is measured,
and the product-specific queue/DLQ has processed a real staging request.

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

### Milestone 3 result — 2026-09-06

| Dimension | Result |
|---|---|
| Service | Green: a new `noxticket-service` Worker owns its manifest, workflow-config validation, feature intents/projections, spec lifecycle, attachment policy/storage, and Slack message presentation. |
| Connection isolation | Green: the Worker declares only D1 and R2. GitHub mutations are provider-neutral issue intents; NoxConnect resolves the scoped project, executes with its GitHub App credential, and returns a bounded receipt. |
| Public façade | Green with reversible fallback: existing feature/spec/attachment URLs delegate after NoxConnect authentication; old in-process handlers remain only as one-release rollback paths. |
| Scope | Green: every Worker call requires organization/user scope; D1 queries include organization ownership, attachment R2 keys include organization/spec IDs, and a real cross-organization read returned 404. |
| Data | Green: real local workerd RPC exercised spec create/read/update/archive/list, attachment put/get/delete in R2, feature intent preparation, receipt commit, and feature projection. |
| Async/idempotency | Green at the connection boundary: feature commands use the Milestone 1 command ledger and accept `Idempotency-Key`; GitHub create also embeds a lookup marker. No remote GitHub mutation was made during this local-only milestone. |
| Runtime | Green: generated Worker types, strict typecheck, tests, and dry-run bundle passed. |
| Regression | Green: NoxConnect 173 files / 1,338 tests, Functions typecheck, production build, and OpenAPI check passed. |

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

### Milestone 4 result — 2026-09-06

| Dimension | Result |
|---|---|
| Product ownership | Green: NoxCue already owns event validation, incident keying, atomic occurrence deduplication, monitoring, charting, and digest rendering. Incident title/body/labels/repeat copy now also live in NoxCue. |
| Credential isolation | Green: direct Anthropic code and configuration were removed. NoxCue sends a bounded, project-scoped completion command to the private NoxConnect capability Worker. |
| Service call | Green: a real multi-Worker workerd test exercised NoxCue → NoxConnect-capability RPC and rendered the returned text. |
| Provider execution | Green: GitHub lookup/write and managed-AI invocation remain in NoxConnect; NoxCue receives neither credential. |
| Runtime/regression | Green: 12 test files / 69 tests, typecheck, dry-run bundle, incident orchestration tests, connector bundle, and credential scan passed. |

## Milestone 5 — NoxFeed service extraction

1. Move current-work/feed projection, narration gating/deduplication, release
   metadata, fallback summaries, and daily-summary selection into NoxFeed.
2. Keep all prompt and Slack presentation policy in NoxFeed.
3. Route bounded AI requests and Slack message intents through NoxConnect.
4. Convert feed, narration triggers, daily cron, and Slack tests into façade/RPC
   orchestration.

Gate: PR opened, draft-to-ready, merged narration reuse, release-note generation,
daily summary, fallback, duplicate webhook, and separate Slack route flows pass.

### Milestone 5 result — 2026-09-06

| Dimension | Result |
|---|---|
| Product policy | Green: NoxFeed owns actor/release prompts, mandatory output rules, Slack presentation, test messages, and config validation. |
| Connection isolation | Green: the NoxFeed Worker has no GitHub, Slack, or managed-AI provider client or credential binding. NoxConnect owns completion, outbox, Slack routing, and retry. |
| Service call | Green: real workerd RPC generated a NoxFeed prompt and Slack response and returned no credential-shaped data. |
| Runtime/regression | Green: 3 test files / 15 tests and dry-run bundle passed; NoxConnect narrator/outbox regression remains part of the final gate. |

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

### Milestone 6 result — 2026-09-06

| Dimension | Result |
|---|---|
| Relocation | Green: the production `noxspot-api` capture Worker was split from NoxConnect with its Git subtree history and added under the NoxSpot repository's `capture/` package. |
| Ownership | Green: health identifies NoxSpot as runtime owner and the Worker publishes the NoxSpot manifest through private RPC. |
| Isolation | Green for the production capture Worker: no provider client or credential binding. The old `api/` implementation remains explicitly retired and is not a deployment target; it is retained only for migration history. |
| Runtime/service call | Green: 4 test files / 24 tests, dry-run bundle, and a real local manifest/health RPC passed with the private NoxCue dependency wired. |
| Rollback | The embedded NoxConnect copy is intentionally retained until deployment parity; removal is a post-deployment rollback decision, not part of local certification. |

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

### Milestone 7 result — 2026-09-06

| Dimension | Result |
|---|---|
| Errors | Green: disabled products return `409 service_not_enabled` with enable-service remediation; permission denial stays `403`; reachable-state failure stays `503 service_unavailable`. |
| Discovery | Green: bound manifests are authoritative; pinned snapshots remain visible during failure but block setup and capabilities and surface a required runtime health failure. |
| Documentation | Green: OpenAPI and the light developer page explain public façade vs private RPC, credentials, project scoping, runtime source, safe configuration, and error semantics. |
| Static boundary | Green: a repeatable scan rejects provider endpoints and GitHub/Slack/Anthropic credential bindings from all four production product Workers. |

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

### Milestone 8 result — 2026-09-06

| Dimension | Result |
|---|---|
| Full local stack | Green: NoxConnect, its private capability Worker, all four product Workers, RPC proxy, and cron started together. All 90 HTTP/RPC checks passed. |
| Authentication | Green: browser sessions, native access/refresh rotation, sign-out revocation, CSRF rejection, automation-token creation/rotation/revocation, and secret non-disclosure passed. |
| Authorization | Green: organization administration and project tokens remain distinct; cross-project reads, writes, configuration access, and token administration were denied. |
| Service state | Green: live manifests served setup/health/config; disabled products returned `409 service_not_enabled`; unavailable runtime remains a distinct `503 service_unavailable`. |
| Data and ingestion | Green: NoxTicket D1/R2 lifecycles, NoxCue ingestion/idempotency/metrics, NoxSpot report capture, and correctly signed versus invalid GitHub webhooks passed through real local calls. |
| Configuration | Green: revision reads, mandatory `If-Match`, stale-write rejection, compare-and-swap update, restoration, and project discovery passed. |
| Product boundaries | Green: all eight production product source/config roots passed the provider-client and credential-binding scan. Dependency-aware RPC probes passed for NoxTicket, NoxCue, NoxFeed, and NoxSpot. |
| NoxConnect regression | Green: 173 test files / 1,338 tests, Functions typecheck, production frontend build, OpenAPI normalization, and the private capability Worker dry-run bundle passed. |
| Product regression | Green: NoxCue 12 files / 69 tests; NoxFeed 3 / 15; NoxTicket 1 / 3; NoxSpot capture 4 / 24; NoxSpot legacy API 24 / 181; NoxSpot widget 16 / 153. Applicable typechecks and production/dry-run builds passed. |
| Remote providers | Intentionally not run: GitHub installation mutations, Slack delivery, and managed-AI completion require disposable sandbox credentials. Local tests used real boundaries and fake provider executors, never production credentials. |

### Deployment order and rollback

1. Create the NoxTicket remote repository and provision product-owned D1/R2.
2. Deploy the private NoxConnect capability Worker and configure only its
   GitHub, Slack, and managed-AI secrets.
3. Deploy NoxTicket, NoxCue, NoxFeed, and the relocated NoxSpot capture Worker.
4. Add their private service bindings to NoxConnect and run the same health
   probes against a disposable staging project.
5. Deploy the NoxConnect public façade and cron consumers, then verify the
   public discovery, setup, health, and configuration contracts.
6. After one healthy release, remove the in-process NoxTicket fallback and the
   embedded NoxSpot capture copy. Until then, either adapter is a rollback point.

Product Workers need no GitHub, Slack, or managed-AI secrets. Existing provider
secrets must be present only on NoxConnect/the private capability Worker; any
copies in active product Worker environments should be removed after staging
parity succeeds.

### Known transitional items

- NoxConnect remains the public façade and still contains shared orchestration
  and some legacy NoxCue/NoxFeed projection adapters. Provider access is cleanly
  isolated, but deleting these adapters should wait for post-deployment parity.
- The retired NoxSpot `api/` tree still contains its historical provider code;
  it is not an active deployment target. The production `capture/` Worker is
  credential-free.
- The NoxSpot legacy API dependency audit remains at its pre-existing baseline:
  1 critical, 5 high, and 1 low vulnerability. This is not introduced by the
  boundary migration, but should be resolved before reactivating that package.
- NoxTicket currently exists as a standalone local Git repository and needs a
  remote/repository ownership decision before any deployment.

## Commit and rollback discipline

- Commit each milestone independently in each affected repository.
- Do not remove old code until parity tests pass through the new binding.
- Keep adapters reversible for one release by supporting the previous internal
  contract version while emitting only the new version.
- Never copy provider secrets into fixtures, commands, service config, or logs.
- Do not deploy, merge, or push as part of local certification unless separately
  requested.
