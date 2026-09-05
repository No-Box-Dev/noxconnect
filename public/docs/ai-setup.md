# Nox setup for AI agents

Use this workflow to configure NoxConnect without relying on the Settings UI. The canonical schema is [`/openapi.json`](/openapi.json), and current progress is always available from `GET /api/integrations/setup`.

## Discover services and capabilities

Start with `GET /api/v1/services`. It explains the role of NoxConnect and lists
NoxTicket, NoxFeed, NoxSpot, and NoxCue separately. Each service includes:

- its focus and description;
- the capabilities it provides;
- whether each capability is ready, blocked, or disabled;
- required and optional GitHub or Slack connections; and
- setup sections that group related capabilities; and
- callable operations with a stable ID, HTTP method, path, authentication mode,
  and purpose.

Use `GET /api/v1/services/{service}` when only one service is relevant. Every
service exposes the same control-plane shape:

- `GET /api/v1/services/{service}/setup` for its sections and blockers;
- `GET /api/v1/services/{service}/config` for only the settings it owns;
- `PATCH /api/v1/services/{service}/config` for an admin-only partial update; and
- `GET /api/v1/services/{service}/health` for readiness checks.

Service discovery is read-only; it never starts OAuth or changes organization settings.

## Safe configuration updates

Fetch the service config, retain its `ETag` response header, and send that value
as `If-Match` on `PATCH`. A `412` means another update won the race: fetch the
config again, reapply the intended field changes, and retry. A missing
`If-Match` returns `428`.

```http
GET /api/v1/services/noxticket/config

PATCH /api/v1/services/noxticket/config
If-Match: "<revision-from-get>"
Content-Type: application/json

{ "featureRepository": "product" }
```

NoxConnect owns service toggles and repository-discovery policy. NoxTicket owns
its feature repository and workflow stages. NoxFeed owns project scope and its
release-notes prompt. NoxSpot site settings and NoxCue source settings stay on
their dedicated resource APIs, linked from each service config response. Slack
workspace connections and delivery routes remain shared NoxConnect resources.

The config response includes a `configuration` descriptor. `mode: service`
means the document can be patched using its advertised `writableFields`.
`mode: resource` means configuration belongs to child resources such as sites
or sources. Attempting to patch a resource-scoped service config returns
`409 resource_scoped_config` with the correct resource links.

## Error contract

New `/api/v1/services` endpoints use one error envelope:

```json
{
  "apiVersion": 1,
  "error": {
    "code": "revision_conflict",
    "message": "Settings changed concurrently; fetch config and retry",
    "details": {}
  }
}
```

Clients should branch on `error.code`, not message text. Every `/api/v1/*`
response, including authentication, organization, rate-limit, and service
availability failures raised by middleware, uses this envelope. Existing
unversioned `/api/*` product routes retain their legacy `{ "error": "..." }`
responses so the current UI remains compatible.

## Authentication

Send both headers on every `/api` request:

```http
Authorization: Bearer <GitHub OAuth access token>
X-Org: <GitHub organization login>
```

The user must belong to the organization. Setup mutations require a Nox organization admin. Never place provider secrets or Slack bot tokens in request bodies; Nox stores provider credentials server-side.

The hosted API is currently for first-party Nox clients and user-approved
automation. It does not issue third-party OAuth client credentials. Obtain its
bearer token through Nox's normal GitHub App sign-in flow and pass it to an agent
only through the user's approved secret manager or runtime environment. Never
extract a token from browser storage, ask a user to paste one into chat, or print
or persist it in logs. A GitHub personal access token is supported only by the
local read-only development flow described in the repository README; it is not
the hosted API's integration model.

## Resumable workflow

1. Call `GET /api/integrations/setup` for the global onboarding workflow, or a service's `/setup` endpoint for its bounded view.
2. Execute actions whose `state` is `available` and whose `automatable` value is `true`.
3. For a connection step, call its action. The result has `status: requires_user_action` and a `userAction.url`.
4. Give that URL to the user and ask them to open it in a browser and approve the provider. Do not fetch it in a headless HTTP client.
5. Poll `GET /api/integrations/setup` no more than once every five seconds until that step is `complete`, then continue.

