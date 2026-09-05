# Kugel Platform — agent-first publishing engine (`platform` repo)

> **Not the AstroWind template any more.** This repository started as [AstroWind](https://github.com/arthelokyo/astrowind) (Astro 5 + Tailwind) and has been rebuilt in place into a **white-label, multi-tenant, agent-first CMS and publishing fleet**. The original template README is preserved at [`docs/history/README-astrowind-template.md`](docs/history/README-astrowind-template.md); nothing in it describes the current architecture. `package.json` still carries the template's name — that is residue, not identity.
>
> **AI agents:** read [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md) first, then [`AGENTS.md`](AGENTS.md). **Humans:** read [`docs/OVERVIEW.md`](docs/OVERVIEW.md).

## What it is

One engine (`packages/core/`) renders and governs many tenant sites (`sites/<client>/`). Content is a set of typed JSON **objects** (pages, sections, articles, navigation, taxonomy, themes, products…) living in each tenant's **Netlify Blobs object store**. AI agents and humans change objects only through governed **verbs** (checkout → patch → validate → publish → release), reached over each tenant's own **MCP endpoint** (`/mcp`, OAuth 2.1), a ChatGPT Actions façade, or the admin UI. Publishing **materializes** objects into committed JSON exports (`sites/<client>/data/site/**`, generated — never hand-edit) and a separate **release** fires the Netlify build that turns exports into static HTML. Reader behaviour is measured by a first-party tracker whose sink lives in a separate repo.

| Tenant | Host | Deployment |
|---|---|---|
| `drlurie` | drluriescience.netlify.app | root-deployed (root `netlify.toml`, `netlify/functions/**`, `astro.config.ts` are *this tenant's*) |
| `platform` | kugel-platform.netlify.app | base dir `sites/platform` — the project's own site/wiki, a tenant like any other |
| `zilberman` | zilbermanfilmfoundation.netlify.app | base dir `sites/zilberman` |
| `fernwell` | kugel-fernwell.netlify.app | base dir `sites/fernwell` — repeatability proof |

Sibling repositories (not vendored here): **`vreich-ui/cms-agent`** (autonomous workflow/agent plane — reasons, and publishes through each tenant's `/mcp`), **`vreich-ui/pdf-tool`** (artifact foundry for images/PDFs/templates; returns references, never bytes), **`vreich-ui/kugel-data`** (tracking sink: Netlify Database + stats/rollups).

## Inherited AstroWind vs Kugel architecture

| | Inherited from AstroWind | Kugel platform (this project) |
|---|---|---|
| **Still load-bearing** | `vendor/integration/**` (loads `sites/*/config.yaml` as `astrowind:config`), `packages/core/app/layouts/{Layout,PageLayout}.astro`, `app/components/{blog,common,ui}/*`, `widgets/{Header,Footer,BlogHighlightedPosts}.astro`, `app/utils/{blog,permalinks,images,images-optimization,frontmatter}.ts`, `sites/*/app/pages/[...blog]/**`, `tailwind.config.js` | Everything under `packages/core/{schema,lib,server,admin,components,cli}`, `packages/core/app/{admin,routes,components/{cms,tracking},content,site-astro-config.ts,shell-routes.ts,site-redirects-integration.ts}`, all `netlify/**` functions, `scripts/**`, `tests/**`, every `sites/<client>/{config,seeds,data,netlify}` |
| **Dead residue** | `packages/core/app/components/widgets/*` (19 of 22 — everything but `Header`, `Footer`, `BlogHighlightedPosts`), `sites/drlurie/app/pages/homes/*`, `layouts/MarkdownLayout.astro`, `sites/drlurie/public/decapcms/`, root `Social/`, `Dockerfile`, `docker-compose.yml`, `nginx/`, `vercel.json`, `sandbox.config.json`, `.stackblitzrc`, `.vscode/astrowind/`, the empty `post` collection (`src/data/post/`) | Deprecated-but-wired: `run-publisher-agent.ts`, `save-artifact.ts`, `admin-traffic.ts`; experimental: `packages/core/cli/capture/**` |
| **Content model** | Markdown posts with frontmatter (retired 2026-07-29; zero `.md` posts remain) | Typed JSON objects, `content_item` articles with `rich_text.v1` bodies (Contentful Rich Text model), materialized to JSON exports |
| **Analytics** | `config.yaml` `analytics.vendors.googleAnalytics` block (unused) | `tracking_event.v1` own tracker → kugel-data; Netlify Analytics feed; `/admin/analytics` |

Full classification with evidence: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §10.

## Repository layout

```
packages/core/           engine (fleet law) — schema · lib · server · admin · components · app shell · cli
sites/<client>/          tenant — config · seeds · data/site (GENERATED exports) · app/pages · netlify/functions shims
netlify/, netlify.toml   drlurie's root deployment (functions shims + routing)
scripts/                 provisioning, genesis, tracking dims push, audits, one-off remediations (see DEPLOYMENT.md)
tests/                   node:test suites (tests/netlify compiled via tsconfig.test.json; tests/scripts)
docs/                    architecture docs (below) · cms-architecture plans & decisions · agents/ procedures · history/
vendor/integration/      inherited AstroWind config integration (live)
```

## Commands

| Command | Does |
|---|---|
| `npm ci` | install (Node 20 in production; see `DEPLOYMENT.md` on the `.nvmrc` mismatch) |
| `npm run dev` | drlurie dev server (pages only; functions need Netlify) |
| `npm run build` | drlurie: prebuild image gate → `astro build` → postbuild tracking dims push (no-ops without env) |
| `npx astro build --config sites/<client>/astro.config.ts` | any other tenant → `sites/<client>/dist` |
| `npm run check` | `astro check` (drlurie config only) + eslint + prettier |
| `npm test` | 5,188 tests at `6789644`, offline, ~3 min |
| `npm run site:create` / `site:genesis` / `site:verify` | scaffold and seed a new tenant |
| `npm run fleet:parity` / `fleet:capability` | cross-tenant parity audit / live capability probe |

## Documentation

| Document | Purpose |
|---|---|
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | Plain-language summary with diagrams (for humans) |
| [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md) | Entry point for agents: where truth lives, what not to infer |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System map, tenant runtime, classification, extension points |
| [`docs/CONTENT_ARCHITECTURE.md`](docs/CONTENT_ARCHITECTURE.md) | Object model, article schema, materialization, build & render, one article traced end to end |
| [`docs/CMS_INTEGRATION.md`](docs/CMS_INTEGRATION.md) | Every interface: MCP, OAuth, GitHub, Netlify, CMS-Agent, pdf-tool, plugin, commerce, tracking |
| [`docs/DATA_CONTRACTS.md`](docs/DATA_CONTRACTS.md) | Schemas, version tags, cross-boundary contracts, duplicates |
| [`docs/TRACKING_ARCHITECTURE.md`](docs/TRACKING_ARCHITECTURE.md) | Event taxonomy, identifiers, privacy, sink, feedback-loop readiness |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Netlify projects, env vars, CI, scripts, release protocol, verification log |
| [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) | Defects and drift with severity |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Vocabulary |
| [`docs/diagrams/`](docs/diagrams/) | Mermaid sources + rendered SVGs |
| [`docs/agents/publishing-policy.md`](docs/agents/publishing-policy.md) | The agent-facing publishing procedure |
| `docs/cms-architecture/` | Plans, briefs, decisions and session logs — history and intent, **not** implementation |

## License

The repository still carries the upstream MIT `LICENSE.md` (onWidget, 2023) that covers the inherited template code.
