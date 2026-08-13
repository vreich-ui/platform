# 11 — Platformization Plan (W10–W12): design vocabulary, multi-tenant core, site capture

> **Status (2026-08-13): W10/W11 delivered; W12 built and demonstrated, exit
> criterion NOT MET, T12.6 disposition still OPEN.** The first Zilberman
> capture run scored 52.94% mapped coverage against the 90% default with no
> draft-preview visual evidence, so the exit bar is not cleared on the
> measurement alone. **No Wolf disposition has been recorded** — an earlier
> version of this header claimed one; it was agent-authored and is withdrawn.
> The never-published drafts and 14-gap evidence are retained pending Wolf's
> review, backlog work, and a rerun.
> Formalizes parts 2 and 3 of the 2026-07-19 conversion-roadmap strategy
> session (branch `claude/conversion-roadmap-cms-strategy-hgplp8`): (part 2)
> agents create templates/themes/sections rich enough to reproduce other
> sites' designs without breaking the agentic CMS, up to "point an agent at a
> static site and produce a copy within reasonable limits"; (part 3) the
> repo becomes a canonical multi-client CMS where Dr-Lurie is one client and
> canonical code changes update every client.
> Task briefs: `cms-pipeline/T10.1-*.md` … `T12.6-*.md`; queue rows appended
> to `cms-pipeline/queue.tsv` (after the W9 rows — see §7 ordering rules).
> Open questions for Wolf: §6 (OQ-W10-1…3, OQ-W11-1…5, OQ-W12-1…3).
> Built to run under the cms-pipeline runner: every task is `auto` unless it
> is a security boundary (`notify`), needs Wolf's ruling (`checkpoint`), or
> needs a human/credentialed action (`human_gate`). Model/effort are assigned
> per row and deliberately reallocatable (§4).

## 0. Mandate and sequencing

**The ask (verbatim in intent, 2026-07-19):** _"I prefer to have agents being
able to create templates that are close to the design of other sites while
not breaking our agentic CMS system. Ideally I want to be able to point an
agent to any static website and have it produce a copy within my existing
infrastructure. There will be reasonable limits to support smooth ongoing
agentic content administration."_ And: _"turn this site into a proper CMS
where dr.lurie becomes just one of the clients … changes made to the
canonical code now or in the future must be able to update all clients
projects."_ Plus: _"formalize … to be able to run auto with flexible AI
model allocation."_

**Constitution unchanged.** Nothing here amends design-principles rules 1/5/6
or "Templates are recipes; PageTypes are law." The whole plan widens the
BOUNDED surfaces (tokens, palette, variants) and relocates code — it never
puts CSS, page kinds, or free-form layout into agent-writable data. Composite
sections stay SPEC-ONLY behind OQ-W8-1…4; W10 only assembles the evidence.

**Three waves, and why in this order:**

| Wave                      | What                                                                                                                                                          | Gate to start                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **W10** Design vocabulary | Bounded theme token axes + section-palette growth + per-type variants + the composite decision package                                                        | none (parallel-safe with the W9 tail; pure single-repo code with byte-identical defaults)                               |
| **W11** Platformization   | Monorepo split (`packages/core` + `sites/<client>`), de-hardcoding, provisioning, fleet CI + schema-migration harness, per-site governance, second-site proof | **W9 T9.24 done** (legacy deletion — extract the shrunken core, not code about to be deleted) + Wolf's OQ-W11 rulings   |
| **W12** Site capture      | Crawl → decompose → theme-extract → emit recipes/pages via MCP → fidelity loop → gap reports                                                                  | W10 (vocabulary worth mapping to) + W11 (a staging client to clone into); the T12.1 spike may be pulled forward anytime |

The dependency logic: W10 makes clones _look_ right (today's visual surface
is 10 color tokens + 3 fonts over a fixed design system — a theme can
re-skin Dr-Lurie, not produce a different design language). W11 gives clones
somewhere to _live_ (today every object lands in the one Dr-Lurie store).
W12 is then a pure agent workflow whose entire output is data — recipes and
objects through the existing governed verbs — which is what keeps every
cloned site fully administrable afterwards (the actual point).

