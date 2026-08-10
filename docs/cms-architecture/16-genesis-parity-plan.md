# 16 — Genesis scope + fleet parity plan (W16)

**Status: governing plan, ratified by Wolf's 2026-08-10 directive ("Genesis should
produce identical basic structure … any ongoing change made to the core must be
added to all sites existing and new"). Execution rows: `cms-pipeline/queue.tsv`,
W16 block. Briefs: `cms-pipeline/T16.*.md`.**

This doc does three things: (1) records the 2026-08-10 fleet audit findings —
what actually diverges between the three tenants and why; (2) draws the line
that defines what genesis owns; (3) states the parity law that governs every
core change from now on. Sections 2 and 3 are LAW; section 1 is evidence.

---

## 1. Audit findings (2026-08-10)

Audited: full repo tree (drlurie 293 site files / platform 127 / fernwell 87),
the three netlify.toml files, config bundles, shims, seeds, committed exports,
MCP tool surface, and a live probe of the Platform `/mcp` PDF/artifact family.

### 1.1 The reported symptom, root-caused

"Platform can't use the PDF tool while Dr-Lurie works" is a **call-time env
gap, not a registration gap**. Every site's MCP advertises the identical tool
list (sole exception: `verify_article_images`, deliberately shim-gated via
`OPTIONAL_HANDLER_TOOLS`). But nine tool families are env-gated at call time
(PDF bridge, storage grant, commerce/Stripe, build hook, deploy lookup, git
committer, blob credentials …) and return `*_not_configured` 503s when a site's
Netlify env lacks the values. `kugel-platform`'s pdf-tool storage grant was
only cut over on 2026-08-04 and was never round-trip verified — before that
date the symptom was exactly as reported. A live probe on 2026-08-10
(`list_pdf_templates`, `search_artifacts`, `list_artifacts_by_kind kind=pdf`
against the Platform connector) shows the family working NOW: 4+ active
templates, PDF artifacts rendered 2026-08-05/06. The class of failure remains
unguarded — nothing in the fleet detects a tool that lists but 503s on one
tenant. That is T16.5.

### 1.2 Structural findings

1. **The genesis seam is enforced in three unsynchronized lists**: `buildPlan()`
   in `packages/core/cli/create-site.mjs`, `SEED_MODULES` in
   `scripts/site-genesis-drive.mjs`, and `DATA_SITE_SUBDIRS`. Both 2026-08-05
   addenda were the same failure (added to one list, not the others). → T16.0.
2. **Voice is orphaned**: all three sites carry `voice-seed-data.mjs`, but it is
   in no `SEED_MODULES`, `voice` is not in `DATA_SITE_SUBDIRS`, `create-site`
   doesn't emit it, and `sites/fernwell/data/site/voice/` doesn't exist. → T16.1.
3. **Templates half-closed**: platform has no `templates-seed-data.mjs` and no
   starter templates (only bespoke `tpl_object_reference`); fernwell has the
   seed but zero committed template exports. → T16.1 + T16.9.
4. **netlify.toml capability drift** — root (Dr-Lurie) alone has
   `pretty_urls=false`, the `/_astro/*` immutable-cache header, the
   CSP-Report-Only header, and the image-validation build step. Platform and
   fernwell silently lack all four. These are core posture, not branding. → T16.2.
5. **Binding capability flags drift** — `warmAdminKeepalive` (admin cold-start
   fix, ~1.3s TTFB), `adminLabel`, committer identity: drlurie only. → T16.3.
6. **Core Header links routes two sites don't have** — `/rss.xml` and
   `/search.json` are site-owned files that exist only under
   `sites/drlurie/app/pages/`; core's Header emits the link and fetch on every
   site, so platform/fernwell get a dead RSS link and a search overlay that
   404s. → T16.4.
7. **Test/lint defects that let all of this drift silently**: the
   `core-no-site-literals` comment-stripper regex treats `/*` in redirect globs
   as a comment opener and swallows 40 % of `create-site.mjs` (the `@drlurie/core`
   stamp lives in the blind spot); the CSP drift gate reads a
   `sites/drlurie/data/site/tracking.json` that does not exist and only checks
   the root netlify.toml, so the one site WITH a committed tracking config
   (platform) is the one site never checked. → T16.6.
8. **Seed↔export inversions**: drlurie seeds `tracking_config` with no
   committed export; platform commits `tracking.json` with no seed. → T16.9.
9. **Naming legacy**: core is still `@drlurie/core`, and `create-site` stamps
   that name into every new client's package.json. No code imports the
   specifier (verified — dependency links and prose only). → T16.7.
10. **Genesis has no store-side verification and no entry point**: the drive's
    product is store objects, but everything checkable-from-the-repo
    (`audit-site-admin-parity.mjs`, deliberately repo-only) can't see them —
    exactly how fernwell shipped with a working `/admin` and no live link to
    it. Neither `create-site` nor `site-genesis-drive` appears in package.json
    or CI. → T16.8, T16.10.

### 1.3 What is fine and must not be "fixed"

- The 36 function shims are byte-identical modulo path depth and site name.
- Policy bundles (approval/creation/media) are identical in values.
- The 13 canonical infra redirects hold on all three sites.
- Dr-Lurie deploying from the repo root (no `sites/drlurie/netlify/`) is the
  known asymmetry, encoded in `admin-parity.mjs`. W16 does NOT relocate
  drlurie; it only stops root-only files from doubling as unshared core posture.
- Content redirects, branding, taxonomy contents, page/article exports are
  client data — divergence there is the product working as designed.

---

## 2. The genesis line (LAW)

