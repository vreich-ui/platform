# AI_CONTEXT — read this before touching the `platform` repo

> **Status:** verified against commit `6789644` (2026-09-05). This file is the entry point for an AI agent. It tells you where truth lives, what to ignore, and which document to open next. Root `AGENTS.md` / `CLAUDE.md` carry the *rules*; this file carries the *map*.

## 0. Thirty-second orientation

- This is a **multi-tenant, agent-first publishing engine** (Kugel platform), not a blog and not the AstroWind template it started from. `package.json` still says `@onwidget/astrowind`; ignore that.
- **Source of truth for content is the per-tenant object store in Netlify Blobs**, not git. `sites/<client>/data/site/**` is a `[GENERATED]` export written by the publish verb. Never hand-edit it; never treat it as canonical; never "fix" content by editing JSON in git.
- **Two-step go-live:** `object_publish` commits an export with `[skip netlify]` (dark); `release_to_production` fires the build hook. A publish receipt proves the export, never the deploy.
- **Engine vs tenant:** `packages/core/**` is fleet law (one implementation for every tenant); `sites/<client>/**` is per-tenant data + bindings. Root `netlify.toml`, `netlify/functions/**`, `astro.config.ts` belong to the **drlurie** tenant (root-deployed), not to "the platform".
- **Any change under `packages/core` that alters what a tenant's tree / `netlify.toml` / env / seeds must contain is incomplete until applied to every `sites/<client>` in the same change** (parity law P1, `docs/cms-architecture/16-genesis-parity-plan.md`).

## 1. Where things live

| You need… | Go to | Notes |
|---|---|---|
| The object envelope | `packages/core/schema/object-record-v1.ts` (`objectRecordSchema`, `objectTypes`, `publishReceiptSchema`, `producerContextSchema`) | 13 governed types; `version` (every write) vs `content_revision` (body writes only) |
| Body schemas | `packages/core/schema/bodies/<type>-v1.ts` | Zod v4, `.strict()`; version literal `<type>.v1` inside each file |
| Article model | `schema/bodies/content-item-v1.ts` (+ imports from `schema/article-content-v1.ts`), `packages/core/lib/richtext/rich-text-v1.ts` | node envelope outside, Rich Text inside; `private.*` never reaches export or page |
| Patch grammar | `packages/core/schema/object-patch-ops.ts` | 44 ops, every op invertible |
| Verbs (all write logic) | `packages/core/server/lib/object-verbs.ts:handleObjectVerb` | reached by `/mcp`, `object-store.ts` (publish key), `admin-object.ts` (JWT) |
| Validation | `packages/core/server/lib/object-validate.ts`, `object-validation-context.ts` | write-time guardrails (env leak, hotlinks, reader-projection leak, media paths, taxonomy refs) |
| Publish / release | `server/lib/object-publish.ts`, `publish-gate.ts`, `materializers/*.ts`, `object-git-committer.ts`, `production-release.ts`, `netlify-deploys.ts` | see `CONTENT_ARCHITECTURE.md` §5–6 |
| Exports the build reads | `sites/<client>/data/site/**` via `packages/core/app/content/collections.ts` | `__generated.from` names the record; `redirects.json` is the one file without the marker |
| Rendering | `packages/core/app/utils/blog.ts:fetchPosts`, `packages/core/lib/article-object/render-nodes.ts`, `packages/core/app/components/cms/PageObjectRenderer.astro`, `packages/core/lib/renderer/*`, `packages/core/components/sections/*.astro` + `lib/registry/components/index.ts` | one renderer for page and admin canvas |
| MCP server + tools | `packages/core/server/functions/mcp.ts`, `server/lib/mcp-tool-definitions.ts` + `-2.ts` + `-membership.ts`, `mcp-tool-handlers.ts`, `mcp-tool-annotations.ts` | 97 tools, count and tiers are test-pinned |
| Auth | `server/functions/mcp-oauth.ts`, `server/lib/{oauth-server,oauth-store,agent-keys,admin-auth,roles,users-store,caller-actor}.ts` | OAuth 2.1 / agent keys / shared token / Identity JWT / publish key |
| CMS-Agent bridge | `server/lib/agent/cms-agent-client.ts`, `server/lib/agent/{engine,loop,tools,generated-tools,registry}.ts`, `server/lib/requests/*`, `server/functions/editorial-request-sweep*.ts` | reasoning happens in CMS-Agent; tools execute here |
| pdf-tool bridge | `server/lib/pdf-tool-client.ts`, `pdf-tool-storage-grant.ts`, `packages/core/lib/pdf/*`, `server/lib/artifacts.ts` | bytes never travel through MCP; bodies carry `/img/{id}/{sha256}.ext` |
| Tracking | `packages/core/schema/tracking-event-v1.ts`, `schema/bodies/tracking-config-v1.ts`, `packages/core/lib/tracking/**`, `server/functions/track-ingest.ts`, `server/lib/tracking-events.ts`, `scripts/tracking-dims-push.mjs`, `server/functions/admin-analytics.ts` | sink is `vreich-ui/kugel-data` |
| Per-tenant seam | `sites/<client>/config/{site-binding,site-identity,approval-policy,creation-policy,media-policy,membership-policy,policy-bindings}.ts`, `site.config.ts`, `config.yaml`, `astro.config.ts`, `netlify.toml` | `SiteBinding` type: `packages/core/server/lib/site-binding.ts` |
| Admin app | `packages/core/admin/*.tsx` (React), `packages/core/lib/admin/*.ts` (pure logic + tests), `packages/core/app/routes/admin/**` (Astro shells), `packages/core/app/shell-routes.ts` | `/admin/*` is injected into every tenant |
| Provisioning / fleet | `packages/core/cli/{create-site,migrate-site,genesis-manifest,admin-parity}.mjs`, `scripts/site-genesis-drive.mjs`, `scripts/audit-site-admin-parity.mjs`, `scripts/fleet-capability-probe.mjs` | `npm run site:create · site:genesis · site:verify · fleet:parity · fleet:capability` |
| Env vars | `packages/core/server/lib/site-binding.ts:PLATFORM_ENV_NAMES`, `capability-status.ts` | table in `CMS_INTEGRATION.md` §Env var inventory and `DEPLOYMENT.md` §Environment variables |
| Tests | `tests/netlify/*.test.ts` (compiled via `tsconfig.test.json`), `tests/scripts/*.test.mjs`, co-located `*.test.ts` in `packages/core` | `npm test`; no DOM/component test stack — extract logic to `packages/core/lib/admin/` and test with `node:test` |

