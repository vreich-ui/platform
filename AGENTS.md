# AGENTS.md — rules for any agent working in the `platform` repo

> Rewritten 2026-09-05 from the accumulated rule files; the previous versions are archived verbatim at `docs/history/AGENTS-2026-09-05.md` and `docs/history/CLAUDE-2026-09-05.md` (history, not law). **Map first, rules second:** read [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md) before touching anything. `CLAUDE.md` points here; this file is canonical.

## 1. What you are working on

A white-label, multi-tenant, **agent-first publishing engine**. `packages/core/**` is fleet law (one implementation, every tenant); `sites/<client>/**` is per-tenant data and bindings; the root `netlify.toml` / `netlify/functions/**` / `astro.config.ts` belong to the **drlurie** tenant. Content truth is the per-tenant Netlify Blobs object store; `sites/<client>/data/site/**` is a **generated** export. Architecture and evidence: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the documents it links.

## 2. Governing rulings still in force (Wolf)

| Ruling | Meaning in practice | Record |
|---|---|---|
| **Agents edit objects on every page through MCP** — "converted" has five criteria: renders from the object · store-backed · round-trips every permitted action via MCP · contract-complete (`object_contract` + real tool) · recorded (`docs/cms-architecture/object-inventory.md` + `conversion-map.md`) | No half measures: a "convert X" task is done only when all five hold. Rendering-only work is "rendered, not converted" | `docs/cms-architecture/conversion-playbook.md` (2026-07-10) |
| **Flexible objects, not a site replica** | Prefer reusable, agent-configurable components (a `content_grid` an agent can repoint) over bespoke per-page types. If an agent cannot repoint it without a code change, generalize it | `docs/cms-architecture/design-principles.md` |
| **Contentful content model** | Typed entries + `rich_text.v1` for rich fields; no HTML strings | `docs/cms-architecture/core-structure.md` |
| **R8 finish-line directive** | Make reasonable decisions, record them, keep moving; halt only on genuine account-authority gates | `docs/cms-architecture/decisions/2026-07-26-platform-site-ruling.md` |
| **Parity laws P1–P5** | P1: a `packages/core` change that alters what a tenant's tree / `netlify.toml` / env / seeds must contain is incomplete until applied to every `sites/<client>` in the same change. P2: a new env var lands in the env table + `ENV_CHECKLIST` + every site (or degrades with a catalogued `error_code`) and is covered by the capability probe. Tool surfaces are uniform except via `OPTIONAL_HANDLER_TOOLS` with a recorded ruling | `docs/cms-architecture/16-genesis-parity-plan.md` |
| **Membership verbs are human-only** (reads included); every Netlify Identity token lands on `/admin/accept` | `handleMembershipVerb`'s first line 403s `membership_requires_human` for any agent principal — for `list` as much as for `purge`; never consume an Identity token elsewhere | `docs/cms-architecture/18-membership-plan.md`; gate at `packages/core/server/lib/membership/verbs.ts:332` |
| **A request is a record, not a chat** | `req_<flow>_<topic>_<yyyymmdd>_<nn>` is the correlation key; only the sweep writes a running request's status; red means a step *died*, a held gate is amber | `docs/cms-architecture/19-editorial-requests-plan.md` |
| **PDF: one-call render, warn-only quality** | Use `render_article_pdf`; quality findings never block; only typed pdf-tool failures are failures | `docs/cms-architecture/decisions/2026-09-03-pdf-fortification-rulings.md` |
| **Autonomous publishing is the default**; every gate has an id; per-tenant policy may set a type to require approval | `sites/<client>/config/approval-policy.ts`; `content_item` is autonomous on drlurie | `docs/agents/publishing-policy.md` |
| **The publishing-plugin charter is never widened** | The charter is *derived*, not hand-kept: tool classes `read`/`draft`/`creation`/`publication`, plus `release_to_production` by name, minus `PLUGIN_TOOL_DENYLIST`. Adding a class, adding a name to the privileged allow-list or removing a denylist entry needs a ruling. It is a **charter, not a permission boundary** — enforced (403 `tool_not_in_plugin_charter`) only on `/api/plugin/*`; on `/mcp` the same list is advisory | `packages/core/server/lib/plugin/build-tools.ts` (constraint restated at `docs/plugin/recon-genesis.md:86`) |
| **Article sourcing** | Every `content_item` carries sources for its claims; the system warns on missing sources, never blocks (`article_claim_substrate`) | `packages/core/server/lib/object-validate.ts:45,2366-2378`; procedure in `docs/agents/publishing-policy.md` |

## 3. Hard constraints — every task