GitHub and Slack consent are intentionally human actions. The Slack URL is a
signed, single-purpose first-party browser handoff: opening it sets the OAuth
CSRF cookie and redirects to Slack. Treat the URL as temporary secret material:
do not log it, persist it, prefetch it, or open it in a headless HTTP client. It
works even when the agent initiated the API request on a different machine. The
URL expires after 10 minutes (600 seconds); an expired link returns an
invalid-or-expired authorization error, after which the agent must restart the
Slack connection step to obtain a fresh URL.

## Slack routing

Discover channels:

```http
GET /api/slack/channels
```

Patch only the routes that should change:

```http
PATCH /api/integrations/slack/routing
Content-Type: application/json

{
  "routes": {
    "fallback": "C0123456789",
    "noxcue": "C0123456789",
    "noxticket": "C0234567890",
    "noxfeed_posts": "C0345678901",
    "noxfeed_release_notes": "C0456789012"
  }
}
```

Use `null` to clear a route. Service routes fall back to `fallback`; NoxSpot first uses its per-site channel and then the organization fallback. For private Slack channels, invite the Nox bot before assigning the channel.

Project routing is owned by NoxConnect. Discover project candidates, their explicit enabled state, installed repositories, and current named destinations with:

```http
GET /api/projects/routing
```

Update one project atomically with `PUT /api/projects/routing/{projectId}`. The body sets `enabled`, assigns its `repositories`, and supplies the `noxfeedPosts`, `noxfeedReleaseNotes`, and `noxCue` workspace/channel pairs. Repository mirror rows never participate until explicitly enabled. A repository belongs to one enabled project; assigning it here moves future traffic from its previous project. Empty destination pairs use the corresponding organization route. A project-assigned Slack workspace cannot be used by another project.

Verify a saved route:

```http
POST /api/integrations/slack/test
Content-Type: application/json

{ "route": "noxfeed_release_notes" }
```

An optional `channelId` tests a candidate channel before saving it.

## Feature setup APIs

After connections and organization routes are ready, feature-specific resources remain API-first:

- NoxSpot sites: `GET`/`POST /api/spots/sites` and `PATCH /api/spots/sites/{siteId}`.
- NoxCue sources: `GET/POST /api/cues/sources`, project metrics: `GET/PUT /api/cues/projects/{projectId}/metrics`, keys: `POST /api/cues/sources/{sourceId}/keys`, custom feature health under `/features`, and custom activity statistics under `/custom-metrics`. Register every `custom.*` name before ingest; linked staging and production sources share the project catalog, while an unlinked source stays isolated. Feature failures retain their actual technical error. Each custom activity event is idempotent and NoxCue derives total plus total per registered user. Unknown or paused names become bounded unregistered errors instead of creating definitions. A source destination overrides its linked project's `noxCue` route; otherwise the organization route is used. A newly created ingest key is returned only once; transfer it securely and never log it.
- Public NoxCue clients submit events to the stable same-origin gateway `POST /api/cues/public/v1/events`; it forwards to NoxCue through a private service binding. Put the source key in `X-Nox-Ingest-Key`, not the Nox bearer-token headers. Configure each source's workspace, channel, IANA timezone, and local delivery time through its source API. Reusing the same event identity is idempotent.
- NoxFeed resolves each GitHub repository through NoxConnect project routing before using the organization `noxfeed_posts` or `noxfeed_release_notes` route.
- NoxTicket uses the `noxticket` route.

Read the live endpoint response before acting; action links and state in `/api/integrations/setup` take precedence over this narrative guide.

## Mutation and retry safety

Use the operation's `x-change-safety` value in OpenAPI before calling a write.
Do not automatically retry operations marked `write_not_safe_to_retry` or
`destructive`; read the resulting state first and require explicit user
confirmation for deletes, disconnects, revocations, archives, and restores.
Revision-protected config updates are safe only after refetching and reapplying
the intended patch. NoxCue event ingestion is the exception: duplicate event
identities are handled idempotently.

On `429`, honor `Retry-After` and stop sending until that delay has elapsed. On
`401`, obtain a fresh user-approved credential instead of retrying the same
token. One-time secrets and OAuth handoff URLs cannot be recovered after they
have been displayed or expired; create a replacement through the advertised
operation.
