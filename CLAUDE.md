# Dr-Lurie-Blog — CLAUDE.md

> **Repo note:** the repository is now `vreich-ui/platform` (renamed W14). The
> title above is historical. Never write the literal `owner/name` repo string
> into committed content — it is `GITHUB_REPOSITORY`'s value and the secrets
> scanner fails the build on it (see Known gotchas).

## W14 PLATFORM REALITY — read this framing first (2026-07-27, V1)

The project is a **white-label agentic publishing fleet**, not one blog. The
layout that governs every path below:

- **`packages/core/` is fleet law** — the engine (object store, verbs,
  validation, publish/release, MCP server) **and** the Astro app shell live
  here. One implementation, upgraded fleet-wide from one place. The hard-
  constraint and guardrail files that older sections below place under
  `netlify/lib/…` or `src/…` now live under `packages/core/server/lib/…`,
  `packages/core/server/functions/…`, and `packages/core/app/…` (the W11/W14
  relocation). Where a path below says `src/schema/…`, `netlify/lib/…`, or
  `src/components/admin-ui/…`, read it as its `packages/core/…` counterpart —
  those sections are pre-relocation and describe behavior, not current paths.
- **`sites/<client>/` is per-client data + bindings + a thin build entry** —
  config bundle, seeds, committed exports, function shims. Joined to core at the
  `SiteBinding` seam. Four today: `sites/drlurie` (the worked example),
  `sites/platform` (the core/agency site — documents the system through its own
  `/mcp`), `sites/fernwell` (the synthetic repeatability proof, T14.9),
  `sites/zilberman` (fleet tenant #4, the W12 capture landing zone — minted
  2026-08-14, T12.12, serving at `zilbermanfilmfoundation.netlify.app`).
- **Each site is its own Netlify project** whose base directory selects that
  site's `netlify.toml` + entry + shims, and **its own `/mcp` endpoint** over
  the same core (per-client endpoints, one engine), auth-gated by its own
  `MCP_HTTP_AUTH_TOKEN` (fail-closed in a production runtime since W14 F1).
- **Per-site machine truth is that site's `object_inventory` / `object_contract`**,
  never a committed doc. `object-inventory.md` / `conversion-map.md` describe
  Dr-Lurie's worked example; a new client's reality is its own store.
- The monorepo stands for V1; per-client-repo/domain separation is designed (not
  built) in `docs/cms-architecture/13-separation-plan.md`.

**Wolf's governing W14 rulings** (full list + supersessions:
`docs/cms-architecture/decisions/2026-07-26-platform-site-ruling.md`). R8, the
finish-line directive, verbatim:

> **R8 — V1 FINISH-LINE DIRECTIVE (governing):** no more blockers or questions
> parked for later. Agents make reasonable decisions, record them, and keep
> moving; the only permissible halts are genuine account-authority gates
> (Netlify token, GitHub admin clicks). The project crosses the line as a solid
> V1.

## W16 — GENESIS SCOPE + FLEET PARITY LAW (Wolf, 2026-08-10, GOVERNING)

Genesis and cross-tenant parity are governed by
[`docs/cms-architecture/16-genesis-parity-plan.md`](docs/cms-architecture/16-genesis-parity-plan.md):
the four-stage line (scaffold → genesis → onboarding → content; genesis = the
first two only, per the 2026-08-05 types-not-instances ruling) and laws P1–P5.
The two you will hit in ordinary work: **P1 — any change under
`packages/core` (incl. the create-site templates) that alters what a site's
repo tree, netlify.toml, env set, or seed pack must contain is INCOMPLETE
until applied to every existing `sites/<client>` in the same change.**
**P2 — any new env var read by core lands, in the same change, in the T11.7
env table + `ENV_CHECKLIST` + every existing site's env (or degrades with an
explicit catalogued `error_code`) and is covered by the capability probe.**
Tool surfaces are uniform across tenants except via the documented
`OPTIONAL_HANDLER_TOOLS` mechanism with a recorded ruling (today:
`verify_article_images` only). Execution: the W16 rows in queue.tsv.

## W17 — CANVAS UX SCOPE: THE FULL MARGINALIA CONCEPT (Wolf, 2026-08-10, GOVERNING)