## 1. W10 — Design vocabulary (bounded visual range)

### 1.1 Theme token axes (T10.1–T10.2)

`brandTokens` today (`src/schema/bodies/site-v1.ts:22-34`): an open
grammar-checked `colors` record (10 required keys +
optional `dark:` variants, `src/lib/registry/theme-tokens.ts`) and 3 font
stacks. Everything else — spacing rhythm, radii, shadows, type scale,
container width, button shape — is hardcoded in
`src/assets/styles/tailwind.css` / `tailwind.config.js`. W10 adds **bounded
enum axes**, additive-optional so every existing record parses and the
default render is **byte-identical**:

```jsonc
// brandTokens v2 sketch (additive; final shape is T10.1's to settle)
{
  "colors": {
    /* unchanged */
  },
  "fonts": {
    /* unchanged */
  },
  "layout": { "containerWidth": "narrow|default|wide", "sectionRhythm": "compact|default|airy" },
  "shape": { "radius": "sharp|soft|round|pill", "buttonShape": "rect|soft|pill", "shadow": "none|soft|elevated" },
  "type": { "scale": "compact|default|editorial", "headingWeight": "regular|medium|bold" },
}
```

Rule-6 mechanics, unchanged in kind: every axis value maps to a **pre-built
code-side class/var set** (the `theme-tokens.ts` registry pattern —
validation and the renderer share one source of truth); `theme.tokens`
carries the same axes; `site_apply_theme` exact-replace semantics extend to
them (a theme that omits an axis applies the default — stale-axis unsets
included); the CSS-value safety helper is not weakened (enums don't even
reach the string grammar). No schema field ever carries CSS.

### 1.2 Palette growth, evidence-driven (T10.3–T10.6)

Rule 1 says the palette grows on demand — the capture ambition IS the
demand. T10.3 surveys 2–3 Wolf-named reference sites and produces
`design-vocabulary-gaps.md`: which of their sections the current 19
component-bound types already express, which need a **new reusable type**,
which need only a **bounded variant field** on an existing type
(e.g. `hero.variant: 'center'|'split'|'background'`), and which token axes
are missing. Candidate new types (survey decides, Wolf ratifies at T10.4):
`media` (image/gallery block), `brand_row` (logo strip — already named in
conversion-map as "maybe"), `stats` (number band), `timeline`,
`comparison_table`, `video_embed`. Each mint is the proven registry recipe:
one union member + one registry module + one component + editor hints +
`useWhen`, tests, build-diff EMPTY.

### 1.3 Composite decision package (T10.7) and recipe refresh (T10.8–T10.9)

T10.7 assembles the OQ-W8-1…4 answers-in-evidence (from T10.3 + any W12
gap reports): the named real layouts the bounded palette cannot express.
It is a decision memo for Wolf, NOT a build — the composite build remains
its own future wave per 09 §8. T10.8 refreshes the starter recipe set
(new `stpl_*` seeds exercising the minted types and axes, metadata-complete)
and T10.9 is the credentialed run that converts them (all five criteria —
no half measures).

## 2. W11 — Platformization (Dr-Lurie becomes one client)

### 2.1 Tenancy model (recommended; confirm at OQ-W11-4)

**One Netlify site per client = the tenant boundary.** This is what the code
already does implicitly: blob stores are scoped to the Netlify site
(`netlify/lib/blob-store.ts`), object keys carry no site segment
(`objects/{type}/by-id/{id}.json`), and every record already carries a
`site` field. Keep it: per-client stores, credentials, deploys, MCP
endpoint, and blast radius — no key-namespacing inside one store, no shared
credential surface across clients.

### 2.2 Target layout (recommended; confirm at OQ-W11-1/2)

