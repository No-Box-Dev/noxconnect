# NoxConnect

> **Internal maintainer documentation.** This file is the working reference for maintainers and AI coding agents — it references internal tooling and conventions. If you're getting started with the project, see [README.md](./README.md), [DEPLOY.md](./DEPLOY.md) (self-hosting), and [ARCHITECTURE.md](./ARCHITECTURE.md) (public architecture overview) instead.

## Rules

- **When you add, remove, or significantly change a feature, update the `## Features` section of this file to reflect the change.** This keeps every future Claude Code session (for any team member) aware of what exists.
- **When you add new architecture patterns (new API routes, new shared hooks, new config keys), update the `## Architecture` section.**
- **Code review (`/review-external`)**: Always use the review-external skill at `~/.claude/skills/review-external/SKILL.md`. This runs a two-expert review (Zhipu GLM-5 + Claude) with peer discussion on critical findings. Use it before merging PRs.
- **After merging PRs**: Always check the deploy status (`gh api repos/No-Box-Dev/noxconnect/actions/runs --jq '.workflow_runs[0]'`) and verify it succeeds. If the deploy fails, fix the build immediately. Also check for automated review comments (Gemini, CodeRabbit) on the merged PR and address any issues that landed on main.
- **Migration numbering**: `migrations/0034_pr_merged_by.sql` and `migrations/0034_specs.sql` share the `0034_` prefix (both already applied to production, alphabetical order in Wrangler put `pr_merged_by` first). Do NOT rename either one — wrangler tracks applied migrations by filename in `d1_migrations`, so a rename would make it try to re-apply. New migrations must use `0038+`. Add a lint rule if you touch the migration tooling.

## URLs

- **Live:** https://app.noxhere.com
- **Repo:** https://github.com/No-Box-Dev/noxconnect
- **OAuth Callback:** https://app.noxhere.com/auth/github/callback

## OAuth

