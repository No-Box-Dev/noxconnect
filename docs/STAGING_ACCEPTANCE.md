# Provider acceptance

The live provider gate reuses NoxConnect's existing GitHub App and Slack App.
Provider apps grant access; the repository, project, Slack connection, and Slack
channel parameters determine where each operation goes. A second app or
workspace is not required.

The runner makes real writes, so it fails closed unless all destinations are
explicitly test-only:

- the GitHub repository name contains `staging`, `sandbox`, `acceptance`,
  `test`, or `cert`;
- the repository is private and not archived on GitHub;
- the Slack channel name contains the same kind of test marker;
- the selected NoxSpot site and NoxCue source resolve to that exact channel;
- a short-lived NoxHere API token and explicit write confirmation are present;
- NoxHere and NoxSpot hosts match the small built-in allowlist.

`No-Box-Dev/test` and a channel such as `#nox-acceptance` are the default
destinations. Production product repositories and ordinary Slack channels are
rejected before the first write.

## What remains isolated

The provider identity is shared, but every test resource is selected by an
explicit parameter:

| Resource | Acceptance boundary |
|---|---|
| GitHub | Existing App installation → private `No-Box-Dev/test` repository |
| Slack | Existing App installation → selected connection and `#nox-acceptance` channel |
| Nox project | Dedicated project linked only to the test repository |
| NoxSpot | Dedicated site with a test-labelled origin and the acceptance channel |
| NoxCue | Dedicated source, `staging` environment, acceptance channel, and source-only ingest key |

The separate Cloudflare staging Workers and databases remain useful for
deployment/readiness smoke tests. They are not a reason to duplicate provider
apps or workspaces.

## One-time destination setup

1. Ensure the existing NoxConnect GitHub App installation can access the
   private `No-Box-Dev/test` repository.
2. In Nox, restore/enable the existing `proj_no-box-dev_test` project if it is
   archived and keep it linked only to the `test` repository.
3. Create `#nox-acceptance` (or another explicitly test-labelled channel) in
   the existing Slack workspace and invite the NoxConnect bot.
4. Configure the test project:
   - NoxTicket feature repository → `test`;
   - NoxFeed release notes → the acceptance Slack connection/channel;
   - NoxSpot site → the test project/repository, test-labelled allowed origin,
     and acceptance Slack connection/channel;
   - NoxCue source → the test project, environment `staging`, alerts enabled,
     and acceptance Slack connection/channel;
   - NoxCue GitHub incidents → enabled only for the test project and
     `staging` environment.
5. Create a source-only NoxCue ingest key and a short-lived `nox_at_...`
   session with the required project/service scopes.

No provider secret needs to be copied into the acceptance file. Existing
GitHub and Slack credentials stay encrypted inside NoxConnect.

## Run the gate

Copy `.env.staging-acceptance.example` to the ignored
`.env.staging-acceptance`, then fill the project/site/source IDs, Slack
connection/channel IDs, NoxHere access token, and NoxCue ingest key.

Run the read-only preflight first:

```bash
npm run e2e:provider:preflight
```

Then run the explicit write gate:

```bash
npm run e2e:provider
```

The live run:

- sends NoxTicket, NoxFeed, and NoxCue test messages to the exact channel ID;
- creates and closes a NoxTicket feature issue;
- opens and merges a disposable PR and waits for its NoxFeed release note;
- ingests a NoxCue staging error and waits for its Slack/GitHub receipts;
- submits NoxSpot feedback and waits for its Slack/GitHub receipts.

Unique run markers prevent stale data from passing. Created issues are closed
during cleanup; the merged fixture PR and release-note record remain as the
audit trail. If any step fails, the runner attempts cleanup and prints the
missing receipt without printing credentials.

## Optional Cloudflare staging smoke

The isolated staging topology can still be checked independently:

```bash
curl -fsS https://noxhere-staging.jasper-414.workers.dev/api/health/ready
```

That smoke check validates the deployed service bindings, queue, database, and
scheduler. It does not need separate provider apps.
