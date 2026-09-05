# NoxConnect

NoxConnect is the shared GitHub, Slack, identity, and delivery foundation for the Nox product suite. It keeps provider access and organization data in one place while NoxFeed, NoxTicket, NoxSpot, and NoxCue own their product-specific views, setup, and behavior.

- **NoxConnect** — GitHub/Slack connections, organization identity, people, repositories, issues, and pull-request plumbing
- **NoxFeed** — current work, activity feed, issues, and release narratives
- **NoxTicket** — features, backlog, specs, and board stages
- **NoxSpot** — feedback widgets, sites, reports, and screenshots
- **NoxCue** — closed user lifecycle events, governed feature health, immediate critical-error alerts, and project-configurable daily reports

**Hosted (free):** [app.unticket.ai](https://app.unticket.ai) · **Self-host:** see [DEPLOY.md](./DEPLOY.md) · **Architecture:** see [ARCHITECTURE.md](./ARCHITECTURE.md) · **Local E2E:** see [docs/LOCAL_E2E.md](./docs/LOCAL_E2E.md)

> **License:** NoxConnect is **source-available** under the [PolyForm Noncommercial License 1.0.0](./LICENSE) — free for any non-commercial use, modify and self-host freely, but **commercial use is not permitted**. It is not an OSI "open source" license. See [LICENSE](./LICENSE).

## Quick start (local dev)

```bash
npm install
npm run dev
```

Open http://localhost:5173. By default the dev server proxies `/api/*` to the hosted instance; the local read-only development UI can use a GitHub personal access token (`repo`, `read:org` scopes). This is a development convenience, not a third-party authentication contract for the hosted API. To run the full stack (backend Functions, D1, OAuth) against your own infrastructure, follow [DEPLOY.md](./DEPLOY.md).

Set `VITE_API_TARGET` in `.env.local` to point the dev proxy at your own deployment. See [.env.example](./.env.example) for all configuration.

## Auth modes

- **GitHub App + OAuth** (recommended for self-host/production) — "Sign in with GitHub", real-time webhooks, refresh-token rotation. Requires registering your own GitHub App.
- **Personal Access Token (local development only)** — works with zero backend setup, but is read-only: webhooks can't be created in PAT mode, so data is only as fresh as the last manual sync. Production users sign in through GitHub App OAuth; production automation uses scoped NoxConnect API tokens.

Hosted browser sign-in creates an opaque HttpOnly NoxConnect session; GitHub access and refresh tokens remain encrypted server-side. Automation uses expiring `nox_sk_…` API tokens bound to one organization, one enabled project, and explicit project-safe service read/write scopes. Public NoxCue/NoxSpot ingestion keys and private Worker service bindings remain separate credential classes.

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
| `npm test` | Run the Vitest suite |
| `npm run lint` | ESLint |
| `npm run typecheck` | Frontend type-check |
| `npm run typecheck:functions` | Backend (Functions + cron) type-check |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](./SECURITY.md).

## Privacy

Self-hosted instances keep all data in your own Cloudflare account. For the hosted instance, see [PRIVACY.md](./PRIVACY.md) and [TERMS.md](./TERMS.md).
