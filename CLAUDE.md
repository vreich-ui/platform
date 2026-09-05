# CLAUDE.md — the `platform` repo

> The canonical rules are in [`AGENTS.md`](AGENTS.md); the map is [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md). Read both in full before writing code. This file is deliberately short: it repeats only what a Claude session most often gets wrong, and adds Claude-specific working notes. The previous 33 KB CLAUDE.md is archived verbatim at `docs/history/CLAUDE-2026-09-05.md` — it is history (paths under `src/…` and `netlify/lib/…` there predate the W11/W14 relocation into `packages/core/…`), not current law.

## The ten things to get right

1. **Content truth is the per-tenant Netlify Blobs object store.** `sites/<client>/data/site/**` is a generated export — never hand-edit it, never treat it as canonical. Seeds (`sites/<client>/seeds/*.mjs`) are genesis input and drift afterwards.
2. **Publish ≠ release.** `object_publish` commits an export with `[skip netlify]` (dark); `release_to_production` fires the one build hook. A `publish_receipt` proves the export, never the deploy.
3. **Engine vs tenant.** `packages/core/**` is fleet law; `sites/<client>/**` is per-tenant. Root `netlify.toml`, `netlify/functions/**`, `astro.config.ts`, `package.json` build scripts are **drlurie's** (root-deployed tenant). Parity law P1: a core change that alters what a tenant tree must contain is incomplete until applied to every tenant in the same change.
4. **Every content write is an object verb.** All writes to governed objects go through `packages/core/server/lib/object-verbs.ts:handleObjectVerb` whether they arrive over `/mcp`, `/api/plugin/*`, `object-store.ts` (publish key) or `admin-object.ts` (Identity JWT). There is no other write path *into the object store*. (Membership, governance overrides, tracking events, commerce events and artifact bytes are separate stores with their own gates — `membership/verbs.ts`, `governance-store.ts`, `tracking-events.ts`, `commerce-events.ts`, `artifacts.ts`.)
5. **Retired means gone.** `publish-article.ts`, `save_json_blob_*`, per-stage workflow tools, Clerk auth, `admin-workflow-lock.ts` and the vanilla-JS admin pages are deleted with no successor. `/admin/traffic` 301s to `/admin/analytics` and its function URL keeps a one-line re-export shim (delete-on-next-cleanup); the ChatKit widget JSON under `src/chatkit/` is unbuilt dead residue. `run-publisher-agent.ts` is deployed but has no live caller (open decision, `docs/KNOWN_ISSUES.md` #28). Do not resurrect or pattern-match against any of them.
6. **`private.*` never leaves the store.** Stripped by `materializers/shared.ts:stripPrivate`; the renderer emits only `public` fields of public-visibility nodes; the validator scans the reader projection. Keep all three in lockstep.
7. **`version` vs `content_revision`** are independent counters; lock/publish writes bump `version` only. Approvals pin a `content_revision`.
8. **Secrets scanner.** Never commit the literal value of `GITHUB_REPOSITORY` (this repo's `owner/name`) or a full `https://github.com/<owner>/<repo>/…` URL. Write `#NNN`.
9. **Tests are test-pinned law.** Tool count/tiers, plugin allow-lists, CSP hosts, core-no-site-literals, netlify.toml ↔ `site.config.ts` drift — extend the existing test, never add a parallel one. No DOM test stack: extract UI decisions into `packages/core/lib/admin/*.ts` and test with `node:test`.
10. **Docs are hints, code is truth.** `docs/cms-architecture/**` is plans, briefs and session logs (`state-of-play.md` is 524 KB — grep it, never read it whole). The verified architecture docs are the ones linked from `docs/AI_CONTEXT.md`.

## Claude-session working notes

- **Delivery:** branch + pull request on GitHub (the GitHub connector when the sandbox cannot push); merge only when the wave's brief or Wolf authorizes. The `land.command` patch-zip route is superseded (2026-09-05).
- **Sub-agents:** file-disjoint tasks may run in parallel `git worktree`s off one work branch (symlink `node_modules` from the main clone so `tsc`/`eslint`/tests run there); same-file tasks serialize; merge back, then squash. One shared brief file beats repeating context per prompt. Brief them so refusal-with-reasons is an acceptable outcome.
- **Adversarial review is a required stage**, not optional: review the squashed diff, and let the same reviewer apply the fixes.
- **Cost:** prefer `rg` + targeted `Read` with offsets; do not cat large docs; reserve the most expensive model for architecture-level investigation.
- **Verification that exists:** `npm ci` · `npm run check` · `npm test` (5,188 tests, offline, ~3 min) · `npm run build` (drlurie) · `npx astro build --config sites/<client>/astro.config.ts` · `npm run fleet:parity`. `check:astro` and CI's `fleet` matrix only ever load drlurie's config.
- **Task briefs** under `docs/cms-architecture/cms-pipeline/` carry `depends_on`, `mode`, model/effort. `checkpoint` tasks wait for Wolf's answer; `human_gate` tasks stop at the human step.
- **Naming:** commit subject starts with the task id (`T21.9b: …`); editorial requests are `req_<flow>_<topic>_<yyyymmdd>_<nn>` and double as the `content_item` id.
- **When in doubt about a tenant fact**, ask the tenant: `object_contract` / `object_inventory` / `capability_status` over its `/mcp` beat any committed doc.
