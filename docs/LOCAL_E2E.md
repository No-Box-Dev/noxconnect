# Local end-to-end environment

`npm run e2e:local` starts the complete Nox service topology on the local
Cloudflare runtime and makes real HTTP, RPC, D1, Queue, authentication, and
webhook calls. It does not deploy anything and it does not load production
provider secrets.

## Topology

| Local service | Port | Role |
|---|---:|---|
| NoxConnect Pages | 8788 | public app, API, auth boundary, and control plane |
| NoxSpot Worker | 8790 | public feedback capture and response RPC |
| NoxFeed Worker | 8791 | feed response RPC |
| NoxCue Worker | 8792 | event ingestion, metrics, and response RPC |
| RPC smoke Worker | 8793 | disposable private-binding contract caller |
| NoxConnect cron Worker | 8794 | Queue consumer and scheduled background work |

All services use one newly created local persistence directory. NoxConnect's
migrations are the sole schema authority and are applied before any Worker is
started. The runner seeds a disposable organization, installation, repository,
and project without storing a provider token in D1.

## Prerequisites

- Node.js and dependencies installed in this repository.
- The NoxCue checkout at `../NoxAlert`, with `npm ci` completed.
- The NoxFeed Worker at `../noxfeed-mac/service`, with `npm ci` completed.
- NoxSpot Worker dependencies installed at `workers/noxspot-capture`.
- GitHub CLI authenticated as a member of the test organization. This performs
  a real identity and organization-membership check, but makes no provider
  writes.

Override sibling locations or the fixture scope when necessary:

```bash
NOXCUE_DIR=/absolute/path/to/NoxAlert \
NOXFEED_SERVICE_DIR=/absolute/path/to/noxfeed/service \
NOXCONNECT_E2E_ORG=My-GitHub-Org \
NOXCONNECT_E2E_REPO=my-repository \
npm run e2e:local
```

Use `node scripts/local-e2e.mjs --allow-auth-skip` only when a public and
service-binding smoke run is useful without GitHub CLI authentication. Use
`--keep-state` to retain the fresh D1 state and per-Worker logs for diagnosis.
Failed runs always retain them and print their exact location. Successful runs
remove them.

## Checks performed

The runner builds the production app, applies every migration, starts every
Worker, and checks:

- developer documentation, its JavaScript, and the OpenAPI contract;
- all three product HTTP health endpoints and the cron runtime;
- private RPC contracts for NoxSpot, NoxCue, and NoxFeed;
- anonymous rejection, real GitHub identity and org-membership auth, opaque
  browser and native sessions, native access/refresh rotation and revocation, CSRF enforcement,
  project-scoped NoxCue GitHub-incident configuration,
  and one-project API-token create/list/rotate/revoke;
- all five service catalog, setup, health, and config contracts;
- ETag/`If-Match` config writes, missing preconditions, and stale revisions;
- project discovery from an installation record;
- NoxCue source creation, one-time key creation, event ingestion through the
  NoxConnect service binding, idempotency, metrics, revocation, and rejection of
  the revoked key;
- NoxSpot site creation, shared-D1 public config, and Queue submission;
- invalid and valid HMAC-signed GitHub webhooks.

### API credential assertions

The key checks use real HTTP requests and fresh D1 rows, not handler mocks. The
runner verifies one-time secret return, hashed-at-rest lookup, redacted listing,
organization, project, and service scope enforcement, cross-project denial,
project-filtered feed results, the disabled-service error, CSRF protection for
lifecycle operations, project-preserving rotation, immediate invalidation,
revocation, and rejection after revocation. It also proves that an automation
token cannot mint, rotate, list, or revoke automation tokens.

## Deliberate external boundary

The local suite does not use production GitHub App, Slack, or AI credentials.
Consequently, it proves that provider-bound tasks are accepted by the local
Queue, but it does not create a real GitHub issue, send a Slack message, or run
paid AI narration. Those final deliveries need separately provisioned sandbox
accounts and secrets; they must not be tested by borrowing production secrets.