```
packages/core/          # LAW + MACHINERY — fleet-updated by canonical changes
  schema/               # object-record, bodies, patch ops (from src/schema)
  lib/                  # registries, grammar, validation, contract, ids (from src/lib)
  server/               # verbs, store, publish, materializers, release, MCP factory (from netlify/)
  components/           # section components, PageObjectRenderer, canvas
  admin/                # W9 workspace (React islands, admin functions as factories)
  cli/                  # roundtrip driver, reconcile, build-diff, sync — site-parameterized
sites/drlurie/          # ONE CLIENT — data + bindings only
  site.config.*         # domain, permalinks, metadata, redirects (routing authority stays a FILE per Wolf B2 — relocated per site, not objectified)
  netlify.toml          # generated/templated from site.config
  seeds/                # scripts/lib/*-seed-data.mjs, moved
  data/site/            # committed exports (src/data/site, moved)
sites/<client>/         # each further client: same shell, own Netlify site + env
```

One monorepo while clients are few and one team runs them: a canonical
change is a PR to `packages/core`; CI builds, tests, and build-diffs every
site in the matrix; a fleet release updates all clients. **What
fleet-propagates is code (renderer, verbs, validation, admin). What never
fleet-propagates is data (content, recipes, tokens — copy semantics, by
design).** Starter recipes/default themes ship as seeds a client re-syncs
deliberately. Rejected: template-repo + per-client forks (drift, manual
merges — the opposite of the mandate). Deferred: publishing core as
versioned npm packages — the graduation path if client repos must separate,
not the starting point.

### 2.3 De-hardcode inventory (what actually binds the repo to Dr-Lurie)

From the 2026-07-19 code survey, the coupling to break in T11.5–T11.6:

- `src/config.yaml` + `astro.config.ts` (site URL, permalinks, metadata
  template, image domains) → per-site config module. **Wolf B2 stands**:
  routing authority stays a committed config FILE — it becomes
  `sites/<client>/site.config.*`, it does not move into the site object.
- `netlify.toml` redirects (`/mcp`, `/admin/*`, `/blog`, `/shop`, `/pdf/*`,
  `/img/*`…) → generated per site.
- `tax_drlurie` hardcoded in `netlify/lib/taxonomy-enforcement.ts:25` →
  resolved per site (convention `tax_<site>` or from site config). **The
  `publish-article.ts` references stay byte-untouched** (off-limits file):
  the legacy article path remains Dr-Lurie-bound until its separate
  retirement; new clients never get the legacy pipeline (T9.22/T9.24 close
  it for Dr-Lurie).
- `strategy_drlurie` naming in `content-item` schema → site-derived id.
- Seeds (16 modules under `scripts/lib/`), committed exports
  (`src/data/site/*`), image-host URLs, git-committer fallback email →
  relocate to `sites/drlurie/` / per-site config.
- Env binding per site (`PUBLISH_SECRET`, `NETLIFY_SITE_ID`,
  `GITHUB_REPOSITORY`/branch, build hook, `MCP_HTTP_AUTH_TOKEN`,
  AI keys) → documented per-site env table, provisioned by the CLI.

### 2.4 New machinery the fleet needs (does not exist today)

- **Provisioning CLI** (T11.7): "new client" = one command + DNS — create
  the Netlify site, provision stores, seed the baseline pack (site
  singleton, nav skeleton, taxonomy skeleton, default theme, starter
  recipes), emit the env checklist.
- **Fleet CI** (T11.8): per-site matrix (build + test + build-diff + seed
  drift guards) on every core change — this is the mechanism that makes
  "canonical changes update all clients" true and safe.
- **Schema-migration harness** (T11.9): today's additive-optional
  discipline works for one site; a fleet needs formal
  `schema_version` migrations + a gate that validates every client's
  store/exports against a core bump before rollout.
- **Per-site governance** (T11.10): per-site policy files, users/roles
  bootstrap, per-site publish secrets with a rotation runbook, and the
  minimal OQ-3 slice (per-agent credentials) per Wolf's OQ-W11-5 ruling —
  at fleet scale, self-declared `agent_name` over one shared key stops
  being acceptable.

