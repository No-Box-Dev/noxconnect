# Nox service boundaries

NoxConnect is the always-on integration layer. It owns organization identity, GitHub and Slack installations, encrypted tokens, channel routing, shared configuration, durable outbox state, retries, and final Slack delivery. It does not decide what a product says or renders.

GitHub is exclusively a NoxConnect capability. NoxConnect owns webhook receipt
and normalization, installation-token minting, repository discovery, issue and
pull-request synchronization, GitHub reads, and GitHub mutations. Product
services receive bounded domain records or public GitHub URLs only; they never
receive an installation token, App private key, GitHub client, or permission to
call GitHub directly. Generic issue transport lives in `functions/lib/github-issues.js`.
Browser and native clients use `/api/auth/profile`, `/api/github/details`, and
the other NoxConnect APIs rather than Octokit or `api.github.com`. Native apps
receive NoxConnect `nox_at_…`/`nox_rt_…` sessions; they do not keep or forward
GitHub credentials after the one-time upgrade from an older release.

| Product | Owns | Shared NoxConnect plumbing it uses |
| --- | --- | --- |
| NoxFeed | Narration prompts, release-note policy, Posts/Release Notes Slack blocks, delivery-test content | GitHub event intake, org/project data, LLM provider invocation, channel selection, outbox and delivery |
| NoxSpot | Widget and capture runtime, issue rendering, feedback Slack blocks, delivery-test content | org/site administration, GitHub installation, destination selection, outbox and delivery |
| NoxTicket | Feature/backlog behavior and ticket Slack content | GitHub issue transport, org/repository selection, destination selection, outbox and delivery |
| NoxCue | Closed user-event validation, identity hashing, and Slack digest presentation | source/key administration, event facts, project metric selection, daily aggregation, destination selection, outbox and delivery |

## Runtime contracts

- NoxSpot exposes `noxspot.response` version 1 through the private `NOXSPOT_RESPONSE` service binding.
- NoxCue exposes `noxcue.response` version 1 through the private `NOXCUE_RESPONSE` service binding.
- NoxFeed exposes `noxfeed.response` version 1 through the private `NOXFEED_RESPONSE` service binding. Its Worker lives with the NoxFeed product under `service/`.
- NoxTicket currently has no independent service repository. Its response policy therefore lives under `functions/products/noxticket`, separated from `functions/lib` so extraction to a private binding is mechanical when that service is created.

Every adapter validates the contract version, structure, and Slack payload size before shared plumbing stores it. Product services receive only the data needed to render their response; they do not receive Slack tokens, connection IDs, or delivery state.

## Control plane versus product policy

The Admin UI and authenticated `/api` endpoints remain the control plane. They may read and write shared D1 configuration because that is setup and routing, not product behavior. Turning a product off keeps its data but gates its public/runtime paths. Product Workers own public product execution and presentation policy.

When adding behavior, use this rule: if the code answers “what should this product do or say?”, it belongs to that product. If it answers “who is connected, where should this go, and was it delivered?”, it belongs to NoxConnect.
