# Nox service boundaries

NoxHere is the customer-facing platform: the web app, public API, sessions,
organization/project authorization, product enablement, and API documentation at
`app.noxhere.com`. NoxHere authenticates and scopes every request before it calls
an internal service.

NoxConnect is private integration plumbing. It owns GitHub and Slack
installations, encrypted provider tokens, provider clients, connection health,
channel routing, the durable delivery outbox, retries, and final provider
delivery. It does not own the public user experience or decide what a product
says or renders.

GitHub is exclusively a NoxConnect capability. NoxConnect owns webhook receipt
and normalization, installation-token minting, repository discovery, issue and
pull-request synchronization, GitHub reads, and GitHub mutations. Product
services receive bounded domain records or public GitHub URLs only; they never
receive an installation token, App private key, GitHub client, or permission to
call GitHub directly. Generic issue transport lives in `functions/lib/github-issues.js`.
Browser and native clients use `/api/v1/auth/profile`, `/api/v1/github/details`, and
the other canonical NoxHere APIs rather than Octokit or `api.github.com`. NoxConnect
brokers GitHub approval and stores its encrypted provider token; NoxHere issues the
app-facing `nox_at_…`/`nox_rt_…` session. Native apps never receive, keep, or
forward the GitHub credential.

| Product | Owns | Shared NoxConnect plumbing it uses |
| --- | --- | --- |
| NoxFeed | Complete post/release-note generation, managed model access, output validation, Posts/Release Notes Slack blocks, delivery-test content | GitHub event intake, org/project data, AI enable/disable policy, channel selection, outbox and delivery |
| NoxSpot | Widget and capture runtime, issue rendering, feedback Slack blocks, delivery-test content | org/site administration, GitHub installation, destination selection, outbox and delivery |
| NoxTicket | Feature/backlog behavior and ticket Slack content | GitHub issue transport, org/repository selection, destination selection, outbox and delivery |
| NoxCue | Closed user-event validation, identity hashing, incident detection/repeat policy, and Slack digest presentation | source/key administration, event facts, project metric selection, daily aggregation, GitHub issue transport, destination selection, outbox and delivery |

## Runtime contracts

- NoxSpot exposes `noxspot.response` version 1 through the private `NOXSPOT_RESPONSE` service binding.
- NoxCue exposes `noxcue.response` version 1 through the private `NOXCUE_RESPONSE` service binding.
- NoxFeed exposes `noxfeed.response` version 1 through the private `NOXFEED_RESPONSE` service binding. Its Worker lives with the NoxFeed product under `service/` and returns either validated generated content or a typed unavailable result; `generationInfo()` reports only provider, model, and secret availability so NoxConnect can publish component readiness without receiving provider credentials or raw responses.
- NoxTicket currently has no independent service repository. Its response policy therefore lives under `functions/products/noxticket`, separated from `functions/lib` so extraction to a private binding is mechanical when that service is created.

Every adapter validates the contract version, structure, and Slack payload size before shared plumbing stores it. Product services receive only the data needed to render their response; they do not receive Slack tokens, connection IDs, or delivery state.

## Control plane versus product policy

The NoxHere Admin UI and authenticated `/api/v1` endpoints are the public control
plane. Turning a product off keeps its data but gates its public/runtime paths.
Product Workers own product execution and presentation policy. Product storage
must be service-owned; a product Worker must not receive the NoxHere or
NoxConnect database binding.

When adding behavior, use these rules:

- If it answers “who may do this, for which organization/project, and which
  product is enabled?”, it belongs to NoxHere.
- If it answers “which provider is connected, how do we call it, where should
  this go, and was it delivered?”, it belongs to NoxConnect.
- If it answers “what should this product store, do, detect, or say?”, it belongs
  to that product.