A tenant's birth has four stages. Genesis is stages 0–1 and NOTHING else.

**Stage 0 — Scaffold (repo files).** Owner: `create-site --name <client>`.
Produces the full per-site tree: config bundle, function shims, netlify.toml
carrying EVERY core posture setting (T16.2), build entry, empty export tree,
bootstrap exports, and skeleton seed files for stage-2 types. Proven by:
`audit-site-admin-parity.mjs` + the create-site dry-run fixture. Repo-only.

**Stage 1 — Genesis (store birth).** Owner: `site-genesis-drive.mjs`.
Creates the starter pack through the site's own `/mcp` in the order law
(navigation → site singleton → taxonomy → theme → section-template recipes →
starter templates → bootstrap pages), publishes, releases once. After stage 1
every governed object TYPE is exercisable via the site's contract, and the
site renders entirely from store-backed objects. Proven by: the drive's
`--verify` mode (T16.8) reading the store back against the seed pack.

**Stage 2 — Onboarding (client identity).** Owner: humans/agents working with
the client. Editorial voice, tracking config, real branding beyond the default
theme, products. `create-site` emits skeleton seed FILES for these (so the
shape is fleet-uniform) but genesis never invents their content — this is
Wolf's 2026-08-05 ruling ("every genesis'd site should carry the full set of
governed object TYPES … but deliberately NOT actual content_item /
tracking_config / editorial_voice / product instances").

**Stage 3 — Content.** Articles, pages, sections. Never genesis's business.

The single source of truth for what belongs to which stage is the **genesis
manifest** (T16.0): one committed module that `buildPlan()`, `SEED_MODULES`,
`DATA_SITE_SUBDIRS`, and the parity audits all consume, with a drift test that
fails the moment any consumer disagrees with it. Adding anything to a stage =
editing the manifest = every consumer updates or the build goes red.

---

## 3. The parity law (LAW)

**P1 — Core change = fleet change.** Any change under `packages/core`
(including the create-site templates) that alters what a site's repo tree,
netlify.toml, env set, or seed pack must contain is INCOMPLETE until applied
to every existing `sites/<client>` in the same change. "Works on the site I
tested" is the defect this program exists to prevent. Enforced by: the
manifest drift test (T16.0) + `admin-parity.mjs` checks (extended by
T16.2/T16.3) running in fleet CI.

**P2 — Env law.** Any new env var read by core must, in the same change: be
added to the T11.7 env table and `ENV_CHECKLIST`; be provisioned to every
existing site (or the feature must degrade with an explicit, catalogued
`error_code`); and be covered by the capability probe (T16.5). An env var
that exists on one tenant only is a parity bug by definition unless the T11.7
table marks it per-site-optional with a recorded ruling.

**P3 — Capability truth is live, not repo.** Repo parity proves files; only a
live probe proves a tenant can actually use a tool. `FLEET-STATUS.md` carries
a per-tenant capability matrix (T16.5) refreshed after any env or
provisioning change and by the credentialed drives. A tool that lists but
503s on one tenant is a P1 violation, not "configuration".

**P4 — Tool surface uniformity.** No site's `tools/list` may differ from
another's except through the documented `OPTIONAL_HANDLER_TOOLS` mechanism
with a recorded ruling naming the tool and the reason. Today's whole
permitted set: `verify_article_images` (drlurie-only, image pipeline).

**P5 — Retrofit is genesis's twin.** Whenever `create-site`'s output changes,
the same task retrofits existing tenants (P1) — `migrate-site.mjs
--admin-parity --write` is the vehicle; a new client and a day-one client must
be indistinguishable at stages 0–1.

---

## 4. Execution program (W16)

Ordered for dependency, sized for cheaper models; every task is one commit,
minimal diff, no PR unless its brief says so. T16.0 first — it is the
manifest the rest consume. T16.9 is the only credentialed/interactive task.

| Task | What | Mode / model |
| --- | --- | --- |
| T16.0 | Genesis manifest — one staged source of truth + drift test | auto / Opus |
| T16.1 | Seed-pack completion: voice + templates join the manifest; create-site emits both; platform/fernwell backfilled (repo half) | auto / Sonnet |
| T16.2 | netlify.toml capability parity: pretty_urls, `/_astro/*` cache, CSP-RO header, build-step unification; create-site template + both site tomls + parity check | auto / Sonnet |
| T16.3 | Binding capability flags: `warmAdminKeepalive`, adminLabel, committer identity fleet-wide + export-name unification | auto / Sonnet |
| T16.4 | `/rss.xml` + `/search.json` become core shell routes (site-overridable); no dead links on any tenant | auto / Opus |
| T16.5 | `capability_status` diag tool + `fleet-capability-probe.mjs` + FLEET-STATUS capability matrix | auto / Sonnet |
| T16.6 | Fix the lint blind spot + the vacuous CSP drift gate | auto / Sonnet |
| T16.7 | `@drlurie/core` → `@fleet/core` rename fleet-wide | auto / Sonnet |
| T16.8 | `site-genesis-drive.mjs --verify` — store-side genesis acceptance | auto / Sonnet |
| T16.9 | Credentialed fleet drive: backfill store objects (fernwell voice/templates, platform templates), reconcile tracking inversion, run probe + verify on all three, update FLEET-STATUS | notify / Sonnet |
| T16.10 | Genesis entry points (`npm run` scripts) + the single new-client acceptance checklist doc | auto / Sonnet |

Done means: manifest test green, `admin-parity` ≥ 16/16 on all tenants,
capability matrix all-green (or explicitly ruled per-site), `--verify` clean
on all three stores, and the acceptance doc is the one place a new operator
reads to birth client #4.
