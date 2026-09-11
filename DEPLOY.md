# Self-hosting NoxConnect

NoxConnect runs on Cloudflare: a Pages project (frontend + authenticated API
Functions), a public NoxSpot capture Worker, a D1 database, a sibling cron
Worker, a Queue, and R2 buckets. This guide walks a fresh deploy end to end.

> NoxConnect is source-available under the [PolyForm Noncommercial License](./LICENSE). Self-hosting for non-commercial use is fine; commercial use is not.

## Prerequisites

- Node.js 22+
- A Cloudflare account, with `wrangler` authenticated (`npx wrangler login`)
- A GitHub organisation you administer (to install the App on)
- A Slack workspace where you can create an app (optional, for Slack mirroring)

## 1. Clone and configure

```bash
git clone https://github.com/No-Box-Dev/noxconnect.git
cd noxconnect
npm ci
cp .env.example .env.local
```

Edit `wrangler.toml` and `cron/wrangler.toml`: replace `database_id` (and, if you like, the `*-noxconnect*` resource names) with your own — the committed IDs point at the canonical hosted instance and you cannot deploy to them.

`PLATFORM_ADMIN_GITHUB_IDS` in `wrangler.toml` is a comma-separated allowlist
of verified numeric GitHub user ids. Those users can open the internal,
read-only `/operator` business dashboard across organizations. Use ids from
GitHub's `/user` response rather than mutable login names; remove the variable
entirely on self-hosted instances that do not need a platform operator.

## 2. Provision Cloudflare resources

```bash
# D1 database — copy the printed database_id into BOTH wrangler.toml files
npx wrangler d1 create noxconnect

# Durable background-work queue + its dead-letter queue
npx wrangler queues create noxconnect-tasks
npx wrangler queues create noxconnect-tasks-dlq

# R2 bucket for event-table archival
npx wrangler r2 bucket create noxconnect-events-archive

# R2 bucket for immutable NoxSpot widget assets and temporary screenshots
npx wrangler r2 bucket create noxspot-assets
```

Apply migrations to the remote DB:

```bash
npx wrangler d1 migrations apply noxconnect --remote
```

## 3. Register a GitHub App

Create a GitHub App (Settings → Developer settings → GitHub Apps → New) with:

- **Callback URL:** `https://<your-pages-domain>/auth/github/callback`
- **Webhook URL:** `https://<your-pages-domain>/api/webhook`
- **Webhook secret:** generate a random string; you'll set it as `GITHUB_WEBHOOK_SECRET`
- **Permissions:** Repository → Contents (read), Issues (read/write), Pull requests (read), Metadata (read); Organization → Members (read)
- **Subscribe to events:** Issues, Pull request, Pull request review, Push, Release, Member
- Enable **"Request user authorization (OAuth) during installation"** and **expiring user tokens** (enables refresh-token rotation)

Note the **App ID**, **Client ID**, generate a **Client secret**, and download the **private key** (PEM).

## 4. Set secrets

Frontend build var (public) — set in `.env.local` for local builds and as a Pages env var/secret for CI:

```
VITE_GITHUB_APP_CLIENT_ID=<your app client id>
```

Server-side secrets on the **Pages** project. The canonical hosted project is
`noxconnect`, which owns `app.noxhere.com`:

```bash
npx wrangler pages secret put GITHUB_APP_ID         --project-name noxconnect
npx wrangler pages secret put GITHUB_APP_CLIENT_ID  --project-name noxconnect
npx wrangler pages secret put GITHUB_APP_CLIENT_SECRET --project-name noxconnect
npx wrangler pages secret put GITHUB_APP_PRIVATE_KEY --project-name noxconnect
npx wrangler pages secret put GITHUB_WEBHOOK_SECRET --project-name noxconnect
npx wrangler pages secret put ENCRYPTION_KEY        --project-name noxconnect   # 64-char hex
npx wrangler pages secret put ANTHROPIC_API_KEY     --project-name noxconnect
npx wrangler pages secret put SLACK_CLIENT_ID       --project-name noxconnect
npx wrangler pages secret put SLACK_CLIENT_SECRET   --project-name noxconnect
npx wrangler pages secret put SLACK_SIGNING_SECRET  --project-name noxconnect
```

Generate `ENCRYPTION_KEY` with `openssl rand -hex 32`. `REVIEW_RUNNER_TOKEN` (generate the same way) authorizes the local noxreview runner against `/api/review/*` — keep it out of any client-visible config:

```bash
npx wrangler pages secret put REVIEW_RUNNER_TOKEN   --project-name noxconnect
```

The **cron Worker** needs its own copy of the secrets it uses:

```bash
npx wrangler secret put GITHUB_APP_ID        --name noxconnect-orchestrator
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --name noxconnect-orchestrator
npx wrangler secret put ANTHROPIC_API_KEY     --name noxconnect-orchestrator
npx wrangler secret put ENCRYPTION_KEY       --name noxconnect-orchestrator
```

> **LLM providers:** `ANTHROPIC_API_KEY` on NoxConnect still powers shared NoxSpot and daily-summary tasks. NoxFeed event posts and release notes use the key configured directly on `noxfeed-response`; clients never supply API credentials. The AI settings API reads NoxFeed readiness through `NOXFEED_RESPONSE` and reports each service separately; managed mode is ready only when both deployments are configured. An organization can disable AI in Settings, and unavailable generation fails closed to deterministic summaries.

### Provision the NoxConnect Slack app

The versioned [`slack-app-manifest.json`](./slack-app-manifest.json) is the single source of truth for NoxConnect, the shared Slack app for NoxCue, NoxFeed, NoxKey, and NoxTicket. It configures the centralized OAuth callbacks, least-privilege bot scopes, Events API endpoint, and `app.noxhere.com` link unfurls. Generate a temporary **app configuration token** under [Your Apps](https://api.slack.com/apps), then create the shared app—or use `slack:push` with the existing app ID to rename and migrate that installation without creating a duplicate app:

```bash
SLACK_CONFIG_TOKEN=xoxe.xoxp-... npm run slack:validate
SLACK_CONFIG_TOKEN=xoxe.xoxp-... npm run slack:create
```

The create command prints the app ID and its three credentials. Put the credentials into the Pages secrets listed above, deploy the Pages app, then verify the Events API request URL from the Slack app's **App Manifest** page. Keep the app ID in NoxKey for later manifest updates:

```bash
SLACK_CONFIG_TOKEN=xoxe.xoxp-... SLACK_APP_ID=A0123456789 npm run slack:push
```

Slack configuration tokens expire after 12 hours. They are only needed for manifest management and must not be committed. If a pushed manifest adds OAuth scopes, connected workspaces must reconnect from NoxConnect Settings to grant them.

For customer installs, open **Manage Distribution** in the Slack app dashboard,
complete Slack's checklist, and activate unlisted public distribution. Do not
publish a second Slack app per product: admins start OAuth from NoxConnect's
**Setup** tab, and the resulting encrypted workspace token is shared by
NoxCue, NoxFeed, NoxKey, NoxSpot, and NoxTicket for that Nox organization.
The organization can connect multiple Slack workspaces and stores a workspace +
channel for its fallback and each service-specific route. NoxFeed has separate
Posts and Release Notes routes; NoxSpot can override the fallback per site. Private
channels must invite the same NoxConnect bot before they can be selected.

Nox clients discover and manage these shared providers through the authenticated
`/api/v1/integrations/connections` registry. Connection start/disconnect actions are
admin-only and reuse the provider's existing OAuth security flow; the API never
returns provider credentials or encrypted tokens.

## 5. Deploy

### Stage the API authentication migration first

Before the production commands below, provision a separate Pages project, D1
database, GitHub App, and provider sandbox credentials. Do not point a preview
deployment at the production D1 database or reuse its OAuth client secret.

The staging gate for `0073_api_auth.sql` and `0075_project_scoped_api_tokens.sql` is:

1. Apply all migrations to the staging D1 database.
2. Deploy the Pages branch with the staging GitHub App client ID and secrets.
3. Complete a real GitHub OAuth redirect and confirm that the response creates
   `__Host-nox_session` as `Secure`, `HttpOnly`, and `SameSite=Lax`.
4. Confirm a browser mutation without `X-CSRF-Token` returns `403`.
5. In **NoxConnect → API access**, choose one enabled project and create a
   one-day test token with only `services:read` and one service read scope.
6. Confirm it cannot access another service, another project's feed, site,
   source, or metrics, organization-level configuration, or API-token management.
7. Disable its allowed service and confirm operations return
   `403 service_not_enabled`, then re-enable the service.
8. Rotate it, confirm the project is unchanged and the previous value
   immediately returns `401`, then revoke
   the replacement and confirm it also returns `401`.
9. Use disposable provider resources to exercise one GitHub write and one Slack
   delivery. Never borrow production credentials for this gate.

The repository's `npm run e2e:local` performs the same session, CSRF, project
isolation, disabled-service, rotation, and revocation checks against fresh local D1 state. Staging adds the
real OAuth redirect and disposable provider delivery checks that cannot be
proved locally.

```bash
npm run build
npx wrangler pages deploy dist --project-name noxconnect --branch main
cd cron && npx wrangler deploy && cd ..
cd workers/noxspot-capture && npm ci && npm run types && npm test && npx wrangler deploy && cd ../..
```

Or wire up CI: `.github/workflows/ci.yml` runs lint/typecheck/tests for Pages and
the capture Worker, and `deploy-pages.yml` deploys Pages, applies D1 migrations,
and deploys both Workers on a green `main`. It needs repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The NoxSpot capture Worker has no application secrets. It uses direct bindings
to the shared D1 database, `noxconnect-tasks` Queue, `noxspot-assets` R2 bucket,
and its sharded rate-limit Durable Object. It is the sole owner of
`api.noxspot.dev`. Customer installations use only the project-specific
`/widget/{project-id}.js` route; the NoxSpot repository's tested deployment
workflow publishes its loader and matching immutable core artifact.

Pages and the cron Worker require three private, versioned response bindings:
`NOXSPOT_RESPONSE` targets `noxspot-api`, `NOXCUE_RESPONSE` targets
`noxcue`, and `NOXFEED_RESPONSE` targets `noxfeed-response`. Deploy compatible
product Workers before deploying Pages or cron. The renderers receive only
bounded product data and public references; GitHub credentials, Slack tokens,
connection IDs, and delivery state never cross these bindings. NoxFeed's
response Worker is built from the NoxFeed repository's `service/` directory.
Set its provider secret before deploying the compatible Worker:

```bash
npx wrangler secret put ANTHROPIC_API_KEY --name noxfeed-response
```

The secret does not cross the service binding. NoxConnect sends bounded event
facts and receives only validated content or a typed unavailable result.

The safe manual order is NoxSpot API, NoxCue, NoxFeed response, Pages, then
cron. See `docs/SERVICE_BOUNDARIES.md` for the ownership and contract rules.
Public NoxCue clients use the stable Pages gateway
`https://app.noxhere.com/api/v1/cues/public/events`. It forwards through the
private `NOXCUE_RESPONSE` service binding, so copyable snippets do not expose or
depend on the product Worker's deployment hostname. Keep the direct Worker URL
for operator diagnostics only; it is not part of the public contract.

> **Migrations run before code** — the deploy workflow applies D1 migrations before `pages deploy` for this reason. If you deploy manually, run `d1 migrations apply` first.

## 6. Install the App and bootstrap

1. Install your GitHub App on your org (`https://github.com/apps/<your-app>/installations/new`).
2. The `installation.created` webhook enqueues a bootstrap job that syncs repos, members, issues, and PRs. The UI shows a setup overlay until it finishes.
3. The first active GitHub organization owner to authenticate can bootstrap the
   NoxConnect admin role. An ordinary organization member cannot claim it.

## Operations

- **Cron:** reconciles every 30 min (catches missed webhooks, deletes, label changes) and archives `events` older than 90 days to R2 at the 03:00 UTC tick.
- **NoxSpot capture:** `workers/noxspot-capture` owns the anonymous config,
  report, error, widget-asset, screenshot, abuse-control, and 90-day screenshot
  retention surface. It deliberately does not share Pages bearer middleware.
- **Background failures:** terminal queue failures land in the `op_failures` table; view them in Settings → Background failures (admin-only).
- **Manual event backfill:** Settings → Live Activity Backfill (admin-only) re-derives missing events over a 30-day window. Rate-limited to once per org per day.
- **Suspending an org:** set `suspended_at` on its `orgs` row to block all API access (`UPDATE orgs SET suspended_at = datetime('now') WHERE github_login = '<org>'`); set it back to `NULL` to restore.
- **Business overview:** allowlisted platform operators sign in through the
  normal GitHub OAuth flow and open `/operator`. Platform access is distinct
  from organization administration, and the page exposes account/activity
  aggregates and service configuration—not repository or customer content.

## Costs

NoxConnect fits comfortably in Cloudflare's free/low tiers for a small org. The main variable cost is managed LLM narration (PR-merge narration only, paced, and disable-able). The backfill endpoint is rate-limited to bound that spend.