- GitHub App client ID (`Iv23l…`) — stored in noxkey at `noboxdev/noxconnect/GITHUB_APP_CLIENT_ID`. Used at BOTH build time (Vite injects it as `VITE_GITHUB_APP_CLIENT_ID` via the `VITE_GITHUB_CLIENT_ID` repo variable, see `deploy-pages.yml`) AND runtime (Cloudflare Pages secret `GITHUB_APP_CLIENT_ID` consumed by `functions/api/auth/callback.js`). Both must reference the same App — a mismatch makes the code exchange fail with "The code passed is incorrect or expired."
- **Do not use the legacy OAuth App** (`Ov23l…`). NoxConnect auth is the GitHub App's user-authorization flow (`Iv23l…`); only that App has install + webhook permissions. An OAuth App client ID used for sign-in cannot be exchanged at the GitHub App callback.
- Cloudflare Pages secrets: `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` (+ `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `ENCRYPTION_KEY`).
- OAuth callback is exposed at `functions/auth/github/callback.js` and handled by the shared implementation in `functions/api/auth/callback.js`.

## Stack

- React 19, TypeScript, Vite
- Tailwind CSS, Lucide icons, Radix UI primitives
- TanStack Query, Zustand (state), React Router
- Cloudflare Pages (hosting + functions + D1)
- Testing: Vitest, Testing Library

## Architecture

### Layout System
Top horizontal nav + content layout.
- `src/components/TopNav.tsx` — Sticky top header with logo, centered nav items, CMD+K search button, rate limit dot, settings icon, user menu. Mobile: extra horizontal scroll row of nav items below the header.
- `src/pages/DashboardPage.tsx` — Renders `TopNav` + the active tab inside an `ErrorBoundary` with lazy-loaded tab modules.

### Tab System
Each tab is a `TabId` (defined in `src/lib/types.ts`). To add a new tab:
1. Add the ID to the `TabId` union in `src/lib/types.ts`
2. Create `src/components/tabs/<Name>Tab.tsx`
3. Add nav item in `src/components/TopNav.tsx` `NAV_ITEMS`
4. Render in `src/pages/DashboardPage.tsx`

Admin uses separately routeable service pages under `?tab=admin&service=<noxconnect|noxticket|noxfeed|noxspot|noxcue>`. `AdminTab` owns the service navigation and NoxConnect core page; optional service pages live in `src/components/admin/pages/` and are lazy-loaded so visiting one service does not load every service's admin bundle. Legacy `section=admin-*` links are translated for compatibility.

### Config System (Hybrid: D1 + GitHub Issues + noxconnect repo)

**Features as GitHub Issues (on `{org}/noxconnect` repo):**
- All GitHub reads and mutations proxy through NoxConnect Pages Functions; the browser has no Octokit client. `src/lib/github-features.ts` exposes `fetchFeaturesFromD1`, `createFeature`, `updateFeature`, `deleteFeature`; each calls `/api/features*` and returns the server's `Feature` shape verbatim.
- Server side: `functions/api/features.ts` (GET/POST) + `functions/api/features/[number].ts` (PATCH/DELETE). Label management (`ensureNoxTicketRepoLabels` in `functions/lib/feature-issues.js`) runs server-side and is cached per org.
- Hooks: `src/hooks/useConfigRepo.ts` — `useFeatures()`, `useCreateFeature()`, `useUpdateFeature()`, `useDeleteFeature()`, `useCleanDoneFeatures()` with optimistic updates.
- Label scheme: feature issues carry BOTH `noxticket` AND `feature` labels. Stages are admin-configurable — the label list comes from `settings.boardStages`, with the first stage as the implicit default (no status label needed). The `backlog` label parks a feature off the board without losing its stage label.
- Owners: Issue assignees. Feature ID: Issue number.
- PATCHes are field-scoped (audit fix): a PATCH only sends the fields the caller actually mutated, so two concurrent PATCHes that touch different fields can both land.
- DELETE nulls out `spec.feature_number` for every attached spec in the same batch so specs don't orphan onto a closed feature.
- "Clean done" bulk action (admin) closes every feature in the last configured stage (`useCleanDoneFeatures`); rows drop off the board.
- CLI: `gh issue list --repo {org}/noxconnect --label noxticket --label feature`

**D1 config (people, settings):**
- API endpoint: `functions/api/config/[key].js` — GET/PUT with `VALID_KEYS` whitelist
- API helpers: `src/lib/config-repo.ts` — `fetch<X>()` / `save<X>()` using `apiGet`/`apiPut`
- Hooks: `src/hooks/useConfigRepo.ts` — TanStack Query hooks with optimistic updates
- To add a new config key: add to `VALID_KEYS` + `DEFAULTS` in `[key].js`, add fetch/save in `config-repo.ts`, add hooks in `useConfigRepo.ts`

**`noxconnect` repo (features as issues):**
- Default repo name is `noxconnect`; users can override via Settings (`settings.noxTicketRepo`)
- Resolved by `src/lib/noxticket-repo-name.ts` (`getNoxTicketRepoName`)
- CLI access: `gh issue list --repo {org}/noxconnect --label noxticket --label feature`

### Backend setup (TypeScript + zod)
New backend code (Pages Functions + cron) is written in **TypeScript**, not JS. D1 access uses the native binding (`context.env.DB.prepare(...).bind(...)`, `DB.batch([...])`) — the same proven pattern as `prs.js` / `issues.js`; read `.results` off each batch entry. (Drizzle was trialed and removed — its `db.batch([db.all(sql\`...\`)])` path returned no rows for our `json_each` aggregations in the D1 runtime, and nothing else used it.) External request input is validated at the boundary with `validate(schema, input)` from `functions/lib/validate.ts` (zod) — it returns a 400 `Response` on failure that the handler returns directly. Type-check the backend with `npm run typecheck:functions` (`tsconfig.functions.json`, also wired into CI). Existing hand-rolled `.js` endpoints migrate to this pattern opportunistically; **`functions/api/engineer-stats.ts`** is the reference for an aggregation read and **`functions/api/assign.ts`** for a validated write (zod).

### API Routes (Cloudflare Pages Functions)
- `GET/POST /api/cues/sources/:sourceId/features` and `PUT/DELETE /api/cues/sources/:sourceId/features/:featureKey` — Admin-only NoxCue custom-feature registry. Standard features are code-owned; custom keys must use `custom.*` and be registered before ingest. Linked sources resolve the shared project catalog, while unlinked sources resolve an isolated source catalog. Paused/deleted names are handled by NoxCue as bounded `UNREGISTERED_FEATURE` errors and never create metrics implicitly.
- `GET/POST /api/cues/sources/:sourceId/custom-metrics` and `PUT/DELETE /api/cues/sources/:sourceId/custom-metrics/:metricKey` — Admin-only custom activity registry, separate from feature health. Each accepted idempotent event is aggregated by NoxCue into a cumulative total and total per registered user. Unknown names become `UNREGISTERED_METRIC` errors and never create definitions implicitly.
- `POST/DELETE /api/spots/shares*` — Admin control plane for one password-protected external portal per NoxSpot project. `GET/POST/DELETE /api/public/project-shares/:slug*` is the bearer-free data/login/logout surface; it authenticates with a project-scoped HttpOnly cookie backed by hashed D1 session tokens. Public responses are read-only, `no-store`, and `noindex`.
- `GET /api/integrations/setup` — Versioned, resumable agent onboarding plan for GitHub, Slack, project routing, NoxFeed, NoxConnect, NoxCue, and NoxSpot. Its action objects distinguish automatable API work from human OAuth consent. `GET/PATCH /api/integrations/slack/routing` provides safe partial organization channel updates; `GET/PUT /api/projects/routing[/:projectId]` owns explicit project enablement, repository grouping, and project destinations; `POST /api/integrations/slack/test` verifies a named route. Public AI discovery lives at `/llms.txt`, `/openapi.json`, and `/docs/ai-setup.md`.
- `GET /api/slack/oauth/handoff` — Signed, ten-minute browser bridge used by agent-initiated Slack OAuth. It validates the HMAC state, sets the CSRF cookie in the human's browser, then redirects to Slack; middleware deliberately exempts only this signed route and the existing callback from bearer auth.
- `functions/api/engineer-stats.ts` — Per-member counts for the Engineers tab, aggregated server-side in one `DB.batch` (replaces client-side downloading of all PRs/issues). Returns `{ openPRs, reviewing, approvalsGiven, mergesOfOthers, assignedIssues, lifetimePRs, prsLast4Weeks, issuesClosed }` keyed by login. `reviewing` is *requested* reviewers on open non-draft PRs (from `pull_requests.requested_reviewers_json`). `approvalsGiven` reads the `events` table (`type='github:pr:review:approved'`) and excludes self-approvals by comparing `payload_json.review.author` with `payload_json.pr.author`. `mergesOfOthers` reads `pull_requests.merged_by` (populated by the `pull_request.closed` webhook — migration `0034_pr_merged_by.sql`) and excludes self-merges (`merged_by != author`); historical merges before that migration stay `NULL` until an admin per-PR backfill runs.
- `functions/api/config/[key].js` — D1 config CRUD (see Config System above)
- `functions/api/sync.js` — Cursor-based GitHub-to-D1 sync: GET checks staleness (MIN across all resources), POST accepts `?cursor=repoName&force=true` for one-repo-at-a-time sync
- `functions/api/sync-events.js` — Admin-only cursor-batched backfill of the `events` table. POST with no cursor returns the active repo list; subsequent POSTs with `?cursor=<repo>` run `reconcileRepoEvents` per repo (30-day lookback). 403s for non-admin callers.
- `functions/api/op-failures.js` — Admin-only GET. Lists recent rows from the `op_failures` table (errors swallowed by `waitUntil`). Capped at 100 rows per call, default 25. 403s for non-admin callers.
- `functions/api/llm-settings.ts` — Admin-only GET/PUT for per-org managed-AI mode (`ai_settings`, migration `0061_managed_ai.sql`). Customers can enable or disable the server-owned Anthropic service but cannot supply keys, endpoints, or models. `functions/lib/llm-config.js resolveLlmConfig(env, orgId)` is the single source for the managed route and fails closed when the mode lookup or `ANTHROPIC_API_KEY` is unavailable.
- `functions/api/webhook.js` — GitHub webhook receiver (HMAC-SHA256 verified, handles `issues`, `pull_request`, `member` events)
- `functions/api/assign.ts` — POST: update issue assignees on GitHub + D1 (`{ repo, issue_number, assignees }`)
- `functions/api/issues.js`, `functions/api/prs.js`, `functions/api/repos.js`, `functions/api/members.js` — cached data endpoints
- `functions/api/prs.js` and `functions/api/prs/[repo]/[number].js` expose `head_sha` from `pull_requests`. All PR sync and webhook upsert paths persist `pull_request.head.sha` (migration `0045_pr_head_sha.sql`) so review clients can invalidate results when new commits land.
- `functions/api/repos/acknowledge.ts` — Admin-only POST. Marks one or more repos as reviewed by setting `repos.acknowledged_at` (`COALESCE` keeps first-acknowledgment timestamp). Called by the NewRepoBanner's Dismiss-all, and by the Settings → Newly detected section's Track / Mark draft / Acknowledge all buttons (Track + Mark draft also flip the `projects.archived` flag through the existing `/api/projects/:id/archive` endpoint).
- `functions/api/specs/*.ts` — CRUD for the manual Specs feature (schema seeded by migration `0034_specs.sql`, later unified into Features via `0037_spec_feature_number.sql`). Specs belong to a Feature via `feature_number` (or Unfiled when null); they live entirely in D1 — no GitHub round-trip. GET/POST on the collection and PATCH on the single-resource endpoint are open to any authenticated org member; the `/archive` endpoint (POST=archive, DELETE=unarchive) is **admin-gated via `getCtx(context).isAdmin`**. Link sanitizer (`sanitizeSpecLinks` in `functions/lib/spec-links.ts`) is shared with the Feature `SpecLink[]` field. The retired `spec_folders` endpoints + `folderId` DTO field were removed in a post-audit cleanup — the `spec_folders` table + `specs.folder_id` / `specs.legacy_folder_name` columns still exist in D1 as frozen historical data but no code reads them.
- `functions/api/auth/callback.js` — OAuth callback. Also persists the GitHub App `refresh_token` into the `oauth_tokens` table (keyed by SHA-256 of the access token).
- `functions/api/auth/exchange.js` — One-time exchange code → access token (immediately after callback redirect).
- `functions/api/auth/refresh.js` — POST `{ token }` (the expired access token). Looks up the matching `oauth_tokens` row, calls GitHub's `grant_type=refresh_token` flow, rotates both tokens, returns the new access token. Used by `apiFetch` and `fetchUser` to silently recover from 401s so users stay signed in for the refresh-token TTL (~6 months) instead of the 8-hour access-token TTL.
- `functions/_middleware.js`, `functions/api/_middleware.js` — auth middleware (webhook route bypasses auth)
- `functions/lib/github-sync.js`, `functions/lib/db.js`, `functions/lib/crypto.js` — server-side helpers

### NoxSpot public capture Worker

`workers/noxspot-capture/` is a separate NoxConnect-owned Cloudflare Worker for
the anonymous cross-origin NoxSpot capture surface. It is intentionally not a
Pages Function and never uses NoxConnect browser bearer tokens. Versioned routes
live under `/api/spots/public/v1`; legacy `/sites/:id/config`, `/report`,
`/errors`, `/r2/*`, `/v1/widget.js`, and `/widget/:id.js` remain compatibility
aliases during cutover. The Worker reads `spot_sites`, enforces enabled origin
allowlists, streams bounded JSON, stores temporary screenshots in R2, applies
IP and per-site limits through a sharded SQLite Durable Object, and sends a
versioned `spot_create_github_issue` task through `noxconnect-tasks`. The cron
queue consumer remains the only GitHub/Slack provider-delivery owner. It calls
the NoxSpot `noxspot-api` Worker through the private `NOXSPOT_RESPONSE` service
binding for versioned issue and Slack response construction. NoxSpot owns all
issue body/label and Block Kit presentation; NoxConnect validates the contract,
resolves authoritative credentials/routes, and owns delivery/retry receipts.
A daily scheduled handler deletes screenshots older than 90 days.

The Worker has its own `package.json`, generated `worker-configuration.d.ts`,
Wrangler JSONC config, Workers-runtime tests, CI job, and deploy step. Run it
with `npm --prefix workers/noxspot-capture test` and validate deployment with
`npm --prefix workers/noxspot-capture run build`.

### Sync System
Batched cursor-based sync: `triggerSync()` (in `src/lib/github.ts`) calls `POST /api/sync` in a loop — first call runs `syncInit` (config migration, repos, members), subsequent calls sync one repo at a time via cursor until `done: true`. This prevents Cloudflare Function timeouts with many repos. `triggerSyncWithProgress()` wraps this with a callback for UI progress updates (used by Issues and PRs tab sync buttons). Staleness checked via `useSyncStatus()`, triggered via `useTriggerSync()` (both in `src/hooks/useGitHub.ts`).

Key server functions in `functions/lib/github-sync.js`:
- `syncInit(db, token, orgId, orgLogin)` — migrate config, sync repos + members, return repo names
- `syncRepo(db, token, orgId, orgLogin, repo, force)` — sync PRs + issues for ONE repo
- `upsertIssue(db, orgId, repo, issue, closedBy?)` / `upsertPR` / `upsertMember` / `removeMember` — single-entity upserts used by webhook handler. `upsertIssue` accepts optional `closedBy` param; uses `COALESCE` to preserve existing `closed_by` when not provided
- `upsertDiscoveredRepo(db, orgId, repoName)` + `applyNewRepoExcludePolicy(db, orgLogin, names)` — used by the `installation_repositories.added` webhook to insert the `repos` row with `discovered_at` in real-time (so the NewRepoBanner doesn't wait for the next 30-min cron) and apply the auto-exclude policy.

### Newly-discovered repos (banner + policy)
Every repo row carries `discovered_at` (stamped on first INSERT, preserved via `COALESCE` on every subsequent reconcile) and `acknowledged_at` (set by `POST /api/repos/acknowledge`, NULL = "admin hasn't reviewed yet"). Migration `0030_repos_discovery.sql` backfills both for pre-existing rows so the banner doesn't shout about every repo the moment this ships.

Surfaces:
- **NewRepoBanner** (`src/components/NewRepoBanner.tsx`) — top-of-dashboard alert for admins listing unacknowledged repos. Dismiss-all is org-wide (acknowledges every listed name in one call). Per-admin dismissal is intentionally out of scope — a join table would be needed.
- **TopNav dot** — small `bg-accent` dot on the settings gear when an admin has any unacknowledged repos. Always-on signal; the banner is the one-shot per-batch nudge.
- **Settings → Newly detected** (`NewReposSection` in `SettingsTab.tsx`) — per-row Track / Mark draft / Acknowledge all. Deep-linked from the banner via `?focus=newRepos` (highlight fades and the param is cleared after 2.5s).

Auto-include vs. auto-exclude policy (`settings.newRepoDefault`, default `include`): when set to `exclude`, every newly-discovered repo is also platform-archived in the `projects` table (`projects.archived = 1`, id `proj_<orglogin>_<repo>`.toLowerCase()) so it stays out of every active scope until an admin clicks Track. The policy is applied by `syncRepos` (cron path) AND by the `installation_repositories.added` webhook (real-time path) — both use `applyNewRepoExcludePolicy`. Acknowledging the repo only flips `acknowledged_at`; the draft state is moved separately via the existing `/api/projects/:id/archive` endpoint, so Track / Mark draft go through two calls.

**Live Activity events (the `events` table — feeds Engineers tab's Live activity)** has the same three-way redundancy as PRs/issues:
1. **Webhooks** — `functions/lib/events.js storeEvent()` inserts rows in real time from `pull_request`, `issues`, `pull_request_review`, `push`, `release`, `repository`, and `installation*` payloads. `slimPayload` for `issues` carries `issue.number/title/state/author` forward so downstream dedup can match by number.
2. **Cron reconcile (30 min)** — `cron/src/reconcile.js` calls `reconcileRepoEvents` per active repo with a 48h lookback. Catches webhook deliveries missed during deploys or provider outages.
3. **Manual admin backfill** — `POST /api/sync-events` triggered from Settings → Live Activity Backfill. Same `reconcileRepoEvents` helper with a 30-day lookback.

`reconcileRepoEvents` (in `functions/lib/event-reconcile.js`) is the single source of truth for "what's missing in events for this repo." Three sources, in order: (1) `pull_requests` → `github:pr:opened|closed|merged`, (2) `issues` → `github:issue:opened|closed`, (3) `GET /repos/{owner}/{repo}/events` → reviews/pushes/releases (events GitHub doesn't expose as webhooks-into-D1). Idempotent via deterministic `delivery_id` of `reconcile:<org>:<repo>:pr-<n>:<kind>` / `issue-<n>:<kind>` / `gh-event-<id>` + the `events.delivery_id UNIQUE` constraint. Inserted rows are passed to all three narrators in parallel (`Promise.allSettled`): `narrateEvent` + `narrateReleaseNotes` (gated by `NARRATABLE_TYPES = ['github:pr:merged']`) and `narratePrOpened` (gated by `NARRATABLE_TYPES_OPENED = ['github:pr:opened']`), so backfilling closes/reviews/pushes doesn't trigger LLM spend but backfilled opens still land in the Opened feed.

The cron treats service-specific synchronization as isolated work. In particular, an optional NoxTicket repository that is missing or misconfigured is logged but cannot abort the active-repository loop that restores NoxFeed PRs, issues, events, and release notes.

### Narration (three voices, one PR lifecycle)
Every narratable event produces downstream `events` rows via functions in `functions/lib/narrator.js`. Same PR appears in all three feeds as it moves through its lifecycle — one LLM call at open time, zero at merge time:
- `narratePrOpened` → `type='pr_narrative'`, `source='pr-opened-narrator'` — the **Opened feed** (first-person "just opened this PR" post, `PR_OPENED_SYSTEM` prompt). Fires on `github:pr:opened`.
- `narrateEvent` → `type='narrative'`, `source='narrator'` (fresh LLM) or `source='narrator-reused'` (reused text) — the **Posts feed**. Fires on `github:pr:merged`.
- `narrateReleaseNotes` → `type='release_notes'`, `source='release-notes'` — the **Release-notes feed**. Fires on `github:pr:merged`.

Opened and merged narrations store two views from the same LLM call: the existing first-person `summary` and `events.technical_summary` (migration `0046_event_technical_summary.sql`). The technical view is always exactly three simple-English lines: **What it does**, **How it works**, and **What it touches**. `parseNarrativeOutput` accepts the requested JSON pair, preserves plain-text output from older/custom providers, and deterministically creates the three technical lines when the model output is malformed or unavailable. Merge-time reuse carries both views forward from `pr_narrative`; an older opened row without `technical_summary` gets a deterministic merge-time fallback.

**Reuse-text branch (Posts feed only)** — `narrateEvent` calls `findExistingPrNarrative` first. If a `pr_narrative` row exists for this PR (owner_id + repo + pr_number), it REUSES the `summary` verbatim and skips the LLM call — the merged row carries `model='reused:<original-model>'` and `source='narrator-reused'`. `narrateReleaseNotes` does NOT reuse — it ALWAYS calls the LLM with the structured `RELEASE_NOTES_SYSTEM` prompt, because reused chat-voice text read like a Post inside the Release-notes feed. Consequences:
- **Cost:** Posts feed = 1 LLM call per PR lifecycle (opened → reused at merge). Release notes = 1 additional LLM call per merge. Orgs using both feeds spend 2 calls per merged PR, orgs using only Posts spend 1.
- **Fallback path (Posts):** `findExistingPrNarrative` returns null when the `pr_narrative` row has `model='fallback'`, so `narrateEvent` falls through to a fresh LLM call rather than propagating the raw PR title.

All three narrators share the org's LLM provider/model — they call `resolveLlmConfig(env, orgId)`. The only thing that diverges between them is the system prompt. All run at every trigger point: webhook (`TASK.NARRATE_PR_OPENED` on opens, `TASK.NARRATE` + `TASK.RELEASE_NOTES` on merges), cron queue handler, reconcile loop, `/api/projects/:id/backfill-prs`. Each insert is idempotent via a partial UNIQUE INDEX on `(owner_id, repo, type, pr_number)` — migrations `0033_narration_dedup_by_pr.sql` for `narrative + release_notes` and `0035_narration_dedup_pr_opened.sql` extending it to include `pr_narrative`.

When admins use Posts Backfill with "rewrite posts written on a different model," the same flow refreshes the matching release-notes row in lockstep — `findRenarrateTargets` returns BOTH `narrative` and `release_notes` types and dedupes by `trigger_event_id`, then `renarrateFallbacks` deletes both rows and re-runs both narrators.

### NoxConnect (central organization setup)
NoxConnect is the central organization setup for the shared GitHub App and Slack app used by NoxCue, NoxFeed, NoxSpot, and NoxTicket. The Setup tab (`integrations`) derives onboarding and per-feature readiness from the real connection state returned by `GET /api/integrations/connections`; it does not persist a separate completion checklist. GitHub is the required foundation, Slack is optional until a feature needs delivery, and organizations with incomplete GitHub setup land on Setup automatically unless they followed an explicit tab link. The client shares this contract through `useNoxConnect()` and the `integrations-status` TanStack Query cache.

`GET /api/integrations/connections` is the versioned central NoxConnect API used by current clients. It preserves the detailed setup/feature status and adds a credential-free `connections` provider registry with normalized status, capabilities, account metadata, and allowed actions. Start providers through `POST /api/integrations/connections/:provider/start`; disconnect through `POST /api/integrations/connections/:provider/disconnect`. GitHub and Slack are the initial providers. GitHub uninstall remains provider-managed and returns a `409 provider_managed_disconnect` response with its management URL. The older `/api/integrations/status`, `/api/slack/oauth/start`, and `/api/slack/disconnect` routes remain compatibility endpoints. Provider additions belong in `functions/lib/integration-connections.js`, so onboarding clients do not need a new top-level API for every service.

Admins complete Slack OAuth once per organization, then configure shared fallback routing under `settings.slack`: `fallbackChannelId`, `noxCueChannelId`, `noxTicketChannelId`, `postsChannelId`, and `releaseNotesChannelId`. Explicit enablement, ownership, and destinations are NoxConnect core data in `project_routing_settings`, `project_repositories`, and `project_slack_routes` (migration `0067_core_project_routing.sql`). Auto-created repository mirror rows are disabled by default and never route product traffic until an admin enables one as a real project. One enabled project owns many repositories, every repository has at most one project, and named routes currently cover NoxFeed Posts, NoxFeed Release Notes, and NoxCue digests. `GET /api/projects/routing` returns the complete model; `PUT /api/projects/routing/:projectId` validates ownership, workspace-project isolation, and Slack access before replacing the project's enabled state, assignments, and routes atomically. Empty project destinations use the service's organization route. NoxCue source destinations and NoxSpot site destinations remain explicit source overrides. The bot token remains encrypted; routing tables store only public connection and channel IDs.

- Helper: `functions/lib/slack.js` — `resolveSlackInstall(env, orgId)` decrypts the bot token; `resolveSlackChannels(db, orgId)` reads all public routing IDs; `resolveSlackRoute(channels, service, siteChannelId?)` applies service/site → organization-fallback precedence; `postSlackMessage(token, channelId, payload)` calls `chat.postMessage`; `listSlackChannels(token)` paginates `conversations.list`; `exchangeOAuthCode({...})` swaps the OAuth code for the bot token + team metadata.
- Endpoints: `POST /api/slack/oauth/start` (admin, returns Slack authorize URL + sets CSRF cookie), `GET /api/slack/oauth/callback` (middleware-bypassed; verifies cookie, exchanges code, persists install, redirects to `/?tab=integrations&slack=ok`), `GET /api/slack/status`, `GET /api/slack/channels` (admin), `POST /api/slack/disconnect` (admin), `POST /api/slack/test` (admin; posts a sample to a given channel).
- Routing: `functions/lib/project-routing.ts` is the core repository/project/destination resolver. NoxFeed resolves `rawEvent.repo` through it before using the default Posts or Release Notes route. NoxCue resolves source override → linked-project route → organization NoxCue route → fallback. NoxTicket uses its organization route; NoxSpot resolves site override → fallback. Slack messages are staged in `delivery_outbox`; delivery failures do not block the in-app or GitHub source of truth.
- Block Kit: merged PRs produce one Slack message containing the chat-style Post
  with avatar first, followed by a divider and the code-fenced Release Note,
  with one "View PR" button at the end. NoxFeed owns this composition through
  `NOXFEED_RESPONSE`; NoxConnect supplies both stored summaries and owns the
  single outbox delivery/receipt. Release-note text is sanitized for embedded
  triple-backticks so the wrapping fence cannot be closed early.
- Bot scopes: `channels:read`, `groups:read`, `chat:write`, `chat:write.public`, `links:read`, `links:write` (the `chat:write.public` scope lets the bot post to public channels without being invited; `links:*` powers the unfurl handler below). Private channels require manual invite of the bot.
- Provisioning: `slack-app-manifest.json` is the source of truth for the shared Slack app. `npm run slack:create` provisions it and `npm run slack:push` updates it via Slack's Manifest API; both use a temporary `SLACK_CONFIG_TOKEN`, while push also uses `SLACK_APP_ID`. The resulting `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` must be stored as Cloudflare Pages secrets. See `DEPLOY.md` for the full flow.

**Link unfurls** — `functions/api/slack/events.js` handles the Slack Events API `link_shared` event so `app.noxhere.com` URLs pasted into Slack auto-expand into rich Block Kit cards (the same UX GitHub's app has). Three URL shapes unfurl: `/prs/{repo}/{n}` (PR title + author + draft/merged/closed/open state), `/issues/{repo}/{n}` (issue title + assignee + labels), and `/?tab=sprint&f={n}` (feature title + owners + kanban stage). Anything else falls through and Slack renders the raw URL. Endpoint is middleware-bypassed (auth is the Slack signing secret, not a bearer token); every request is verified via HMAC-SHA256 (`verifySlackSignature` in `slack.js` — 5-minute replay window). Data comes straight from D1 (`pull_requests`, `issues`, `features`), so unfurls reflect the last-webhook / last-sync state instantly. The unfurl work runs on `waitUntil` (Slack wants a fast ack); failures land in `op_failures` once the org is resolved. **Provisioning:** set the `SLACK_SIGNING_SECRET` Cloudflare Pages secret (Slack app → Basic Information → App Credentials → Signing Secret), then in Slack app admin: Event Subscriptions → **Request URL** = `https://app.noxhere.com/api/slack/events` (verifies via the `url_verification` handshake), and under **App Unfurl Domains** add `app.noxhere.com`. Existing installs from before the `links:*` scopes were added will stop unfurling until an admin re-runs Connect Slack (Slack scope additions require a re-consent).

### Webhooks
Real-time updates via GitHub org webhooks. Endpoint: `POST /api/webhook`. Verified with `GITHUB_WEBHOOK_SECRET` env var (HMAC-SHA256). Handles `issues`, `pull_request`, `member` events. On `issues.closed`, captures `sender.login` as `closed_by`. Setup instructions shown in Settings UI. Requires manual webhook creation in GitHub org settings (no `admin:org_hook` scope needed).

### Durable background work (Queues)
Slow webhook follow-up work (narration, install bootstrap, repo backfill) runs on the **`noxconnect-tasks`** Cloudflare Queue instead of `context.waitUntil` (which has no retry and is lost on failure). `functions/api/webhook.js` is the **producer** (`TASK_QUEUE` binding) via `enqueueTask` in `functions/lib/tasks.js` — message contract in `TASK`. The **consumer** is the cron Worker's `queue()` handler (`cron/src/index.js`), which dispatches by type to the same helpers, with retries + a dead-letter queue (`noxconnect-tasks-dlq`); terminal failures (after `MAX_DELIVERIES`) are recorded to `op_failures`. `enqueueTask` never throws into the webhook — a missing binding or send error is recorded to `op_failures` so the response still returns 200. **Provisioning:** `wrangler queues create noxconnect-tasks` + `noxconnect-tasks-dlq` before deploy; consumer needs `ANTHROPIC_API_KEY` for narration in addition to the GitHub App secrets.

### Event retention (R2 archival)
The `events` table is bounded by a daily sweep in the cron Worker (`cron/src/archive-events.js`, gated to the 03:00 UTC ticks). Rows older than `RETENTION_DAYS` (90) are written to the **`EVENTS_ARCHIVE`** R2 bucket as date-partitioned NDJSON, then deleted from D1 in capped batches (archive-then-delete; idempotent). Manual trigger: `GET /__archive-events` on the cron Worker. **Provisioning:** `wrangler r2 bucket create noxconnect-events-archive` before deploy.

### GitHub Data Hooks (`src/hooks/useGitHub.ts`)
TanStack Query hooks for live GitHub data: `useOrgs`, `useRepos`, `useOpenPRs`, `useOpenIssues`, `useClosedIssues`, `useMergedPRs`, `useAllPRs`, `useAllIssues`, `useOrgMembers`, `useSyncStatus`, `useTriggerSync`, `useTriggerFeatureSync`, `usePaginatedIssues`, `usePaginatedPrs`, `useIssueLabels`, `useIssueStats`, `usePRStats`, `useEngineerStats`, `useEngineerActivity`, `useIssueDetail`, `usePrDetail`, `useIssueBody`, `usePrBody`, `useUpdateIssueAssignees`, `useUpdateIssueState`, `useUnacknowledgedRepos`, `useAcknowledgeRepos`, `useActiveMembers`, `useGhTeamMemberships`, `useRateLimit`, `useMe`, `useIsAdmin`, `useExcludedMembers`, `useExcludedRepos`.

### Shared UI Components
- `src/components/ui/SearchableSelect.tsx` — Reusable portal-based searchable single-select dropdown. Props: `value`, `onChange`, `options: {value, label}[]`, `placeholder`, `className`. Includes ARIA attributes, keyboard navigation (Escape/Arrow/Enter), auto-flip positioning, scroll/resize repositioning. Used for repo dropdowns in Issues and PRs tabs.
- `src/components/Toaster.tsx` — The single site-wide error surface, rendered once per top-level branch in `App.tsx`. Listens on the `ut:error` window event and renders stacked, auto-dismissing (8s) toast cards bottom-right with a status badge + dismiss button (caps the stack at 4, dedupes identical message+status). `toast-in` keyframes live in `src/index.css`.

### Error Surfacing (the `ut:error` bus)
All API failures must reach the user. `broadcastError(message, status?)` in `src/lib/api.ts` dispatches a `ut:error` CustomEvent that `Toaster` consumes. Every write goes through the shared `apiGet/apiPut/apiPost/apiPatch/apiDelete` helpers — `handleResponse` broadcasts on every non-OK response, so any code path using these helpers surfaces errors automatically. **Do not bypass the helpers with raw `apiFetch`/`fetch` for mutations** — that re-creates the silent-failure gap. The deliberate exceptions are login errors (routed to the full-screen `authError` UI in `App.tsx`, not a toast) and `BoardStagesSection` (renders 409 stage-orphan details inline because a toast can't show the "move them first" list).

### Auth

GitHub App user access tokens expire after ~8 hours, but NoxConnect keeps the browser session alive via the rotating refresh token stored encrypted in `oauth_tokens` (normally ~6 months). `refreshAccessToken` in `src/lib/api.ts` uses the Web Locks API to serialize refresh across tabs, reuses a token another tab already rotated, and treats only a confirmed refresh 401 as terminal; network/5xx refresh failures preserve the stored session. Browser and native clients send the user token only to NoxConnect APIs; NoxConnect performs GitHub calls and surfaces 401/429 responses through the shared refresh-and-retry path. Never clear `ut_token` for a 401 from an older token when localStorage already contains a newer one.
- `useAuth()` returns `user` (with `login`, `avatar_url`, `name`), `selectedOrg`, `isLoading`, `loginWithOAuth()`, `logout()`, `setSelectedOrg()`
- **OAuth only.** PAT/`loginWithToken` was removed — the login page only renders "Sign in with GitHub" which redirects to the GitHub App's user-authorization flow. The dev-mode escape hatch (`VITE_DEV_TOKEN` / `VITE_DEV_ORG`) still works for local development. Build-time requirement: `VITE_GITHUB_APP_CLIENT_ID` must be set or `getOAuthLoginUrl()` throws — deploy workflow maps it from the `VITE_GITHUB_CLIENT_ID` repo variable.
- Dev mode: `VITE_DEV_TOKEN` / `VITE_DEV_ORG` env vars for local development
- Per-user features filter by `user.login`
- **Refresh-token rotation:** GitHub App user-to-server access tokens expire after 8 hours. The callback persists the `refresh_token` server-side in `oauth_tokens` (encrypted, keyed by SHA-256 of the access token). `src/lib/api.ts apiFetch` and `src/lib/github.ts fetchUser` intercept 401s by POSTing the expired token to `/api/auth/refresh`, which uses the stored refresh token to obtain a new pair and updates `localStorage.ut_token`. Concurrent 401s coalesce on a single in-flight refresh promise. If refresh fails (refresh-token expired or revoked) the row is deleted and the existing force-logout path runs. The refresh token rotates on every call — old tokens are invalid as soon as a new pair is issued.

## Features

- **Global NoxFeed search** — `GET /api/search?q=...` searches people, pull requests, issues, features, posts, and release notes for the authenticated organization in one batched D1 request. Results share a ranked typed shape for Spotlight-style native clients.

### NoxConnect setup (`integrations` tab, labelled Setup)
The organization onboarding surface shows the required GitHub connection, optional shared Slack connection, readiness cards, and service-specific channel routing for NoxFeed, NoxSpot, NoxCue, and NoxConnect. GitHub unlocks NoxFeed and NoxSpot; a NoxCue source plus Slack delivery makes NoxCue ready. Connection and feature states are derived server-side by `/api/integrations/status`, which returns operational metadata and public channel IDs but never credentials.

The same setup is API-first for AI agents. `/api/integrations/setup` reports dependencies, completion state, executable actions, and human-only OAuth handoffs. Channel discovery, partial routing, route tests, provider disconnects, NoxSpot sites, and NoxCue source/key/metric setup are all documented in the public OpenAPI contract. Agents can discover it through `/llms.txt`; provider secrets never enter the contract.

### NoxCue feature health

NoxCue has eight versioned auth standards (`auth.signup`, `auth.login`, password reset, email verification, OAuth/SSO, MFA, session refresh, and logout) plus an admin-governed `custom.*` catalog. Migration `0070_noxcue_feature_catalog.sql` stores project/source definitions and expands `cue_feature_results` with standard/custom classification, the registered user-impact message, and the bounded actual technical error. NoxConnect Admin → NoxCue is the sole registration UI: it displays the effective scope, supports register/edit/pause/delete, and shows standard and custom health together. A failure is always a critical incident and posts immediately; later success is evidence but does not automatically declare recovery.

NoxSpot site configuration is organization-scoped in `spot_sites` (migration
`0050_noxspot_sites.sql`). It stores project/widget/channel references only;
GitHub and Slack credentials continue to come from the shared NoxConnect
installation records. NoxSpot has no product tab: its complete management
surface lives in Admin -> NoxSpot. Admins manage sites, installation snippets,
appearance, reporter mode, automatic errors, enabled origin environments,
environment overrides, ordered report-form blocks, and per-site Slack routing.
The cron Worker posts one idempotent daily NoxSpot summary per site to that
same Slack route. Admins can enable or disable it inside the site's Slack
delivery panel. At 00:00 UTC it lists issues filed and solved during the
previous 24-hour UTC window without truncating either list, links each item, attributes it to the
captured submitter, and explains the closing pull request when one is linked. For a closing PR with
a meaningful description, one batched managed-Anthropic pass writes a short plain-language fix
summary (target Flesch Reading Ease 80-90); missing or unusable descriptions fall back to the PR title.
When that project has an enabled external stakeholder portal, the same Slack message also links to
its password-protected read-only page.
NoxSpot owns the concise, plain-language Slack presentation through the private
`NOXSPOT_RESPONSE` service binding; NoxConnect owns data matching, routing,
outbox persistence, queueing, and retries.
Each project can also expose one external stakeholder portal from its NoxSpot
site card. The portal uses an opaque URL plus a PBKDF2-hashed password, revokes
sessions on password rotation, and shows only that project's NoxSpot-labelled
issues in simple Open and Solved groups. Visitors can filter both groups by a
submitter list derived from the captured issues. Submitter attribution always
comes from NoxSpot's captured reporter data, never from the bot account that
created the GitHub issue. Each issue expands to its captured image, title,
description, and submitter. A solved issue shows related NoxFeed
post/release data as the card's primary content, with the original issue and
capture details beneath it. Issues sharing a closing PR are grouped under one
resolution so its NoxFeed post and release notes are not repeated. The
resolution falls back to the PR whose
`Closes`/`Fixes`/`Resolves` reference names it, and finally to its closure date.
Screenshot bytes are served only through the authenticated portal.
The screenshot handler streams from the private `NOXSPOT_RESPONSE` service
binding first and retains the shared R2 binding as a resilience fallback.
External visitors never receive GitHub/NoxConnect credentials and cannot edit,
review, assign, or change state.
Environment and block edits are saved atomically so renamed environments cannot
leave stale block scopes. Supported block types are validated against the
widget renderer. Site changes write actor-scoped audit rows through migration
`0056_noxspot_config_audit.sql`; site deletion removes its screenshot prefix
before deleting configuration while leaving canonical GitHub issues intact.

### Posts feed (`posts` tab — Opened / Merged / Release notes + Social / Technical toggles)
The feed tab renders one of three views via a top toggle (`FeedModeToggle` in `PostsTab.tsx`): **Opened** (first-person "opened a PR" posts, `FeedMode = "opened"`), **Merged** (first-person merge posts) or **Release notes** (structured release notes). Opened and Merged also expose a local **Social / Technical** toggle: Social renders `events.summary`; Technical renders the stored three-line `events.technical_summary`. Switching presentation does not change the query or refetch the feed. Release notes keep their existing structured view and hide the secondary toggle. All three share the same People + Repo filters and the same `PostCard` renderer. The `mode` arg on `useInfinitePosts` swaps the `events.type` filter — `pr_narrative` / `narrative` / `release_notes` — and swaps the trigger-type allowlist between `PR_FEED_TRIGGER_TYPES = ['github:pr:opened']` (Opened mode) and `POST_TRIGGER_TYPES = ['github:pr:merged']` (Merged + Release notes). See "Narration (three voices, one PR lifecycle)" above for how a single PR's text moves through all three feeds as it opens → merges.

The Release-notes prompt is admin-editable in Settings → Release notes prompt (`ReleaseNotesPromptSection`). Empty/missing falls back to the NoxFeed-owned default exposed by the private `NOXFEED_RESPONSE` service binding. Stored under `settings.releaseNotesPrompt` (D1 config). The LLM provider/model is NOT separately configurable per feed — Posts and Release notes always share the org's `LlmSettingsSection` config.

Admin → NoxConnect → Repositories contains the shared Projects and routing cards. Repository mirror rows start disabled; the admin explicitly enables only genuine NoxConnect projects. Each enabled card assigns any number of installed repositories and selects independent destinations for NoxFeed Posts, Release Notes, and NoxCue. Saving a repository under a new enabled project atomically moves future product traffic to that project; existing event history is unchanged. Product sections retain organization defaults and source-specific overrides rather than duplicating project ownership.

### Active Tabs (visible in tab bar)

Every content tab (Current, Features, Specs, Feed, Issues, and Repos) includes the compact shared `AllMeToggle`. **Me** scopes data to the authenticated GitHub login using the tab's natural ownership rule: PR author, Feature owner, owning Feature for Specs, feed actor, issue assignee, and the corresponding user-scoped PR/issue/activity data on Repos. URL-backed tabs persist this as `scope=me`; Feed keeps it in local tab state.

#### Features (`sprint` tab)
Flat kanban backed by GitHub Issues (both `noxticket` + `feature` labels). Stages are admin-configurable via Settings → Board stages — the default set is To do / Specced / Testing on staging / Ready for production / On production, but any org can add/rename/re-color. Drag-and-drop status changes, arrow-key navigation on cards, search/filter by person, sort by title. Feature-carried content lives in linked Specs; the issue body only holds a metadata block (`statusHistory`, `specLinks`). A card shows one direct Spec link; when a Feature has multiple Specs, its detail modal exposes star controls to select one primary (`spec.is_primary`), while the remaining Specs stay in the card's overflow menu. The **backlog** toggle parks a feature out of the board (via the `backlog` GitHub label) — status label stays put so returning to the board lands the feature in the column it left. The view toggle is three-way — **Features / Backlog / Completed** (`view=completed` URL param): Completed is a read-only list of closed features (newest-updated first, stage-when-closed pill, owners, GitHub link) fetched via `useClosedFeatures` → `/api/features?state=closed`, only while the view is open; rows don't open the detail modal since its Save PATCHes a closed issue. **Detail modal** (`FeatureDetailModal`) has editable title (`Pencil` hover), stage picker, owners via `AssignDropdown`, and a Linked Specs section that reverse-looks-up by `spec.feature_number`. Edits remain local until the explicit Save button is used; closing a dirty modal prompts before discarding. It re-syncs from parent refetches when no local edit is in flight. Header **Clean Done** (admin) closes every feature in the last configured stage (`useCleanDoneFeatures`). PATCHes are field-scoped — a status-only PATCH sends only labels+body, so two concurrent edits touching different fields don't overwrite each other. DELETE nulls out `spec.feature_number` for every attached spec in the same batch, so specs don't orphan onto a closed feature. The open modal is URL-synced (`?tab=sprint&f=<n>`) and its header has a **Copy link** button (`CopyLinkButton` + `lib/share-links.ts`) that copies an org-scoped shareable URL (`?org=<login>&tab=sprint&f=<n>`) — `App.tsx` applies + strips the `org` param on load (member orgs only), and `loginWithOAuth` stashes the destination in `sessionStorage.ut_return_to` so a signed-out recipient lands on the linked feature after OAuth.

#### Specs (`specs` tab)
Manual, GitHub-independent spec library. Two-pane layout: left sidebar with a **Feature tree** (`SpecFeatureSidebar` — "All specs" / "Unfiled" / one row for every Feature, including zero-spec Features / collapsed **Archive** accordion at the bottom); right pane with a responsive card grid. Each spec has a title, Markdown description, and a list of external links (http/https-only, sanitized by the shared `spec-links` helper). Specs belong to at most one Feature (via `feature_number` — migration 0037 unified the retired "Project/folder" concept into Features); migration 0039 adds the one-per-Feature `is_primary` flag used by Feature cards. Everything lives in D1 (`specs` table + optional R2-backed attachments) — nothing syncs to or from GitHub. The **"+ New spec"** header modal (`SpecEditorForm`) picks a Feature via `SearchableSelect`. The **detail modal** (`SpecDetailModal`) mirrors FeatureDetailModal — editable title with `Pencil` hover, explicit Save button, dirty-close confirmation, Markdown description, and Feature select via `SearchableSelect`. **Admins** get Archive/Restore in the modal footer; archived specs disappear from all normal Specs and Feature views and are reachable only through the Specs Archive view. The server 403s the endpoint for non-admins. URL-synced via `?tab=specs&feature=<n|unfiled|archive>&spec=<id>`; the detail modal header has the same **Copy link** button as FeatureDetailModal (copies `?org=<login>&tab=specs&spec=<id>`). Hook layer: `useSpecs`, `useSpec`, `useCreateSpec`, `useUpdateSpec`, `useSetSpecArchived` (all in `src/hooks/useSpecs.ts`, optimistic).

#### Issues (`issues` tab)
Issues dashboard. Top section: four stat cards (open, unassigned, stale >30d, closed in last 30d). Middle section: horizontal bar chart of open issues by repo, label distribution breakdown, and closed-per-week trend chart. Bottom section: full paginated table of open + closed issues (closed within the last 30 days). Stats powered by `meta=stats` endpoint on `/api/issues` (single D1 batch query). Filters: repo (searchable), assignee, assignment status, label. Sortable columns (issue #, title, repo, age). Pagination controls per section (open / closed). Uses `usePaginatedIssues` + `useIssueStats` hooks backed by `/api/issues` with D1 pagination. Sync button with progress modal (`triggerSyncWithProgress`). Interactive assignee column using `AssignDropdown` — click to assign/unassign org members, syncs to GitHub via `POST /api/assign` with optimistic UI updates.

#### Current (`current` tab — replaces the old `prs` + `engineers` tabs)
Unified "what's happening right now" view. The grid at top is a card per **active member** (default) or **repo**, always seeded — a person with 0 open PRs still gets a card, so the grid is a stable team/portfolio overview rather than a list of whoever happened to open something. The Draft/Ready/Merged toggle filters the underlying PR set; **Ready** is the default. Clicking a person card drills into a person page with a **PRs / Stats** sub-tab bar:
- **PRs** (default) — the sortable PR table (repo, title, author, reviewers, age). Stale (>7 days) highlighted amber. Admin-only Close-PR action.
- **Stats** — 5 headline stat cards from `useEngineerStats` plus the tracked-repository contribution dashboard from `useEngineerActivity`: daily PRs opened/reviewed, active and peak days, and a 12-month trend. Both charts have labeled time/count axes, visible point values, and exact mouse/focus tooltips. Review history begins when the GitHub App starts receiving events.

Clicking a repo card drills into that repo's PR table (no sub-tabs).

URL params: `?tab=current` · `?tab=current&view=draft|merged` · `?tab=current&by=repo` · `?tab=current&author=<login>` · `?tab=current&author=<login>&pane=stats` · `?tab=current&repo=<name>`. Legacy `?tab=prs` and `?tab=engineers` URLs still resolve — `DashboardPage.tsx` routes all three to `CurrentTab.tsx`. Person drill-ins arriving via CommandPalette also land here. The old `EngineersTab.tsx` (activity table + item lists + activity feed) has been removed; its 5 headline stats live on the Stats sub-tab, the activity feed / voice card were dropped as unused surface area.

### Other Features

#### Settings (`settings` tab, top-nav settings icon)
Manages people config and tracked repos (mark repos as draft). Includes webhook setup section with payload URL and link to GitHub org webhook settings. Accessed via the gear icon in the top nav. Agent Rules section lets users define org-wide rules and push them to each repo's `CLAUDE.md` via the GitHub API. Rules are stored in D1 (`agentRules` config key). Pushed content uses `<!-- noxconnect:start -->` / `<!-- noxconnect:end -->` markers for safe updates. Includes a built-in preamble explaining features, PR linking convention, and feature lifecycle. Full Re-sync button to backfill historical data with `force=true` (bypasses incremental sync timestamps). Data Sync section shows live progress during re-sync.

**Live Activity Backfill (admin-only)** — section gated by `useIsAdmin()`. Re-derives missing PR / issue / review / release / push event rows by calling `POST /api/sync-events` repo by repo (`triggerEventsBackfillWithProgress` in `src/lib/github.ts`). 30-day lookback so admins can recover events that pre-date the cron's 48h window. Used when Engineers tab's Live activity is missing recent activity for a teammate (typical cause: a deploy gap or webhook outage). Idempotent — re-running over the same period inserts zero new rows.

**Managed AI (admin-only)** — `LlmSettingsSection` lets an org admin enable or disable NoxConnect's server-owned Anthropic service. The browser never accepts or receives provider credentials, endpoints, or model choices. `ANTHROPIC_API_KEY` is a deployment secret, Claude Haiku is pinned in `MANAGED_LLM`, and failures fall back to deterministic summaries with diagnostics in `op_failures`.

**New repo policy + Newly detected (admin-only)** — `NewReposSection` in `SettingsTab.tsx`. Top of the card is a radio between Auto-include (default — new repos are active immediately) and Auto-exclude (new repos start as platform-archived drafts until Track). Below it, the list of repos with `acknowledged_at IS NULL` from `useUnacknowledgedRepos()`. Each row has Track / Mark draft; the header has Acknowledge all. The Track / Mark draft pair also flips `projects.archived` via the existing `/api/projects/:id/archive` endpoints, then calls `/api/repos/acknowledge`. The section accepts a `?focus=newRepos` deep-link from the NewRepoBanner — it scrolls into view, highlights briefly, and then clears the param.

**Tracked repos (admin-only)** — `TrackedReposSection` in `SettingsTab.tsx`. The single "which repos count" list — checkbox per repo, mirrors PeopleManagement's shape so admins have one mental model for both people and repo scoping. Checking = tracked, unchecking = hidden. Reads `useRepos({ includeAll: true })` so drafts + platform-archived rows all render with an `inactive` flag. Toggling calls `useSetProjectArchived()` which flips the same `projects.archived` column that `/api/repos`, `/api/prs`, `/api/issues` already respect — an uncheck immediately hides the repo everywhere without a reload. On the client side, `useExcludedRepos()` (in `useGitHub.ts`) derives the same set from `useFeedProjects()` and threads it through `filterPrs` / `filterIssues` `select` transforms next to the excluded-members filter, so any new list-render code inherits both filters automatically.

**Background failures (admin-only)** — `RecentFailuresSection` in `SettingsTab.tsx`, gated by `useIsAdmin()`. Surfaces rows from the `op_failures` D1 table (migration `0021_op_failures.sql`). Background work scheduled via `context.waitUntil(...)` (narrator, install bootstrap, sync-on-repo-add, posts backfill) finishes after the HTTP response — when it throws, only `console.error` sees it and the response was already `200`. The `recordFailure` helper in `functions/lib/op-failures.js` writes a row into D1 from every `waitUntil` catch handler so the admin UI can show "the webhook returned 200, but the follow-up work failed: here's why." The helper swallows its own errors so logging can never escape into the response path.