## 2. What must NOT be inferred from historical or template code

| Do not infer… | Because… | Read instead |
|---|---|---|
| Architecture from `docs/history/README-astrowind-template.md` or any AstroWind doc | The template's blog (`src/data/post/*.md`, `config.yaml` blog app, Decap CMS, Google Analytics vendor block) is either dead or repurposed | `ARCHITECTURE.md` §10 |
| That Markdown/MDX is the content format | The `post` collection is permanently empty (`src/data/post/.gitkeep`); MDX is registered but zero `.mdx` files exist | `CONTENT_ARCHITECTURE.md` §13 |
| That `publish-article.ts`, `save_json_blob_*`, Clerk, ChatKit, `admin-workflow-lock.ts`, `/admin/publish`, `/admin/traffic` are live | Deleted 2026-07-23 / 2026-07-29; the `/admin/traffic` *page* is a 301 to `/admin/analytics` and the `admin-traffic` *function* is a one-line re-export shim | `CMS_INTEGRATION.md` §Legacy / retired |
| That `run-publisher-agent.ts` is a publishing path | Deployed on all tenants but has **no live caller**; retirement is an open decision | `KNOWN_ISSUES.md` |
| That `sites/<client>/seeds/*.mjs` are current content | Seeds are genesis input and drift; the store is authoritative afterwards | `CONTENT_ARCHITECTURE.md` §2 |
| That `sites/drlurie/assets/**/uploads/**` are article images | 139 orphaned files from the deleted markdown pipeline; live articles use `/img/{id}/{sha256}.ext` served from blobs | `CONTENT_ARCHITECTURE.md` §8 |
| That `docs/cms-architecture/**` plans describe what exists | They are plans, briefs and session logs; many items were never built or were later deleted. `state-of-play.md` is 524 KB — grep, never read whole | the six docs listed at the top of `ARCHITECTURE.md` |
| That the root `tsconfig.json` aliases apply to every tenant | `@site/*` and `~/assets/*` are pinned to drlurie; real per-site aliases are set in `packages/core/app/site-astro-config.ts` | `DEPLOYMENT.md` §Configuration files |
| That `check:astro` / CI `fleet` matrix verified a non-drlurie tenant | Both load the default (drlurie) config | `DEPLOYMENT.md` §CI |
| That an `exposure`/`variant_id` experiment pipeline exists | kugel-data has the views; the platform enum has neither the kind nor the prop | `TRACKING_ARCHITECTURE.md` §13.14 |
| That tracking feeds CMS-Agent learning | No call site; `/rollups` is unread; doc-only | `TRACKING_ARCHITECTURE.md` §10, §15 |
| Contract names like `object_record.v1`, `article_content.v1`, `materialization_spec.v1`, `artifact_plan.v1` | They do not exist as literals in this repo | `DATA_CONTRACTS.md` §1 |

