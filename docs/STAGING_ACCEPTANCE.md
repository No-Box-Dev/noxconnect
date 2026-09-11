# Staging provider acceptance

This environment is the last gate before production. It makes real GitHub and
Slack writes, but only through dedicated staging provider apps, a dedicated
GitHub organization/repository, a test Slack workspace/channel, and isolated
Cloudflare data. The runner refuses the production NoxHere/NoxSpot hosts and
the `No-Box-Dev/noxconnect` production scope.

## Isolated topology

| Plane | Staging deployment | Isolated state |
|---|---|---|
| Nox public platform | `noxhere-staging` | `noxhere-control-staging` D1 |
| NoxConnect API | `noxconnect-staging` | `noxconnect-staging` D1, staging Queue/R2 |
| Provider credentials | private NoxConnect API/capability/cron Workers | staging GitHub/Slack/AI credentials only |
| Background delivery | `noxconnect-orchestrator-staging` | staging Queue, DLQ, D1, archive R2 |
| NoxTicket | `noxticket-staging` | `noxticket-staging` D1 and attachment R2 |
| NoxFeed | `noxfeed-response-staging` | `noxfeed-demo-staging` D1 |
| NoxSpot | `noxspot-api-staging` | staging NoxConnect D1, Queue, and assets R2 |
| NoxCue | `noxcue-staging` | staging NoxConnect D1 and Queue |

Product Workers must be deployed before NoxConnect because its private service
bindings fail closed when a target is missing. Product digest schedules are
disabled; the connector's five-minute recovery/heartbeat tick uses only the
isolated staging providers and data. The acceptance suite is the only source
of synthetic certification writes.

## One-time provider setup

1. Create a dedicated GitHub organization such as `nox-staging-cert`, and a
   private repository such as `staging-cert`. Do not reuse `No-Box-Dev`.
2. Create a separate **NoxConnect Staging** GitHub App with callback
   `https://noxhere-staging.jasper-414.workers.dev/auth/github/callback` and
   webhook `https://noxhere-staging.jasper-414.workers.dev/api/webhook`.
   Grant Repository Contents read, Issues read/write, Pull requests read,
   Metadata read, and Organization Members read. Subscribe to Issues, Pull
   request, Pull request review, Push, Release, and Member. Enable user OAuth,
   expiring user tokens, and install it only in the staging organization.
3. Create a dedicated Slack workspace and channels for NoxTicket, NoxFeed,
   NoxSpot, and NoxCue. Generate a temporary Slack app configuration token and
   create the staging app from the same reviewed manifest:

   ```bash
   SLACK_MANIFEST_ENV=staging SLACK_CONFIG_TOKEN=... npm run slack:validate
   SLACK_MANIFEST_ENV=staging SLACK_CONFIG_TOKEN=... npm run slack:create
   ```

   The in-memory staging transform changes the app name, OAuth callback,
   Events API URL, interaction URL, and unfurl domain. It never edits the
   production manifest.

4. Set staging-only Cloudflare secrets interactively; never place values in
   source, shell history, or this document:

   ```bash
   npx wrangler secret put GITHUB_APP_ID --config workers/api-gateway/wrangler.jsonc --env staging
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config workers/api-gateway/wrangler.jsonc --env staging
   npx wrangler secret put GITHUB_WEBHOOK_SECRET --config workers/api-gateway/wrangler.jsonc --env staging
   npx wrangler secret put SLACK_APP_ID --config workers/api-gateway/wrangler.jsonc --env staging
   npx wrangler secret put SLACK_CLIENT_ID --config workers/api-gateway/wrangler.jsonc --env staging
   npx wrangler secret put SLACK_CLIENT_SECRET --config workers/api-gateway/wrangler.jsonc --env staging
   npx wrangler secret put SLACK_SIGNING_SECRET --config workers/api-gateway/wrangler.jsonc --env staging
   npx wrangler secret put ENCRYPTION_KEY --config workers/api-gateway/wrangler.jsonc --env staging

   npx wrangler secret put GITHUB_APP_ID --config workers/connection-capabilities/wrangler.jsonc --env staging
   npx wrangler secret put GITHUB_APP_CLIENT_ID --config workers/connection-capabilities/wrangler.jsonc --env staging
   npx wrangler secret put GITHUB_APP_CLIENT_SECRET --config workers/connection-capabilities/wrangler.jsonc --env staging
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config workers/connection-capabilities/wrangler.jsonc --env staging
   npx wrangler secret put ENCRYPTION_KEY --config workers/connection-capabilities/wrangler.jsonc --env staging
   npx wrangler secret put ANTHROPIC_API_KEY --config workers/connection-capabilities/wrangler.jsonc --env staging

   npx wrangler secret put GITHUB_APP_ID --config cron/wrangler.toml --env staging
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config cron/wrangler.toml --env staging
   npx wrangler secret put ENCRYPTION_KEY --config cron/wrangler.toml --env staging
   npx wrangler secret put ANTHROPIC_API_KEY --config cron/wrangler.toml --env staging
   ```

   NoxHere and both NoxConnect Workers already have their coordinated staging
   `NOXHERE_INTERNAL_SECRET`. Rotate it only as the documented dual-key change.

## Deploy and configure

Apply migrations, then deploy in dependency order:

```bash
npx wrangler d1 migrations apply noxconnect-staging --remote
npx wrangler d1 migrations apply DB --env staging --remote --config ../noxticket-service/wrangler.jsonc
npx wrangler d1 migrations apply DEMO_DB --env staging --remote --config ../noxfeed-mac/service/wrangler.toml

# Run these in the corresponding service repositories.
npx wrangler deploy --env staging                              # NoxTicket, NoxCue
npx wrangler deploy --env staging --config service/wrangler.toml # NoxFeed

# Run these in NoxConnect.
npm run deploy:noxspot:staging
npm run deploy:capabilities:staging
npm run deploy:api-gateway:staging
npm run deploy:cron:staging

# Run in NoxHere.
npm run deploy:staging
```

Sign into the staging URL, install the staging GitHub App, connect the staging
Slack app, enable all four services, and configure:

- project `staging-cert-project` → staging repository `staging-cert`;
- NoxTicket feature repository → `staging-cert`;
- separate Slack routes for NoxTicket, NoxFeed release notes, and NoxCue;
- a NoxSpot site for the staging project with a test-labelled allowed origin
  and a Slack channel override;
- a NoxCue source scoped to that project, environment `staging`, alerts on,
  and an ingest key created only for this source;
- NoxCue GitHub incidents enabled only for `staging`.

## Run the gate

Copy `.env.staging-acceptance.example` to the ignored
`.env.staging-acceptance`, fill the resource IDs, and create a short-lived
`nox_at_…` native session through the staging device flow. The test credential
is a NoxHere session; it is not a GitHub token.

Run read-only preflight first:

```bash
npm run e2e:staging:preflight
```

Then run the explicit write gate:

```bash
npm run e2e:staging
```

The live run sends NoxFeed/NoxTicket/NoxCue Slack test messages, creates and
closes a NoxTicket feature issue, opens and merges a disposable PR and waits
for its NoxFeed release note, ingests a NoxCue staging error and waits for its
Slack receipt/GitHub incident, and submits NoxSpot feedback and waits for its
Slack receipt/GitHub issue. Unique run markers prevent stale data from passing
the gate. Created issues are closed during cleanup; the merged fixture PR and
release-note record remain as the staging audit trail.

If any step fails, do not deploy production. The runner attempts cleanup and
prints the exact missing receipt without printing NoxHere, NoxCue, GitHub, or
Slack credentials.
