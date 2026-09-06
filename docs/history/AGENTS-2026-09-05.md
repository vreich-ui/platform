# AGENTS (Project rules)

## Definition of "converted" — NO HALF MEASURES (Wolf, 2026-07-10, GOVERNING)

The project goal is: **agents edit objects on every page through the MCP.** "Convert
an object" means exactly that and nothing less. An object is converted ONLY when ALL
five hold (full definition + recipe: `docs/cms-architecture/conversion-playbook.md`):

1. **Renders** in Astro from the object (the four build gates).
2. **Store-backed** — a real record in the **production object store** (`object_inventory`
   returns it), not merely a committed git export. A rendered export with no store
   record is a **rendered stub, not a converted object**.
3. **Round-trips** — an agent can perform **every permitted action** end-to-end via MCP
   (checkout → each patch op → publish → release → re-render), proven not assumed.
4. **Contract-complete** — every permitted action is in `object_contract` AND backed by
   a real MCP server tool. A permitted action with no tool/contract entry is itself part
   of the conversion — build it.
5. **Recorded** — `object-inventory.md` row + `state-of-play.md` entry, same change.
   **No record = not converted.**

Hard rules: no half measures / no unfinished work (a "convert X" task is done only when
X passes all five); **after every session, update the documentation** (no written record
= not converted). Reality as of 2026-07-13: **forty-one objects converted** (the 37 below
+ the 3 W5 pages + the first article object, both credentialed 2026-07-13) — the 3 nav
objects, all 12 page objects (home + about + 8 W1 interior/system pages + page_contact +
page_thank_you), the 12 shared sections under home/about, the 3 templates, the
`tax_drlurie` taxonomy registry (curated agent-editable vocabulary; resolveTaxonomyTerm is
live), and the `site_drlurie` site singleton (W4, credentialed run 2026-07-11: the layout
renders brandTokens/logo/chrome/metadataDefaults/defaultNavigation from its export via
`set_site_fields`; urls/blog carried, config.yaml authoritative for routing — Wolf B2).
All proven by credentialed runs on 2026-07-11; no page renders from an unbacked
export anymore. The section-type palette is fully generic (`about`/`contact` decomposed,
`thank_you`→`form_confirmation`). W3 step 2 SHIPPED (2026-07-11): the bounded
publish-article enforcement hook (registry-gated, skips when no registry) + one-time
frontmatter normalization (93 posts) + registry display labels. The 28-invisible-posts
caveat is CLOSED (2026-07-11: 10 junk posts deleted, 18 stamped with `published_time`).
Agent-CREATED pages are live end-to-end (2026-07-11, B1 closed): the object-page
catch-all serves any published Page object whose route no file owns — create →
publish → release → live, zero code. Write-time guardrails (2026-07-11, traps
5+14 closed): validateObject blocks, at patch/create/publish, content that would
break the deploy (protected env values in any encoding; repo-file hotlink URLs)
or the build (per-component rich-text vocabulary via the real splitters).
W6 CONVERTED (2026-07-12, credentialed run same day): `listing`/`content_detail`
PageTypes are defined law (all five implemented; content_detail publishes with
zero sections) and six page objects (library, topics ×2, category, tag, article)
make listing headings/copy/SEO agent-editable — first lede = header block, extra
sections render after the list/article, per-term objects carry `%term%` pattern
copy — while query machinery stays the audited build-time derivation.
Byte-identical cutover; all six store-backed, round-tripped, published, released
(store === seed === export). Hidden sections are filtered at the resolver on
every render path (never-render-private). W5 was RE-GROUNDED in the shop module
(`docs/cms-architecture/06-shop-module-plan.md`; the shop build runs in its own
session; /services awaits a copy-or-delete call). **W7 CONVERTED (2026-07-13:
W7.3+W7.8 built, W7.9 credentialed run same day — demo article live at
/object-model-demo; seed taxonomy fixed to registry terms)**: `content_item` is the ninth
governed type — annotated-node articles (per-block `private.strategy`
hook/agitation/…/resolution + `intent`; envelope claims/scores/lineage;
plain-text or rich_text.v1 bodies), six node ops with exact inverses,
`create_variant`, one slug space with the committed posts, the
reader-projection leak rule, and per-node canvas chips on the standard
EditSession → `update_node` → publish path. The 83 committed .md posts were
WIPED (Wolf 2026-07-13: "mostly junk … needs rewriting") and replaced by a
ten-article corpus (content_item objects, two per registry category;
`scripts/lib/articles-corpus-seed-data.mjs`) — the `post` collection is now
permanently empty. Wolf 2026-07-13 (resolves
OQ-W7-1): reverse support NOT required — no alias layer; legacy article
tools/functions may be updated or retired as W7.2/W7.5/W7.7 land, preserving
functionality on the object substrate.