## 3. Hard invariants to preserve when changing code

1. `private.*` is stripped from every export regardless of repo visibility (`server/lib/materializers/shared.ts:stripPrivate`); the renderer emits only `public` fields of `visibility === 'public'` nodes; the validator scans the reader projection. Keep all three in lockstep.
2. `version` and `content_revision` are independent counters; lock/publish writes bump `version` only.
3. Materialization is deterministic (`canonicalJsonStringify`; `at`/`record_version` are inputs) so a retried publish no-ops at the committer.
4. `[skip netlify]` is appended by `object-publish.ts`, not by the committer; release is the only build trigger.
5. Every `process.env` read goes through `SiteBinding` env *names*; core never contains a site literal (`tests/scripts/core-no-site-literals.test.mjs`).
6. Never write the literal value of `GITHUB_REPOSITORY` (the repo's `owner/name`) or any full `https://github.com/<owner>/<repo>/…` URL into committed content — Netlify's secrets scanner fails the build on it (`SECRETS_SCAN_OMIT_KEYS` mitigates, do not rely on it). Reference PRs as `#NNN`.
7. Tool count, tool tiers and plugin allow-lists are test-pinned (`server/lib/mcp-tool-definitions.test.ts`, `tests/netlify/plugin-manifest.test.ts`) — extend those tests, never add a parallel file.
8. Every membership verb — reads included — requires a human principal (`server/lib/membership/verbs.ts:332` 403s `membership_requires_human`); `/admin/accept` is the only consumer of Netlify Identity tokens.
9. Enabling any tracking provider requires its CSP hosts in every `netlify.toml` in the same change (`tests/netlify/csp-drift.test.ts`).

## 4. Verification you can run

```
npm ci
npm run check            # astro check (drlurie config) + eslint + prettier
npm test                 # 5188 tests at 6789644, ~3 min, offline
npm run build            # drlurie, 107 pages; prebuild image gate; postbuild dims push no-ops without env
npx astro build --config sites/<client>/astro.config.ts   # any other tenant → sites/<client>/dist
npm run fleet:parity     # repo-only parity audit
```

## 5. Document map

| Question | Document |
|---|---|
| What is this and how do the pieces fit? | [`ARCHITECTURE.md`](ARCHITECTURE.md) · plain-language: [`OVERVIEW.md`](OVERVIEW.md) |
| Where does an article come from and how does it render? | [`CONTENT_ARCHITECTURE.md`](CONTENT_ARCHITECTURE.md) |
| Every interface, its auth, its failure mode | [`CMS_INTEGRATION.md`](CMS_INTEGRATION.md) |
| Every schema and cross-boundary contract | [`DATA_CONTRACTS.md`](DATA_CONTRACTS.md) |
| Tracking, identifiers, privacy, feedback-loop readiness | [`TRACKING_ARCHITECTURE.md`](TRACKING_ARCHITECTURE.md) |
| Netlify projects, env vars, CI, scripts, release protocol | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| What is broken or drifting, with severity | [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) |
| Vocabulary | [`GLOSSARY.md`](GLOSSARY.md) |
| Diagrams (Mermaid sources + SVG) | [`diagrams/`](diagrams/) |
| Agent publishing procedure (tool sequence, gates, recovery) | [`agents/publishing-policy.md`](agents/publishing-policy.md) |
| Governing rulings and plans (history, not implementation) | `docs/cms-architecture/decisions/*`, `docs/cms-architecture/*.md`, `docs/history/*` |
