# NoxConnect

NoxConnect is the shared GitHub, Slack, identity, and delivery foundation for the Nox product suite. It keeps provider access and organization data in one place while NoxFeed, NoxTicket, NoxSpot, and NoxCue own their product-specific views, setup, and behavior.

The hosted workspace at [app.noxhere.com](https://app.noxhere.com) is branded **Nox**. The **NoxConnect** name is reserved for this connection layer, its API, and the shared GitHub and Slack app identities.

The separate one-page product site for [noxhere.com](https://noxhere.com) lives
in [`nox-site/`](./nox-site/) and deploys to its own static Cloudflare Pages
project. It deliberately shares no application bindings or credentials.
The retired `app.unticket.ai` host is a redirect-only deployment maintained in
[`legacy-redirect/`](./legacy-redirect/); it does not run the application or API.

- **NoxConnect** — GitHub/Slack connections, project-owned multi-workspace routing, organization identity, people, repositories, issues, and pull-request plumbing
- **NoxFeed** — current work, activity feed, issues, and release narratives
- **NoxTicket** — features, backlog, specs, and board stages
- **NoxSpot** — feedback widgets, sites, reports, and screenshots
- **NoxCue** — closed user lifecycle events, governed feature health, immediate critical-error alerts, and project-configurable daily reports

**Hosted (free):** [app.noxhere.com](https://app.noxhere.com) · **Self-host:** see [DEPLOY.md](./DEPLOY.md) · **Architecture:** see [ARCHITECTURE.md](./ARCHITECTURE.md) · **Local E2E:** see [docs/LOCAL_E2E.md](./docs/LOCAL_E2E.md) · **Staging provider gate:** see [docs/STAGING_ACCEPTANCE.md](./docs/STAGING_ACCEPTANCE.md)

> **License:** NoxConnect is **source-available** under the [PolyForm Noncommercial License 1.0.0](./LICENSE) — free for any non-commercial use, modify and self-host freely, but **commercial use is not permitted**. It is not an OSI "open source" license. See [LICENSE](./LICENSE).

## Quick start (local dev)

```bash
npm install
npm run dev
```

Open http://localhost:5173 only when maintaining the compatibility UI. The production public application and all user authentication live in NoxHere. Authenticated connector requests arrive only through NoxHere's private service binding with a signed internal assertion; GitHub provider tokens are never public API credentials.

Set `VITE_API_TARGET` in `.env.local` to point the dev proxy at your own deployment. See [.env.example](./.env.example) for all configuration.

## Authentication boundary

- **NoxHere** owns GitHub sign-in, browser/native sessions, CSRF, and project-scoped API-token lifecycle.
- **NoxConnect** completes the private provider exchange, encrypts provider credentials, and resolves only opaque connection IDs carried in verified NoxHere assertions.
- **Direct provider tokens are rejected** as public Nox API credentials.

Hosted browser sign-in creates an opaque HttpOnly NoxHere session. Automation uses expiring NoxHere API tokens bound to one organization, one enabled project, and explicit project-safe service scopes. GitHub access and refresh tokens remain encrypted only in NoxConnect.

## Stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS, TanStack Query, Radix UI, Lucide icons
- **Backend:** Cloudflare Pages Functions + D1 (SQLite), a sibling cron Worker, Cloudflare Queues + R2
- **Testing:** Vitest + Testing Library

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run e2e:local` | Build and exercise the complete local multi-service stack |
| `npm run e2e:staging:preflight` | Verify the isolated deployed topology without provider writes |
| `npm run e2e:staging` | Run explicitly confirmed real provider writes against staging only |
| `npm test` | Run the Vitest suite |
| `npm run lint` | ESLint |
| `npm run typecheck` | Frontend type-check |
| `npm run typecheck:functions` | Backend (Functions + cron) type-check |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](./SECURITY.md).

## Privacy

Self-hosted instances keep all data in your own Cloudflare account. For the hosted instance, see [PRIVACY.md](./PRIVACY.md) and [TERMS.md](./TERMS.md).