### 2.5 Acceptance: the second-site proof (T11.11)

W11 is done only when a real second Netlify site exists end-to-end:
provisioned by the CLI, seeded, an agent round-trip (create → patch →
publish → release) proven against it, Dr-Lurie demonstrably unaffected, and
one core commit shown to rebuild BOTH sites via fleet CI. That is the
five-criteria spirit applied to the platform itself.

## 3. W12 — Site capture (point an agent at a site)

### 3.1 Pipeline stages (all output is data through governed verbs)

1. **Snapshot** (T12.1): crawl an authorized target — DOM, screenshots,
   computed styles — into a stable snapshot format. Throwaway spike first.
2. **Decompose** (T12.2): snapshot → section-palette mapping with per-block
   confidence, plus a **palette-gap report** for everything inexpressible
   (feeds T10.7 / OQ-W8 evidence — the growth loop).
3. **Theme-extract** (T12.3): computed styles → a draft `theme` (colors,
   fonts, W10 axes) + `site_apply_theme` dry-run.
4. **Emit** (T12.4): mapping + theme → object graph via the EXISTING MCP
   verbs — theme, section templates, page templates, pages — into the
   target client site (staging client from T11.11; pre-W11 fallback per
   OQ-W12-3). Everything lands as drafts; nothing auto-publishes.
5. **Fidelity loop** (T12.5): screenshot-diff scoring against the target,
   bounded iteration, and a fidelity report scored against the
   "reasonable limits" rubric (OQ-W12-2).

### 3.2 Reasonable limits (the product promise, stated)

The pipeline reproduces **information architecture, section structure, and
design tokens within the system's vocabulary** — it does not inject
arbitrary CSS, mint unreviewed section types, or bypass PageType law. The
promise is "recognizably the same design language, fully agent-
administrable afterwards," with the vocabulary growing deliberately via the
gap-report loop — not pixel-perfect replication, which would require
exactly the free-form styling the constitution forbids.

> **SUPERSEDED (OQ-W12-1, 2026-07-22).** The rule below is retained for
> history but no longer governs. Capture authorization is now **per-project
> and contract-owned**, not a global built-in precondition — see the current
> rule immediately after this block and
> [`decisions/2026-07-22-platformization-and-capture-rulings.md`](decisions/2026-07-22-platformization-and-capture-rulings.md).

_~~**Authorization rule (OQ-W12-1, blocking precondition in every T12 brief):**
capture targets are properties Wolf owns, licenses, or explicitly
authorizes. The pipeline reproduces structure/layout vocabulary and
extracts palette values; body copy and media are regenerated as original
content unless content rights are held. Agent sessions refuse other targets.~~_

**Authorization rule (OQ-W12-1, RATIFIED 2026-07-22 — per-project,
contract-owned):** the capture pipeline carries **no built-in ownership
precondition**. The model's own hard refusals are the **sole universal
floor**. Every other limit — what may be captured, from where, and what may
be done with the result (including copy-rights / regenerate-vs-keep) — is a
**setting the target client repo owns** and declares through **its MCP
contract**. The pipeline **reads those contract-declared bounds and stays
inside them**. Fidelity expectations (OQ-W12-2) are a coverage-based
**default the project may override** through the same seam; captures land as
**never-released drafts in the target project's own store** (OQ-W12-3).

**Implementation consequence (the seam the pipeline reads):** CMS-Agent's
project registry needs a **per-project governance/limits block** beside the
existing `contentContract` / `toolPolicies` / `publishingPolicy`. Each client
declares its capture settings there, exposed via `registry_get` /
`object_contract`; the pipeline reads that block to learn the bounds it must
honor (tracked in T12.1). This replaces the old "agent sessions refuse other
targets" global gate.

## 4. Model allocation — flexible by construction

Allocation lives in **`queue.tsv`'s model/effort columns**, read per row by
`run-next-task.sh` — reallocating a task = editing its row (no brief
changes; briefs state the recommended default). Wolf's standing ruling
carries over (2026-07-16: Fable/Opus budget is not a constraint — lean up
when in doubt).