Wolf answered `docs/cms-architecture/17-canvas-ux-plan.md` §2 with **(a) — the
full concept**: `docs/design/marginalia-concept-b-final.pdf` is the acceptance
standard, in full, and T17.0–T17.13 all run. Recorded in
[`docs/cms-architecture/decisions/2026-08-10-canvas-ux-scope-ruling.md`](docs/cms-architecture/decisions/2026-08-10-canvas-ux-scope-ruling.md).
The two things you will hit in ordinary work: **the PDF, not any prose list, is
what a W17 task is measured against** — where it is silent,
[`docs/design/marginalia-interaction-model.md`](docs/design/marginalia-interaction-model.md)
is the specification and its §11 indexes every place that spec went past the
PDF as an explicit proposal; and **this is a rewrite of the canvas annotation
surface, not eight bolt-on features** — T17.3 retires the Comments accordion in
favour of a margin rail, T17.7 and T17.8 are new work no earlier plan accounts
for. Sequencing is binding (plan §5): Batch B (T17.3 → T17.8 → T17.6) runs
sequentially in ONE session with ONE agent, T17.4 before Batch C, T17.13 last.
Execution: the W17 rows in queue.tsv.

## W18 — MEMBERSHIP: INVITE → ACCEPT → ROLES → OFFBOARDING, HUMAN-ONLY WRITES (2026-08-17, GOVERNING)

Membership is governed by
[`docs/cms-architecture/18-membership-plan.md`](docs/cms-architecture/18-membership-plan.md)
(§2 store v2 — Person / Membership / Invitation / Audit / policy in the per-site
`users` store, five tiers `owner|admin|publisher|editor|viewer`; §6 permission
matrix; §7 the AI/MCP surface; §8 what shipped, T18.0a–T18.7). The four §9
defaults are rulings-by-default under R8, recorded in
`docs/cms-architecture/decisions/2026-08-17-membership-defaults.md`. The two
things you will hit in ordinary work: **membership WRITES require a human
principal** — every verb goes through `handleMembershipVerb`, and an agent
principal (bearer token, chat run without a human) gets
`403 membership_requires_human` before anything else; over MCP the human is
the OAuth-bound Owner/Admin. **Any e-mail from Netlify Identity lands on
`/admin/accept`** — invite, confirmation, recovery, email-change tokens are
consumed ONLY there (`HeaderAuthButton.astro` routes every token hash to it);
never handle an Identity token on another page or in a function. Fleet law
holds: a new tenant gets `config/membership-policy.ts` + the sweep from the
scaffold; the probe's `membership` family says whether it did.

## W19 — EDITORIAL REQUESTS: A JOB IS A RECORD, NOT A CHAT (2026-08-22, GOVERNING)

Editorial work in progress is governed by
[`docs/cms-architecture/19-editorial-requests-plan.md`](docs/cms-architecture/19-editorial-requests-plan.md)
(findings F1–F10, the `editorial-request.v1` schema §3, surfaces §4, the
sweeper and status derivation §5, the three notification channels §6, the agent
contract §7, permissions §8, decisions §9, run order §10). Wolf's four scoping
answers are governing; D1–D7 are rulings-by-default under R8. The three things
you will hit in ordinary work: **a request is the editorial job, not the
conversation** — `req_<flow>_<topic>_<yyyymmdd>_<nn>` is the correlation key
(it is also the eventual `content_item` id and the artifact request id), it
lives in the per-site `editorial-requests` store, and chats attach to it rather
than owning it. **Only the sweeper writes a running request's status** —
`editorial-request-sweep` derives it from CMS-Agent's run state through one
pure function (plan §5.1); no surface, tool or chat path may set `running`,
`stalled`, `failed` or `done` by hand. **A run that ends must say so** — the
`run_finished → null` render (`admin/chat.tsx`) was F1 and is not to be
reintroduced; a `caps` ending in particular must tell the editor the job is
still alive. Fleet law holds: the sweep is a scheduled function, so its
schedule block belongs in every `sites/<client>/netlify.toml`, and the W19 mail
env carries the full P2 obligation. Execution: the W19 rows in queue.tsv.

## Definition of "converted" — NO HALF MEASURES (Wolf, 2026-07-10, GOVERNING)

The entire project goal is: **agents can change objects on every page — add
permitted objects, edit them — through the MCP.** So "convert an object" means
exactly this and nothing less. An object counts as converted ONLY when **all five**
hold (full definition + recipe: [`docs/cms-architecture/conversion-playbook.md`](docs/cms-architecture/conversion-playbook.md)):