## Core structure — read `docs/cms-architecture/core-structure.md` FIRST

The system standardizes on **Contentful's content model**: typed entry objects
(pages/sections — already built) + **Contentful Rich Text** JSON for all rich
content fields (replaces HTML strings). That doc has the canonical example for each
level and the ordered task list to finish the CMS. It is the entry point.

## Design north star — flexible objects, not a site replica (READ FIRST)

We are building a **flexible content backbone, not reproducing today's pages
one-for-one.** Prefer **reusable, agent-configurable components** (a `content_grid`
an agent can point at any content and set to N cells) over **bespoke per-page types**
(a section that renders exactly one page). Byte-identical cutover was migration
_safety_, not the goal — "an agent can now reconfigure this to play a different role"
is. **Litmus test:** if an agent can't repoint or reuse a thing without a code
change, it's a replica, not backbone — generalize it. Full rule + consequences:
`docs/cms-architecture/design-principles.md`. This **governs** where the phased-plan's
"faithful reproduction" / "new component type per page" framing conflicts.

## Rule summary

- Preserve the repository, remote MCP, and artifact workflow rules below unless a task explicitly changes them.
- Before starting Codex work, identify the correct base branch and dependency chain.
- For related or multi-step work, prefer an integration branch or the latest dependent branch instead of assuming `main`.
- Keep page-specific guidance in focused docs under `docs/agents/`.
- Before publishing any `content_item` article, read `docs/agents/publishing-policy.md` — the authoritative agent publishing policy (object path, functional blocks, media/`/img` rules, publish→release batching, gates, error recovery). It supersedes the legacy tool sequences in the older `docs/agents/*.md`.

## Repository Notes

- Site image assets live under `https://kugelmedia.netlify.app/drlurieblog/`; assume they are always available for this site.
- Use `https://kugelmedia.netlify.app/favicon.png` for the favicon.

## Codex task sequencing / base branch

- For multi-task plans, do NOT assume `main` as the base branch.
- Prefer an integration branch like `codex/<feature>` for the plan, or explicitly base from the most recent dependent branch.
- Include PR dependency note lines like `Depends on: #<PR_NUMBER>` when a PR depends on another PR, and clearly mention the required merge order.
- Warn before creating parallel PRs that touch the same files, because they are likely to create sequencing conflicts or duplicate work.

## CMS architecture project — mandatory context

If any task touches the object store, Pages, Sections, Navigation, Taxonomy,
Site config, Templates, or anything under `docs/cms-architecture/`, read these
files in full before writing any code, in this order:

1. The task's standalone brief: `docs/cms-architecture/cms-pipeline/T<phase>.<n>-*.md`
   — its header carries the task's `depends_on`, `mode`, and recommended
   model/effort. **Check `depends_on` before starting — if a dependency isn't
   built and merged yet, stop and say so.**
2. `docs/cms-architecture/cms-pipeline/queue.tsv` — task ordering and per-task
   mode/model/effort (the runner config; see `README.md` alongside it).
3. For full schema/type detail: `docs/cms-architecture/02-architecture-and-schema.md`
4. For permission/action rules: `docs/cms-architecture/03-mapping-and-agent-contract.md`
5. For the full per-task spec: `docs/cms-architecture/05-task-breakdown-and-open-questions.md`.
   (A consolidated master reference, `cms-architecture-consolidated.md`, is named
   by some briefs but has not been committed — the numbered source docs are
   ground truth where anything conflicts.)