The ladder, per the W9 convention:

- **Fable** (`claude-fable-5`) — security boundaries and the hardest
  generative/correctness work: T10.1 (schema + CSS-injection surface every
  later task inherits), T11.3 (server-layer extraction: auth, publish key,
  MCP factory), T11.5 (frozen-file-adjacent de-hardcoding), T11.9
  (migration harness), T11.10 (credentials/governance), T12.1/T12.2 (the
  capture spike + decomposition mapper — the wave's central generative
  problem).
- **Opus** (`claude-opus-4-8`) — substantial product/integration work with
  design judgment but no security blast radius: palette mints, extraction
  moves, provisioning CLI, fleet CI, emission + fidelity loop.
- **Sonnet** (`claude-sonnet-5`) — mechanical, prep, records, and
  checkpoint/human-gate ratification tasks.

Operational knobs for auto runs: the runner's `--max-budget-usd` default
(8) is tuned for Sonnet/Opus rows — Fable rows are marked `notify` where
they must be watched; if Wolf ever flips a Fable row to `auto`, raise the
budget cap deliberately. Effort tiers follow the same logic (`xhigh`
reserved for T11.3-class and T12.2-class problems).

## 5. Verification strategy

- **Every task:** `npm run check` + `npm test`; commit to the working
  branch with the `T<id>:` prefix; no PR unless the brief says so.
- **W10:** build-diff EMPTY at every default (token axes and new types must
  not move a pixel until used); the 21-section showcase page pins the
  union; new types ship with editor hints + `useWhen` and appear in
  `object_contract.section_types`.
- **W11:** the public build of `sites/drlurie` stays **byte-identical**
  through every extraction task (build-diff against pre-move `main`); the
  full suite runs green from the new layout; T11.11 is the credentialed
  fleet proof recorded in state-of-play.
- **W12:** leak rules unchanged (`private.*` never renders); everything the
  pipeline writes is draft-state and validate-clean; the fidelity report +
  gap report are committed artifacts of every run.
- **Records:** per the house rule, wave completions update
  conversion-map/inventory/state-of-play in the same change (T10.9, T11.12,
  T12.6 carry the records step).

## 6. Open questions for Wolf

> **RATIFIED (2026-07-22).** The W11 + W12 questions below are answered — see
> the ANSWER lines inline and the consolidated RATIFIED block in §6.1. Do not
> re-open; cite
> [`decisions/2026-07-22-platformization-and-capture-rulings.md`](decisions/2026-07-22-platformization-and-capture-rulings.md).
> The W10 questions (OQ-W10-1…3) are NOT part of this record — they are
> governed by the earlier T10.4 ratification, and OQ-W10-3 (composite)
> remains open in `composite-sections-decision.md`.

- **OQ-W10-1 — Mint list:** ratify/edit T10.3's proposed new section types
  and variant fields (gates T10.5/T10.6).
  > _Governed by T10.4 (mint batch ratified; T10.5–T10.8 executed) — not this record._