1. **Renders** in Astro from the object (the four build gates).
2. **Store-backed** — a real record in the **production object store**
   (`object_inventory` returns it), not merely a committed git export. _A rendered
   export with no store record is a **rendered stub, not a converted object.**_
3. **Round-trips** — an agent can perform **every permitted action** end-to-end via
   MCP (checkout → each patch op → publish → release → re-render), proven not assumed.
4. **Contract-complete** — every permitted action is in `object_contract` AND backed
   by an actual MCP server tool. **A permitted action with no tool/contract entry is
   itself part of the conversion** — build it; the object is not done without it.
5. **Recorded** — `object-inventory.md` row + `state-of-play.md` entry, same change.
   **No record = not converted.**

**Hard rules that follow:**

- **No half measures, no unfinished work.** A "convert X" task is done only when X
  passes all five. Rendering-only work is labelled "rendered, not converted."
- **After EVERY session, update the documentation.** An object does not count as
  converted without a written record of it (inventory row + session-log entry).
- Reality as of 2026-07-15: **forty-seven objects are converted** (the 37 below
  - the 3 W5 pages, credentialed run 2026-07-13 + the FIRST ARTICLE OBJECT,
    W7.9 run 2026-07-13 + the 5 SECTION TEMPLATES and the DEFAULT THEME, W8.4
    run 2026-07-14 with the application-verb production proofs completed
    2026-07-15; see the W8 paragraph below) — the 3 nav
    objects, all 12 page objects (home + about + the 8 W1 interior/system pages +
    page*contact + page_thank_you), the 12 shared sections under home/about, the
    3 templates (tpl_interior/landing/legal), the `tax_drlurie` taxonomy
    registry (W3 — curated agent-editable vocabulary, 5 categories + 26 tags;
    `resolveTaxonomyTerm` is live), and the `site_drlurie` SITE SINGLETON (W4,
    credentialed run 2026-07-11: the layout renders brandTokens/logo/chrome/
    metadataDefaults/defaultNavigation from its export via `set_site_fields`;
    urls/blog carried, config.yaml stays authoritative for routing — Wolf B2).
    All proven by credentialed `--production --release` runs on 2026-07-11.
    **No page renders from an unbacked export anymore — the rendered-stub
    backlog is empty.** The section-type palette is fully generic (no bespoke
    per-page types: `about`/`contact` decomposed, `thank_you` →
    `form_confirmation`). W3 step 2 SHIPPED (2026-07-11): the bounded
    publish-article taxonomy-enforcement hook (the sanctioned additive exception
    — registry-gated, skips when no registry) + the one-time frontmatter
    normalization of all 93 posts + registry display labels in the blog
    renderer. The 28-invisible-posts caveat is CLOSED (2026-07-11: 10 junk posts
    deleted, 18 real ones stamped with `published_time`; 167 pages, topics hub
    live). **Agent-CREATED pages are live end-to-end (2026-07-11, B1 closed)**:
    the object-page catch-all (`src/pages/[...objectPage].astro` +
    `src/utils/object-page-routes.ts`) serves any published Page object whose
    route no file owns — create → publish → release → live, zero code.
    **Write-time guardrails (2026-07-11, traps 5+14 closed)**: `validateObject`
    now blocks, at patch/create/publish, content that would break the deploy
    (protected env values in any encoding; repo-file hotlink URLs) or the build
    (per-component rich-text vocabulary, checked with the real splitters) — an
    agent can no longer publish something that dead-ends the pipeline.
    **W6 CONVERTED (2026-07-12, credentialed run same day)**: the
    `listing`/`content_detail` PageTypes are defined law (all five implemented;
    content_detail publishes with zero sections via `minVisibleSections: 0`),
    and six page objects (page_library, page_topics_index, page_topic_detail,
    page_category, page_tag, page_article) make the listing surfaces'
    headings/copy/SEO agent-editable — first lede = the header block, extra
    sections render after the list/article, per-term objects carry `%term%`
    pattern copy — while the query machinery stays the audited build-time
    derivation. Byte-identical cutover; all six store-backed, round-tripped,
    published, released (store === seed === export). Hidden sections are now
    filtered at the resolver on every render path (never-render-private).
    W5 was RE-GROUNDED in the shop module
    (`docs/cms-architecture/06-shop-module-plan.md` — Stripe-only v1 plan;
    /pricing renders from product objects, /services awaits a copy-or-delete
    call; the shop build runs in its own session).
    **W7 CONVERTED (2026-07-13: W7.3 + W7.8 built; W7.9 credentialed run the
    same day via the session MCP connection — the type's five criteria all
    hold)**: `content_item` joined the governed set — the
    annotated-node article model (every block carries `private.strategy`
    hook/agitation/…/resolution + `intent`, the original architecture's
    semantic layer, imported verbatim; envelope claims/sources/compliance/
    scores/lineage; `public.body` = plain text or `rich_text.v1`), six node
    ops with exact inverses, `create_variant` (+ MCP tool, `dry_run`),
    validation (one slug space with committed posts; the reader-projection
    leak scan; renderable rich-text grammar), materializer →
    `src/data/site/articles/`, and the render path: published article objects
    join `fetchPosts()` as first-class posts with per-node canvas chips
    (pencil + node-scoped Ask-AI) on the standard EditSession →
    `update_node` → publish/release path. **Wolf's 2026-07-13 ruling
    (SUPERSEDED same day): the 83 committed .md posts were "mostly junk … needs
    rewriting" — WIPED, not kept.** All 83 `src/data/post/*.md` deleted; the
    `post` collection is now permanently empty (a benign build-log warning; all
    articles are content_item OBJECTS). Replaced by a TEN-ARTICLE corpus (two
    per registry category — skin-health/skincare/skin-after-40/ingredients/
    reflections; `scripts/lib/articles-corpus-seed-data.mjs`) created via the
    credentialed run. The first-article W7.9 seed
    (`scripts/lib/articles-seed-data.mjs`) remains as the demo at
    `/object-model-demo`. Unpublish remains
    unsupported (OQ-2) — a released article stays live until edited. The W7.9
    run (2026-07-13): create → all six node ops drilled byte-identical →
    validate clean → `create_variant` dry-run → publish (export commit
    `60cd213`) → release (deploy ready) — the demo article is LIVE at
    `/object-model-demo` with per-node canvas chips; found+fixed en route: the
    seed's taxonomy terms didn't exist in the production registry (now
    `reflections`/`reflections`). **Wolf's 2026-07-13 ruling (supersedes
    OQ-W7-1): reverse support is NOT required** — the legacy article tools
    need no alias layer; MCP tools and functions may be updated, changed, or
    retired as the remaining W7 phases land, provided the functionality
    (drafting workflow, publish safety stack, admin editor) survives on the
    object substrate. Still open: W7.2 (sections onto rich text), W7.5
    (re-point internal surfaces; reduced — no aliases), W7.7 (admin editor +
    annotation panel + document-body canvas editing), OQ-W7-3 (strategy
    registry go/no-go).
    **W8 CONVERTED (2026-07-14 run + 2026-07-15 application-verb production
    proofs, both via the session MCP connection)**: the RECIPE FAMILY —
    `section_template` (stpl_hero_landing /
    stpl_audience_grid / stpl_related_articles / stpl_newsletter_cta /
    stpl_cta_banner) and `theme` (thm_drlurie_default, the
    canonical palette — live again since Wolf's ordered restore, 2026-07-15,
    see the drift incident below) — completing the
    TEN governed types (`objectTypes` in `src/schema/object-record-v1.ts` is
    the authoritative list; older session logs' "ninth/tenth/eleventh
    governed type" labels over-count by one) — plus
    `object_instantiate_section_template` (stamp a section from a recipe,
    standalone or page mode), `site_apply_theme` (exact-replace token apply
    with stale-key nulls), template `blueprintRef` composition, CSS-token
    injection safety on theme AND site, and W8.3b's recipe metadata
    (description/whenToUse/scope REQUIRED TO PUBLISH), creation-policy seam
    (committed config; default open; humans always), and reuse-first
    surfacing (inventory recipe summaries + REUSE-FIRST contract workflow +
    editor.useWhen ×19). Step 0 backfilled the trio onto the 3 live tpl*\*
    (published rev 20; exports content-identical to the W8.3b
    pre-materialization). All 9 objects: created/reconciled → every
    permitted patch op drilled with exact inverses → published → released
    (deploy ready 2026-07-14T16:23Z); store === seed === export verified.
    APPLICATION-VERB PROOFS (2026-07-15, after a connector reset exposed the
    W8 tools): instantiate_section dry_run BOTH modes × EACH of the 5 stpl
    records (10/10 eligible, zero blockers) + apply_theme dry_run + ONE REAL
    default apply end-to-end (atomic op, applied_theme in history, publish,
    release). **The real apply exposed LIVE-PALETTE DRIFT:** the site's
    brandTokens had been rebranded in production on 2026-07-13 (teal/
    terracotta, Source Serif heading) AFTER the seeds were written, so the
    "no-op" apply actually put the old palette live for ~6 minutes (09:30:57–09:37:13Z); restored
    byte-exact (export commit `eba0c42`) and re-released. RESOLVED SAME DAY
    (Wolf's ruling): the 2026-07-13 palette change was an agent's casual
    color edit, NOT a sanctioned rebrand — Wolf ordered the ORIGINAL palette
    restored (real `site_apply_theme` of thm_drlurie_default, publish
    `2f88ef6`, released 10:35:46Z). thm_drlurie_default IS the live palette
    again and the seed's brandTokens match production — the PALETTE
    follow-ups are closed, and `site-seed-data.mjs` was RESYNCED to the live
    "Skincare" branding 2026-07-15 (`scripts/sync-site-seed.mjs`; a site-seed
    drift-guard test keeps it in lockstep) — the site family is safe to
    reconcile again. THEME-ONLY PALETTE GOVERNANCE SHIPPED (Wolf 2026-07-15
    directive): `brandTokens` is no longer patchable via `set_site_fields`
    (grammar refusal, 400 `invalid_op`); the palette changes ONLY through
    `site_apply_theme`, which emits the privileged tool-authored
    `set_site_brand_tokens` op (the exact `set_product_fields`⇸`set_product_price`
    funnel, applied to the site). The reconcile driver's site branch now
    excludes brandTokens. Still available as one-line config flips: maker-agent
    restriction on theme creation (`src/config/creation-policy.ts`) and the
    optional human-approval pin (`src/config/approval-policy.ts`); agent-
    approves-agent review is not built (M-6 approvals are human-only). tpl_fieldtest (the
    2026-07-08 fieldtest leftover) still lacks the metadata trio — patching
    it 422s until backfilled or retired.

## Core structure — read [`docs/cms-architecture/core-structure.md`](docs/cms-architecture/core-structure.md) FIRST

The system standardizes on **Contentful's content model**: typed entry objects
(pages/sections — already built) + **Contentful Rich Text** JSON for all rich
content fields (replaces HTML strings). That doc has the canonical example for each
level and the ordered task list to finish the CMS. It is the entry point; everything
below elaborates it.

## Design north star — flexible objects, not a site replica (READ FIRST)

We are building a **flexible content backbone, not reproducing today's pages
one-for-one.** Prefer **reusable, agent-configurable components** (a `content_grid`
an agent can point at any content and set to N cells) over **bespoke per-page types**
(a section that renders exactly one page). Byte-identical cutover was migration
_safety_, not the goal — "an agent can now reconfigure this to play a different role"
is. **Litmus test:** if an agent can't repoint or reuse a thing without a code
change, it's a replica, not backbone — generalize it. Full rule + consequences:
[`docs/cms-architecture/design-principles.md`](docs/cms-architecture/design-principles.md).
This **governs** where the phased-plan's "faithful reproduction" / "new component
type per page" framing conflicts.

## CMS architecture project — mandatory pre-task reading

If the task you've been given relates to the agent-actionable CMS project (object store, Pages, Sections, Navigation, Taxonomy, Site config, Templates, or anything under `docs/cms-architecture/`), **read these files in full before writing any code, in this order**:

1. Your task's standalone brief: `docs/cms-architecture/cms-pipeline/T<phase>.<n>-*.md` (e.g. `T0.6-patch-grammar-inverses.md`). Its header carries the task's `depends_on`, `mode`, and recommended `model`/`effort`. **Check `depends_on` before starting anything — if a dependency isn't actually built and merged yet, stop and say so. Don't proceed on the assumption it exists.** (Phase 0 briefs are committed so far; later-phase briefs land in the same directory as they're written.)
2. `docs/cms-architecture/cms-pipeline/queue.tsv` — task ordering and per-task `mode`/model/effort; `docs/cms-architecture/cms-pipeline/README.md` explains the runner around it.
3. For the full per-task spec: `docs/cms-architecture/05-task-breakdown-and-open-questions.md`. `docs/cms-architecture/02-architecture-and-schema.md` and `docs/cms-architecture/03-mapping-and-agent-contract.md` have the full reasoning behind any schema or permission decision you're implementing. These numbered session docs (01–05) are the authoritative sources: a consolidated master reference (`cms-architecture-consolidated.md`) is named by some briefs but has not been committed to the repo — where anything conflicts, the source docs are ground truth.
4. `docs/cms-architecture/conversion-map.md` — the FULL tree of actual + potential objects (attributes, dependencies, dependents, Wolf's conversion priority). **Pick conversion targets and their boundaries from here.** Then `docs/cms-architecture/object-inventory.md` — the human-facing catalog of what content objects exist right now (each marked LIVE / SHELL / TODO), every object type's use + boundaries, and the MVP todo list. Read it to know what is already an editable object vs. still hardcoded. **It is hand-maintained and drifts easily: update the matching row in the SAME change whenever you cut over a surface or publish/retire an object.** For always-current machine truth, prefer the `object_contract` / `object_inventory` MCP tools over any doc.
5. **Converting a surface to an object? `docs/cms-architecture/conversion-playbook.md` is mandatory** — the exact lifecycle recipe, the call/response field names (do not guess them), and the trap table (deep-merge patch semantics, reference seeding, rich-text vocabularies, the expected sandbox publish block). Every trap in it was hit for real once; the playbook exists so it never costs a second fix-up pass.

Do not skip this because the task instructions in front of you look self-contained. They're deliberately terse and assume this context is already loaded.

## Hard constraints — every session, every task

- ~~**`admin-workflow-lock.ts`, `publish-article.ts`, and the existing article MCP tools are off-limits**~~ — **VOID since 2026-07-29.** The legacy article pipeline was RETIRED and DELETED (ruling OQ-W11-6): `save-json-blob.ts`, `publish-article.ts`, `admin-workflow-lock.ts`, the `mcp/save-json-blob-mcp/` module, the 11 `save_json_blob_*` tools and the 10 per-stage workflow tools (`reader_insight_*`/`research_*`/`angle_*`/`draft_*`/`final_article_*`) are gone, with no successor alias. Do not resurrect, re-link, or pattern-match against them; a doc or comment that still names one is describing history. Articles are `content_item` OBJECTS on the governed object verbs. **What was PRESERVED:** the committed posts under `src/data/post/` and their rendering (this retired the WRITE pipeline, not published content), the `content_item` slug-uniqueness check against those committed posts, and `verify_article_images` — including its legacy committed-asset `filename-stem` matching branch, since published pages still serve `/_astro/`-hashed committed assets.
- **Never open a PR unless the task brief explicitly says to.** Commit to the working branch and stop; ask before pushing further or opening a PR if it isn't specified.
- **Check the task's `mode` before starting any task** (the `mode` column in `docs/cms-architecture/cms-pipeline/queue.tsv`, repeated in each brief's header). `checkpoint` tasks do not start until Wolf has answered the open question in the brief — don't infer an answer and proceed. `human_gate` tasks can be prepared in full, but the task isn't done until the specified human action happens — don't attempt to complete that step yourself. (`notify` marks tasks run interactively and watched rather than by the headless runner.)
- **Every surface migration task (Phase 2 onward) follows the seed → publish → cutover → verify → cleanup template** and must produce an empty diff from `scripts/build-diff.mjs` (once T2.0 exists) before a cutover is considered done. Don't invent a different verification approach.
- **Delivery to Wolf is a double-clickable script, not instructions.** Push
  access does not exist from the sandbox, so work reaches him as a zip. That zip
  contains a `git format-patch` series under `patches/` and ONE executable
  `land.command` at its root — he is on a Mac, he saves the zip to Downloads,
  and he expects to unzip and double-click. The script finds the repo itself,
  refuses on a dirty tree, applies the series, pushes, and prints one line. No
  README, no manifest, no path arguments to type: a breakdown of the zip's
  contents is noise, and anything he has to read before clicking is a defect.
  Substance — what landed, what needs his hands — goes in the chat message, not
  in a file. Prefer a patch series over a `git bundle`: bundles reuse the whole
  repo pack and come out ~150x larger.
- **One task, one commit, minimal diff.** Don't bundle cleanup, refactoring, or "while I'm in here" changes into a task's commit — flag them separately instead.

## Known gotchas

- File-deletion tasks require verifying every importer first — never delete a file just because a task says to; confirm nothing else references it.
- The taxonomy source of truth is committed frontmatter, not the blob draft aggregation — using the wrong source reintroduces the exact drift the project exists to fix (see `docs/cms-architecture/02-architecture-and-schema.md` §5.5).
- `route`-kind navigation targets are a deliberate transitional type, not a bug — don't "fix" them to `page`-kind before the corresponding Page object actually exists.
- **Never write a literal `https://github.com/vreich-ui/Dr-Lurie-Blog/...` URL (or the bare `vreich-ui/Dr-Lurie-Blog` string) into committed content.** Netlify's build-time secrets scanner fails the ENTIRE build on any appearance of a configured build env var's literal value anywhere in scanned files — and `GITHUB_REPOSITORY` (the CMS's own git-write mechanism) is set to exactly that string, so an ordinary GitHub PR/issue link in a doc is enough to hard-fail every future build once it's merged (hit for real: T9.24/T9.25 PR #470, from a pre-existing link in `state-of-play.md`). `GITHUB_REPOSITORY` is now in `netlify.toml`'s `SECRETS_SCAN_OMIT_KEYS`, but don't rely on that alone — reference PRs/issues by bare number (`PR #469`, `#469`), never a full URL, in anything that gets committed. The same caution applies to any other configured secret env var whose value is a plain, typeable string rather than a random token.

## Admin workspace — read [`docs/cms-architecture/10-admin-workspace-plan.md`](docs/cms-architecture/10-admin-workspace-plan.md) before touching `/admin/*`

The W9 program (SHIPPED 2026-07-23) rebuilt the admin UI from scratch on a
React component kit (`src/components/admin-ui/`: `AdminShell`/
`AdminLayout`/`ObjectWorkspace`/`ContentLibrary`/`MaintenancePage`/etc.) —
the plan doc is the map of what exists and why. Current route surface
(non-exhaustive): `/admin` (home), `/admin/content` and `/admin/content/<id>`
(library + the object workspace — checkout/patch/publish for any governed
object type), `/admin/agents` (the in-house chat/agent hub, ChatKit's
replacement), `/admin/studio` (templates/themes), `/admin/users`
(invites/roles), `/admin/maintenance` (Owner-only blob store browser + wipe
tools, ex-`/admin/blobs`), `/admin/kit` (component gallery).

**T9.24 (2026-07-23) deleted the legacy vanilla-JS admin surface for
good** — do not resurrect, re-link, or pattern-match against `publish.astro`,
`drafts.astro`, `library.astro`, `agent-admin.astro`,
`review/[draftId].astro`, `objects/[objectId].astro`, `AdminNav.astro`,
`admin-ask-ai-node.ts`, `get-article-for-edit.ts`, `admin-update-node.ts`,
`admin-patch-workflow.ts`, `list-draft-articles.ts`,
`admin-save-json-draft.ts`, `admin-get-json-draft.ts`,
`admin-list-json-drafts.ts`, `toggle-article-publish.ts`, or
`create-chatkit-session.ts` — all gone, none have a successor alias. A doc
or comment that still mentions one is describing history, not a live
surface.

**Two-tier rights model (T9.4):** `Owner` vs `Admin`, resolved server-side
via `resolveRolesFromEvent` + `isOwner(roles)` (`netlify/lib/roles.ts` /
`netlify/lib/request-roles.js`); bootstrap Owners come from the
`ADMIN_EMAILS` env fallback. Owner-gated client surfaces follow the
`AdminUsers.tsx`/`MaintenancePage.tsx` pattern (`fetchMe(getToken)` → check
`roles.includes('owner')` → render an `EmptyState` otherwise) — the server
403s a non-owner regardless; the client gate is UX, not the security
boundary.

**Guardrails now live on the object substrate, not bespoke admin code**:
`validateObject` (`netlify/lib/object-validate.ts`) blocks unsafe writes at
patch/create/publish time (protected-env leakage, hotlink URLs,
per-component rich-text vocabulary, the reader-projection leak scan). The
publish-safety stack (`publish-article.ts`, `admin-workflow-lock.ts`) is
untouched and off-limits as always — the T9.24-deleted functions were an
old parallel path around that stack, never the stack itself.

## Project basics

- Astro static site, deployed via Netlify. Netlify Blobs is the source of truth for CMS-managed content; git-committed exports are derived.
- Test suite exists but wasn't run in CI until T0.10 — check whether that task has landed yet before assuming CI will catch a regression.