6. `docs/cms-architecture/conversion-map.md` — the FULL tree of actual + potential
   objects (attributes, dependencies, dependents, Wolf's conversion priority).
   **Pick conversion targets and their boundaries from here.** Then
   `docs/cms-architecture/object-inventory.md` — the current catalog of content
   objects (each marked LIVE / SHELL / TODO), every object type's use + boundaries,
   and the MVP todo list. Read it to see what is already an editable object vs. still
   hardcoded. Both are hand-maintained and drift easily: **update the matching row/
   status mark in the SAME change** when you cut over a surface or publish/retire an
   object. For always-current machine truth, prefer the `object_contract` /
   `object_inventory` MCP tools over any doc.
7. **Converting a surface to an object? `docs/cms-architecture/conversion-playbook.md`
   is mandatory** — the exact lifecycle recipe, the call/response field names (do
   not guess them), and the trap table (deep-merge patch semantics, reference
   seeding, rich-text vocabularies, the expected sandbox publish block).

## CMS hard constraints — every task, no exceptions

- ~~`admin-workflow-lock.ts`, `publish-article.ts`, and existing article MCP
  tools are **off-limits**.~~ **VOID since 2026-07-29** — those files and the
  `save_json_blob_*` / per-stage tools were DELETED when the legacy article
  pipeline was retired (ruling OQ-W11-6). There is nothing left to protect and
  no successor alias; a doc or comment still naming them describes history.
  Articles are `content_item` objects on the governed object verbs.
- Every new file is additive. The public site must remain fully functional
  after every commit.
- One task, one commit. Do not bundle cleanup or unrelated fixes.
- Commit message must begin with the task ID, e.g. `T0.1: envelope schema module`.
- Do not open a PR unless the task brief explicitly says to.
- Do not push to `main`. Work on the task's integration branch.
- `route`-kind nav targets are intentional — do not "fix" them to `page`-kind.
- The `content_revision` counter and the `version` counter are independent —
  never conflate them. Lock writes bump `version` only, never `content_revision`.

## CMS amendment log — bake these in, do not miss them

When implementing body schemas (T0.2), all of the following must be present:

- M-1: `NavItem.description`
- M-2: `groups[].slot`
- M-5: `groups[].target` (stored, not rendered as a link)
- M-7: `NavItem.icon` and `NavItem.ariaLabel`
- Transitional `NavTarget {kind:'route', href}` union variant (deliberate, not a placeholder)
- `shared_ref` union member in section schema
- Transitional `content_grid` static-cards variant

M-8 (grid manual+fallback) is deliberately NOT in T0.2 — it lands in T3.3.

## Remote MCP / ChatGPT connector notes

- Production ChatGPT/Atlas connects to `https://drluriescience.netlify.app/mcp` and should see the connector name `Dr_Lurie_MCP_Server`.
- Keep `/mcp` routed through Netlify (`netlify.toml`) to the site function in `netlify/functions/mcp.ts` — the per-site shim over the core server in `packages/core/server/functions/mcp.ts`. (The `mcp/save-json-blob-mcp/` package that used to serve local stdio/standalone HTTP tests was deleted with the legacy pipeline on 2026-07-29.)
- If ChatGPT reports `No tool was defined under the given paths`, verify the deployed `/mcp` route first with `initialize` and `tools/list` JSON-RPC requests before changing tool names or schemas.
- Do not expose `NETLIFY_PUBLISH_SECRET` or `PUBLISH_SECRET` to browser code, tool schemas, prompts, or checked-in client configuration. MCP tool calls must use server-side environment variables only.

## Agent artifact workflow rules

- When an agent generates artifacts (images, audio, video, binary files, or markdown files), it must upload them immediately and store the returned `ArtifactReference`/`blobKey` in MCP request state or the relevant agent output. For generated binary files and images, use `create_artifact_upload_intent` plus raw HTTP `POST /api/artifacts/upload` as the default upload path. `save_artifact` remains available only for legacy small-artifact MCP compatibility.
- Agents must never attempt to generate deterministic artifact blob keys themselves. Let the artifact tool return `blobKey`, `sha256`, size, content type, and timestamp.
- Treat every `ArtifactReference` as immutable. If an artifact must be regenerated, upload it again and use the newly returned reference.
- If an artifact upload tool call or direct HTTP upload fails or times out, retry the same upload flow when safe and rely on server-side idempotency/checksum deduplication instead of inventing a new handle.
- Before publishing, re-fetch the workflow/request state and use the current `artifactReferences` returned from MCP. Publishing payloads may include `mediaEntries` (existing base64) and/or `artifactReferences`; do not publish until artifact references are present and resolvable by the server-side publishing path.
- Do not ask users for, display, or pass Netlify/GitHub publishing credentials. Artifact upload, artifact resolution, and publication use server-side environment variables only.

## Page-specific rules

- See `docs/agents/shop-layout.md` for `/shop` mobile rules.