- **OQ-W10-2 — Token axes:** ratify the axis set + enum values of §1.1
  (gates T10.1's final shape; the sketch above is the recommendation).
  > _Governed by the W10 checkpoint — not this record._
- **OQ-W10-3 — Composite:** T10.7's decision memo IS the OQ-W8-1…4
  package — answer there; any composite build is a new wave.
  > _STILL OPEN in `composite-sections-decision.md` — not this record._
- **OQ-W11-1 — Repo strategy:** one monorepo (`packages/core` +
  `sites/<client>`), recommended — or split repos with published packages?
  > **ANSWER (2026-07-22): monorepo** (`packages/core` + `sites/<client>`), as recommended. Split-repos/published-packages is a later graduation, not v1.
- **OQ-W11-2 — Content exports location:** per-client dirs in the monorepo
  (recommended for v1) or per-client content repos?
  > **ANSWER (2026-07-22): per-client dirs in the monorepo** for v1. Per-client content repos deferred.
- **OQ-W11-3 — Admin console:** per-site admin (recommended v1, matches
  "the system is site-wide") vs one console over many sites (new auth
  architecture — defer)?
  > **ANSWER (2026-07-22): per-site admin** for v1. One-console-over-many-sites deferred (new auth architecture).
- **OQ-W11-4 — Tenant boundary:** confirm one Netlify site per client
  (stores/creds/deploys isolated), no key-namespacing inside one store.
  > **ANSWER (2026-07-22): confirmed — one Netlify site per client.** No key-namespacing inside one store; no shared credential surface across clients.
- **OQ-W11-5 — OQ-3 scope:** is the minimal per-agent-credential slice in
  scope for T11.10 (recommended) or a separate wave?
  > **ANSWER (2026-07-22): in scope for T11.10** — the minimal verifiable-per-agent-token slice (not a full IAM).
- **OQ-W11-6 — `mcp/save-json-blob-mcp/` disposition (added 2026-07-22):**
  is the legacy save-json-blob MCP extracted into `packages/core`?
  > **ANSWER (2026-07-22): NO — retire it with the legacy pipeline** (T9.22/T9.24 line), importer-check first; it is NOT carried into `packages/core`. Treated as legacy-bound like `publish-article.ts` by the extraction (T11.2–T11.4) and de-hardcode (T11.5–T11.6) tasks.
- **Lint exit-bar carve-out (ratified 2026-07-22):** does the zero-`drlurie`
  core lint apply to `tests/` fixtures?
  > **ANSWER (2026-07-22): NO — `tests/` fixtures are EXEMPT for v1** (application code only). Parameterizing fixtures is deferred. The §8/W11 exit criterion reads against application code.
- **OQ-W12-1 — Capture authorization:** confirm the §3.2 rule (owned/
  licensed/explicitly authorized targets only; structure + tokens, original
  copy unless rights held).
  > **ANSWER (2026-07-22): OVERRIDDEN — authorization is PER-PROJECT and CONTRACT-OWNED, not a global rule.** The model's own hard refusals are the sole universal floor; every other limit is a setting the target client repo owns and surfaces through its MCP contract, and the pipeline reads those contract-declared bounds and stays inside them (no built-in ownership precondition). This supersedes the §3.2 "blocking precondition" text.
- **OQ-W12-2 — Fidelity bar:** what score counts as "a copy within
  reasonable limits"? (Recommendation: section-mapping coverage ≥ 90%,
  token extraction complete, layout gaps enumerated in the report — not a
  pixel threshold.)
  > **ANSWER (2026-07-22): coverage-based default, per-project overridable** — coverage ≥ 90% + tokens complete + gaps enumerated (not a pixel threshold), as the DEFAULT each project may override via its own contract-declared settings.
- **OQ-W12-3 — Landing zone:** clones land in the T11.11 staging
  client (recommended); if W12 is pulled ahead of W11, they land as
  never-released drafts in the Dr-Lurie store — acceptable?
  > **ANSWER (2026-07-22): never-released drafts in the TARGET PROJECT'S OWN store** (the T11.11 staging client when W11 is in place; otherwise the target project's store directly — not a Dr-Lurie-only fallback). The T12.1 spike runs LOCAL (no store writes). Nothing auto-publishes.

### 6.1 RATIFIED block — 2026-07-22 platform & capture rulings

Recorded verbatim-in-intent from Wolf's rulings; full text and rationale in
[`decisions/2026-07-22-platformization-and-capture-rulings.md`](decisions/2026-07-22-platformization-and-capture-rulings.md).