1. **Never hand-edit `sites/<client>/data/site/**`** or treat it as canonical; never "fix" content by editing JSON in git. Content changes go through the object verbs.
2. **Additive, minimal diffs.** The public site must remain fully functional after every commit. One task, one commit (or one squashed commit per wave), minimal diff; flag unrelated cleanup separately.
3. **Do not change functional architecture to make documentation simpler.** Document reality; open a `KNOWN_ISSUES.md` entry for what should change.
4. **Deleting a file requires verifying every importer first** (`rg`), not a task's say-so.
5. **`version` and `content_revision` are independent**; lock and publish writes bump `version` only.
6. **`route`-kind navigation targets are deliberate** — do not "fix" them to `page`-kind before the page object exists.
7. **Never commit the literal value of `GITHUB_REPOSITORY`** (this repo's `owner/name`) or any full `https://github.com/<owner>/<repo>/…` URL: Netlify's secrets scanner fails the build. Reference PRs as `#NNN`. `SECRETS_SCAN_OMIT_KEYS` is a backstop, not permission.
8. **Tool count, tool tiers and plugin allow-lists are test-pinned** (`packages/core/server/lib/mcp-tool-definitions.test.ts`, `tests/netlify/plugin-manifest.test.ts`). Extend those tests; never add a parallel test file.
9. **Enabling a tracking provider ships its CSP hosts in every `netlify.toml` in the same change** (`tests/netlify/csp-drift.test.ts`).
10. **Core never contains a site literal** (`tests/scripts/core-no-site-literals.test.mjs`); env is read through `SiteBinding` names.
11. **Retired mechanisms stay retired.** `publish-article.ts`, `save_json_blob_*`, per-stage workflow tools, Clerk auth, `admin-workflow-lock.ts` and `/admin/publish` are deleted with no successor. `/admin/traffic` is retired behind a 301 to `/admin/analytics`, and its function URL keeps a one-line re-export shim marked for deletion. The unbuilt ChatKit widget JSON under `src/chatkit/` is dead residue, not a live path. A doc or comment naming any of them describes history — do not resurrect or pattern-match against one.
12. **`content_item` creation from admin chat is refused (ART-1)**; the plugin and CMS-Agent create articles directly over the tenant `/mcp` object verbs.

## 4. Testing conventions

- `npm test` runs three stages: `tsc -p tsconfig.test.json` + `node --test` over `tests/netlify/**`, then `tests/scripts/*.test.mjs`, then `packages/core/cli/capture/*.test.mjs`. 5,188 tests at `6789644`, offline.
- **Logic-first, no new deps.** There is no DOM/component test stack and `tsconfig.test.json` excludes `packages/core/admin/**/*.tsx`. Extract each UI decision into a pure module under `packages/core/lib/admin/` and test it with `node:test`. Never add jsdom / testing-library. ESLint's `react-hooks/rules-of-hooks` is the *only* gate on hook-order bugs in `.tsx`.
- Every task ships its own acceptance test. Repo-wide invariants go in `tests/scripts/*.test.mjs`.
- `npm run check:astro` and the CI `fleet` matrix only exercise drlurie's config; build another tenant explicitly with `npx astro build --config sites/<client>/astro.config.ts` when you touch it.
- An **adversarial review pass over the final diff is mandatory before delivery** — green tests do not cover `.tsx`, and the review has caught crash-level bugs in every wave so far. The reviewer applies its own fixes.

## 5. Delivery and git

- Work on a branch named for the task/wave; **never push to `main` directly**.
- **Delivery = branch + pull request on GitHub** (via the GitHub connector when the sandbox cannot push). Merge only when the wave's brief or Wolf authorizes it. The former `land.command` patch-zip delivery is superseded (2026-09-05) and must not be reintroduced.
- Per-milestone commits with the task id first (`T21.9b: …`), not one end-of-session commit. PR bodies state what landed and what needs Wolf's hands.
- Content exports commit with `[skip netlify]`; a code push builds every tenant whose `ignore` rule matches. Never fire a production release as a side effect of a code task.

## 6. Where the procedures live

| Need | Read |
|---|---|
| Publishing an article as an agent (tool sequence, media rules, gates, recovery) | `docs/agents/publishing-policy.md` (authoritative; supersedes older `docs/agents/*.md` sequences) |
| Converting a surface to an object | `docs/cms-architecture/conversion-playbook.md` (recipe + trap table) |
| Provisioning a tenant | `docs/cms-architecture/new-client-acceptance.md`, `site-provisioning-runbook.md`, `secrets-runbook.md` |
| Object catalogue (hand-maintained, drifts) | `docs/cms-architecture/object-inventory.md`; prefer the `object_inventory` / `object_contract` MCP tools for live truth |
| Task briefs and queue | `docs/cms-architecture/cms-pipeline/T<phase>.<n>-*.md`, `queue.tsv` — check `depends_on` and `mode` (`checkpoint` waits for Wolf; `human_gate` needs a human action) |
| What is known broken | `docs/KNOWN_ISSUES.md` |

## 7. Tenant notes

- MCP connector names are per tenant (`sites/<client>/config/site-identity.ts:mcpServerName`): `Dr_Lurie_MCP_Server`, `Platform_MCP_Server`, `Zilberman_MCP_Server`, `Fernwell_MCP_Server`. Production ChatGPT/Claude connect to `https://<host>/mcp`.
- drlurie's shared asset host `https://kugelmedia.netlify.app` is for favicon/editor hints only; article media must be `/img/{id}/{sha256}.ext` artifacts.
- If a client reports `No tool was defined under the given paths`, verify the deployed `/mcp` with `initialize` + `tools/list` before touching tool names or schemas.
- `/shop` mobile rules: `docs/agents/shop-layout.md` (drlurie only).