| OQ            | Ruling                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-W11-1      | Monorepo (`packages/core` + `sites/<client>`).                                                                                           |
| OQ-W11-2      | Per-client dirs in the monorepo (v1).                                                                                                    |
| OQ-W11-3      | Per-site admin (v1).                                                                                                                     |
| OQ-W11-4      | One Netlify site per client; no key-namespacing inside a store.                                                                          |
| OQ-W11-5      | Minimal per-agent-credential slice in T11.10 scope.                                                                                      |
| OQ-W11-6      | `save-json-blob-mcp` retired with the legacy pipeline (importer-check first); NOT extracted into `packages/core`.                        |
| Lint carve-out | Zero-`drlurie` core lint = application code only; `tests/` fixtures EXEMPT for v1 (parameterization deferred).                          |
| OQ-W12-1      | Capture authorization is per-project and contract-owned; model hard refusals are the sole universal floor; no built-in ownership gate.   |
| OQ-W12-2      | Coverage-based fidelity default (≥ 90% + tokens complete + gaps enumerated), per-project overridable.                                    |
| OQ-W12-3      | Captures = never-released drafts in the target project's own store; T12.1 spike local.                                                   |

> **T11.0 CLOSED (2026-07-23).** Checkpoint gates both met: (a) T9.24 legacy
> deletion verified landed on `main` @ `5d74ad19` (PR #470) — deleted admin
> pages/functions absent, HARD-STOP files (`publish-article.ts`,
> `admin-workflow-lock.ts`) intact, `save-json-blob-mcp` retained per OQ-W11-6;
> (b) the OQ-W11-1…6 rulings above are recorded and dated. Owner-ratified
> in-session (A1 async-review; 24h objection window waived). W11 extraction
> (T11.1→) unblocked.

## 7. Queue integration (how this runs auto)

> **Standing execution instruction:**
> [`cms-pipeline/autonomous-run.md`](cms-pipeline/autonomous-run.md) — the
> paste-able/Routine-attachable instruction that runs this queue at maximum
> autonomy (async-review checkpoints, wave-PR merge policy, hard stops).
> Effective once merged by the owner; Wolf edits its AUTHORIZATIONS block
> to widen or narrow autonomy.

- Rows appended to `cms-pipeline/queue.tsv` after T9.25, in order
  T10._ → T11._ → T12._. The runner executes the first not-done row, so
  **W9's remainder runs first by default** — correct, since W11 gates on
  T9.24. W10 is parallel-safe with the W9 tail: to start it early, move the
  T10._ rows above the remaining T9.\* rows (or run them interactively) —
  reordering the file IS the scheduling mechanism.
- `checkpoint` rows (T10.4, T11.0) halt the runner until Wolf's answers are
  recorded; `human_gate` rows (T10.9, T11.11, T12.6) are prepared by agents
  and completed by a credentialed human action; `notify` rows are run
  interactively and watched (Fable-class).
- T12.1 (spike) depends on nothing technical and may be pulled forward
  anytime for early evidence; T12.4+ need a landing zone (OQ-W12-3).
- Every brief's `depends_on` is honored by the standing runner prompt: a
  missing dependency stops the task instead of proceeding.

## 8. Exit criteria

- **W10:** token axes live end-to-end (schema → registry → injection →
  theme apply) with byte-identical defaults; the ratified mint list built,
  registered, contract-surfaced; refreshed starter recipes CONVERTED (all
  five criteria, credentialed T10.9); the composite decision memo delivered.
- **W11:** `packages/core` + `sites/drlurie` layout building byte-identical;
  zero `drlurie` literals in core (lint-enforced) outside the frozen legacy
  files; provisioning CLI + fleet CI + migration harness live; per-site
  governance + secrets rotation runbook in place; **T11.11 second-site
  proof recorded** — including one core commit rebuilding both sites.
- **W12 (NOT MET on measurement; T12.6 disposition OPEN):** the Zilberman target was
  captured through governed verbs into never-published drafts and its live
  fidelity + 14-gap reports are committed, but coverage was 52.94% against
  the 90% default and no draft-preview screenshots were available. The agent
  recommends “not accepted — record the misses”; **Wolf has not yet ruled.**
  The W10 growth-loop backlog is recorded in `design-vocabulary-gaps.md` §8;
  W12 requires remediation and a new acceptance run.
