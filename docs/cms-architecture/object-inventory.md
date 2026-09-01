# CMS Object Inventory — Dr. Lurié

**What this is:** the human-readable catalog of every content object the Dr. Lurié
site is (or should be) made of — what each object is _for_, where its _boundaries_
are, and whether it is **CONVERTED** (agent-editable), merely **RENDERS**, a
**SHELL**, or still a **TODO**. Read this to understand "what can an agent actually
edit today, and what is still hand-coded."

**This is a standing reference, not a session log.** The session-by-session
narrative lives in [`cms-pipeline/state-of-play.md`](cms-pipeline/state-of-play.md).
This file answers a different question: _at rest, what objects exist and what is
their status?_

**Governing design rule:** the objects are a **flexible backbone, not a replica of
the current site** — see [`design-principles.md`](design-principles.md). Prefer
reusable, agent-configurable components over bespoke per-page types.

---

## How to keep this current (for agents)

This file is **hand-maintained and drifts easily** — treat it like the map, not the
territory. The territory is: the production object store, `main`, and the live
`object_contract` / `object_inventory` MCP tools.

- **When you cut over a surface, create/publish an object, or wire a new source of
  truth — update the matching row here in the _same_ change.** A cutover PR that
  leaves this file stale is incomplete.
- **Never trust a row over real state.** Before building on "LIVE", verify against
  `object_inventory` (store state) and `main` (rendered state). Before claiming a
  boundary, verify against `object_contract('<type>')` — that tool is _derived from
  the enforcing code_ and cannot drift; this doc can.
- **Status is a claim about reality, not intent.** Mark something CONVERTED only when
  it actually drives the live site _and_ is agent-editable through the MCP (all five
  playbook criteria). If it only renders, it is RENDERS, not CONVERTED — never
  overstate it.
- **Keep it plain.** This page is read by humans deciding what to work on. Schemas,
  op names, and field lists belong in `object_contract`, not here.

### Two different states — do not conflate them (Wolf, 2026-07-10)

A page can **render** from a committed export while having **no editable record in
the production store**. These are different, and only the second is "converted"
([`conversion-playbook.md`](conversion-playbook.md) definition of done):

- **RENDERS** — Astro builds the page from `src/data/site/pages/*.json`. Cheap; a
  git commit is enough.
- **CONVERTED** — a real record exists in the production object store and an agent
  can fully manipulate it via MCP (checkout → patch → publish → release → re-render).
  This needs production credentials and a proven round-trip.

**As of 2026-07-15, forty-seven objects are CONVERTED** (the 41 baseline +
the 6 W8 recipe records — see "Recipe family (W8)" below). The ledger
counts objects whose round-trip was individually proven in a credentialed
run; the ten-article corpus (W7.9 aftermath — created → published → released
end-to-end via MCP, all store-backed) is live production content of the
converted `content_item` type but only the demo article's full op-drill ran,
so the ledger counts the demo, not the ten. (all via credentialed
`home-conversion-roundtrip.mjs --production --release` runs — store-backed, every
permitted op round-tripped in production, published, `released:true`): the 3 nav
objects; the home-page family (`page_home`, `sec_home_audience_grid`,
`sec_home_start_grid`, `sec_newsletter_signup`); the /about family (`page_about` +
`sec_about_intro`/`_thinking`/`_products`/`_science`/`_research`/`_blog`/`_note`/`_cta`);
**all 8 W1 interior/system pages + `page_contact` + `page_thank_you`; the 3
templates (`tpl_interior`/`tpl_landing`/`tpl_legal`); the `tax_drlurie`
taxonomy registry; and the `site_drlurie` site singleton (W4)** — the page +
template backlog landed in one batched credentialed run on 2026-07-11, the
taxonomy and site singleton in their own runs the same day. **All 12 page objects
are converted; no page renders from an unbacked export anymore** — the rendered-stub
backlog is empty. See "Why only nav is converted" (historical root-cause analysis)
at the bottom. **W6 (2026-07-12) added six CONVERTED listing/article page
objects** (see "Listing & article surfaces") — Wolf's credentialed run the same
day went all-green: store-backed, every permitted op round-tripped, published
(export commits `7956b13`…`b0f8d90`), `released:true`; store === seed ===
export byte-verified (record_version 11 across all six). **W5's credentialed
run (2026-07-13) added the three previously hand-coded pages**
(`page_shop_preview`, `page_pricing`, `page_services` — see §1): the
hand-coded-page backlog is empty for good. **W7.9 (2026-07-13) added the
forty-first: the first `content_item` article object** (the
`/object-model-demo` demo), joined since by the ten-article corpus.

### Status legend

| Mark             | Meaning                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🟢 **CONVERTED** | Real content, renders live **and** an agent can fully manipulate it through the MCP (the playbook's 5 criteria all met). Nav + the home-page & /about families today.                                                                            |
| 🟣 **RENDERS**   | Builds and serves from a committed export, but has **no editable store record** — a rendered stub, not converted. Most "pages" are here.                                                                                                         |
| 🟡 **SHELL**     | Exists structurally (a record is published, or a route is scaffolded) but is a **placeholder, a test artifact, or not yet wired to drive the live site**. The real source of truth is still somewhere else. The note says which half is missing. |
| 🔴 **TODO**      | Needed for the CMS MVP. Not built yet.                                                                                                                                                                                                           |

---

## The object types (use & boundaries)

Ten object types exist, and **all ten are governed** (edited through the
generic object verbs and the approval policy — the authoritative list is
`objectTypes` in `src/schema/object-record-v1.ts`): W7.3 (2026-07-13)
brought `content_item` into the model, and W8 (2026-07-14) added
`section_template` and `theme`, the section- and site-level members of the
recipe family (released 2026-07-14, CONVERTED on the 2026-07-15
application-verb production proofs —
[`09-template-system-plan.md`](09-template-system-plan.md)); see
"Recipe family (W8)" under Singletons & templates below. (Session logs call
these waves the "ninth/tenth/eleventh governed type" — historical labels
that over-count by one; the contract enumerates ten.) The COMMITTED legacy posts (src/data/post/\*.md)
stay on the older article pipeline untouched — Wolf's ruling: not worth
migrating; new articles are objects. **Boundaries below are the human summary —
the machine-checked, always-current version is `object_contract('<type>')`.**

Current publish posture (`src/config/approval-policy.ts`): **`all-autonomous`,
with `product` pinned to require-approval** (06-shop-module-plan §0.4: an agent
proposing a product change is fine; a price change going live without a human
eye is not). `content_item` is autonomous under the master — Tier 1 preserved
(OQ-W7-4); gate it any time with one config pin. Every other governed type
publishes autonomously; every publish still writes a full, revertible audit
trail. Flip one file to change the posture per type.

| Type                        | What it is / used for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Key boundaries (summarized)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **page**                    | One editable page of the site: a route + ordered list of sections. The unit a route file renders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `route` unique and starts with `/`; ≥1 non-hidden section to publish; section types must satisfy the PageType's allow/require rules; `template`, `navigationOverrides`, `shared_ref` and grid references must resolve.                                                                                                                                                                                                                                                                                                                                                                                                           |
| **section** (shared)        | A section stored on its own so several pages can reference the _same_ instance via `shared_ref` (edit once, changes everywhere). Inline sections live inside a page and are **not** separate objects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Same per-variant schema as inline sections; a `shared_ref` may not shadow-copy its target's type/data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **navigation**              | A menu: the header, a footer, or a variant footer. The site chrome renders from these.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | No empty groups; menu depth ≤ 2; duplicate targets in a group **warn** (the audited nav does this legitimately); header action count over budget **warns**; a _published_ nav may not point at an _unpublished_ page.                                                                                                                                                                                                                                                                                                                                                                                                            |
| **taxonomy** (singleton)    | The controlled vocabulary — categories & tags — articles and listings draw from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Slugs lowercase-hyphen, unique per kind; a deprecated term's `merged_into` must point at an active same-kind term and form no cycle. **Boundary caveat: not yet the real source of truth — see below.**                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **site** (singleton)        | Global config: brand tokens, logo, chrome toggles, blog paths, and the default header/footer navigation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | One per site. **Boundary caveat: not yet wired to drive rendering — see below.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **template**                | A reusable page blueprint (slots + allowed section types + default blueprints). Records _provenance_ only — pages do **not** live-inherit from a template after instantiation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A slot's blueprint type must be in that slot's allowed set; allowed types must be registered components.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **product**                 | One sellable digital good (download / pay-to-unlock / tip-PWYW / free lead magnet): `slug` + presentation + commerce + a fulfillment union on `kind`. Long-form copy composes via `presentation.page_ref` → an ordinary Page (06-shop-module-plan §1–2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Slug lowercase-hyphen + unique (→ `/shop/<slug>`); mode↔fields coherence enforced; **price cache + Stripe linkage are NOT agent-patchable** (`product_set_price` only, S3); `fulfillment.artifact_ref` must be a trusted private-store ref; **publishes review-required**.                                                                                                                                                                                                                                                                                                                                                      |
| **content_item** (articles) | An article as an annotated NODE LIST (W7.3): every block carries `private.strategy` (hook/agitation/…/resolution) + `intent` plus commercial/rendering/chat metadata; `public.body` is plain text or a `rich_text.v1` document. Envelope carries the judge/score substrate (claims/sources/compliance/emotional_strategy/scores/lineage). `create_variant` clones a draft for A/B judging. Renders through the blog furniture at `/<slug>`, joining listings/tags/RSS automatically. Optional free-text `author` byline (T9.23a, 2026-07-23 — the one T9.23 parity gap; set via `set_article_meta`, editable from the canvas panel and the workspace Details drawer) renders as `By <author>` in the meta line when set; omitted, no byline renders (all 12 live articles are still author-less). | `req_*` ids (artifact trust preserved); slug lowercase-hyphen + unique across articles AND committed posts; ≥1 public content node to publish; node ids opaque (no strategy words); annotations NEVER render (leak rule); `author` ≤120 chars, plain text, included in the reader-safety leak scan same as title/deck; rich-text bodies limited to the renderable grammar (embeds blocked until resolvers exist). **The 83 legacy committed posts were WIPED (Wolf 2026-07-13); the live corpus is 10 `content_item` objects + the demo, all store-backed.** Slug uniqueness still spans any committed posts should they return. |
| **section_template** (W8)   | A section-level recipe: ONE pre-configured section blueprint (+ name/description/whenToUse/scope) an agent stamps into any page or mints as a standalone `sec_*` object via `object_instantiate_section_template` — copy at stamp time, never live-bound. Records CONVERTED (verb proofs 2026-07-15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Blueprint must be a standalone-placeable registered type (no `card` leaf, no `shared_ref`, no manual content picks, no asset refs — self-contained); metadata trio (description/whenToUse/scope) REQUIRED TO PUBLISH; creation gated by `src/config/creation-policy.ts` (open today).                                                                                                                                                                                                                                                                                                                                            |
| **theme** (W8)              | A brandTokens preset (name/description/whenToUse/scope + `tokens: {colors, fonts}`): agents draft/validate a palette, then `site_apply_theme` copies it onto the site singleton as ONE exact-replace `set_site_fields` op (stale keys unset). NOT taxonomy; the site never live-inherits. Record CONVERTED (verb proofs 2026-07-15; tokens = launch palette, see drift caveat).                                                                                                                                                                                                                                                                                                                                                                                                                   | Published themes must carry every renderer-consumed color key (apply is total); token values must pass the safe-CSS grammar (raw `<style>` interpolation — the same rule gates `site.brandTokens`); metadata trio REQUIRED TO PUBLISH; creation gated by the same committed policy.                                                                                                                                                                                                                                                                                                                                              |

**Planned, not yet built — W13 (2026-07-19, see [`12-object-tracking-and-analytics.md`](12-object-tracking-and-analytics.md)):** an eleventh governed type **`tracking_config`** (`trk_drlurie` — the per-project tracker registry: provider switches with regex-pinned IDs, geo-adaptive consent posture, per-type collection defaults; require-approval + human-executed publish recommended, OQ-W13-2) plus a cross-type **`tracking` body attribute** on all ten existing types (enabled/label/tags/goals, written only by the new `set_tracking` op). NOTHING exists in schema or store yet — rows appear here only as objects convert. The 2026-07-19 directive supersedes the older "analytics stays in config.yaml" boundary recorded under Singletons below.

**What goes _inside_ a page/section — the section-type palette.** A page's sections
are each one of the registered section types (`hero`, `lede`, `prose`, `checklist`,
`content_grid`, `bio`, `newsletter_signup`, `testimonial`, `cta_banner`, `faq`,
`link_list`, `product_preview`, `contact_form`, `form_confirmation`, `search`,
`content_embed`) plus the `card` leaf and the `shared_ref` pointer. **As of
2026-07-11 the palette is fully generic — every bespoke single-use page type has
been retired:** `about` (2026-07-10) and `contact` (2026-07-11) decomposed into
reusable sections, and `thank_you` was renamed to the reusable `form_confirmation`.
The live list + each type's field schema is `registry_get('component')` /
`object_contract('page').section_types`.

---

## Object inventory (concrete records)

### Pages — 12 render; **all 12 CONVERTED** (2026-07-11 batched run)

All 12 build and serve from committed exports and are now **CONVERTED** — store-backed
in production, round-tripping every permitted op via MCP, published, and released.
`page_home` + `page_about` landed 2026-07-10; the remaining 10 (8 W1 interior/system
pages + `page_contact` + `page_thank_you`) landed 2026-07-11 in one batched
credentialed `convert-pending-production.sh` run (`released:true`; each `ensure`
reported "already matches the seed" → store === seed === export).

**NEW pages are fully agentic (2026-07-11):** the object-page catch-all
(`src/pages/[...objectPage].astro`) serves any published Page object whose route
no hand-written file owns — create (`object_create` / `object_instantiate_template`)
→ publish → release, and the page is live at its route with zero code. Ownership
rules (file routes win; article permalinks and the blog/topics/admin path families
are refused with a build-log warning) live in `src/utils/object-page-routes.ts`.
The 12 pages below keep their thin loader files, so the catch-all emits nothing
for them.

| Object                | Route                     | Status       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page_home`           | `/`                       | 🟢 CONVERTED | **All five criteria met 2026-07-10.** Hero + bio inline; grids + newsletter are `shared_ref`s to standalone section objects. The broken store record was healed via reconcile ops, every permitted op round-tripped in production, published (v44+, `4753ae7`), and released (`released:true`). Seed === store === export.                                                                                                                |
| `page_start_here`     | `/start-here`             | 🟢 CONVERTED | Lede interior page. Seed in the W1 batch (`pages-interior-seed-data.mjs`); store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                                                    |
| `page_member_updates` | `/member-updates`         | 🟢 CONVERTED | Lede interior page. W1 batch; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                                                                                                 |
| `page_newsletter`     | `/newsletter`             | 🟢 CONVERTED | Lede interior page (plain lede today — the shared newsletter section can be added later). W1 batch; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                           |
| `page_free_guide`     | `/guides/free-guide`      | 🟢 CONVERTED | Lede interior page. W1 batch; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                                                                                                 |
| `page_early_access`   | `/solutions/early-access` | 🟢 CONVERTED | Lede interior page. W1 batch; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                                                                                                 |
| `page_thank_you`      | `/thank-you`              | 🟢 CONVERTED | **Decomposed 2026-07-11:** the bespoke `thank_you` type was RENAMED to the reusable `form_confirmation` (a `standard` page with one such section; the `?form=` swap script is unchanged furniture). Renders byte-identically; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                 |
| `page_about`          | `/about`                  | 🟢 CONVERTED | **Decomposed 2026-07-10** off the bespoke `about` anti-pattern into EIGHT standalone shared sections (bio + prose ×6 + cta_banner) — a `standard` page of 8 `shared_ref`s. Store-backed (record_version 10), round-tripped in production, published, released. (The bespoke `about` TYPE was retired 2026-07-10.)                                                                                                                         |
| `page_contact`        | `/contact`                | 🟢 CONVERTED | **Decomposed 2026-07-11** off the bespoke `contact` anti-pattern into reusable `lede` + `contact_form` (now carrying subtitle/description) + `content_grid` (`cards` source, cells gained an optional `icon`) — a `standard` page of 3 inline generic sections. Intentional scoped visual diff (rule 4); store-backed + round-tripped in production, published, released 2026-07-11. (The bespoke `contact` TYPE was retired 2026-07-11.) |
| `page_privacy`        | `/privacy`                | 🟢 CONVERTED | `system` PageType, reusable `prose` section (PR #380). W1 batch; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                                                              |
| `page_terms`          | `/terms`                  | 🟢 CONVERTED | `system` PageType, reusable `prose` section (PR #380). W1 batch; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                                                              |
| `page_404`            | `/404`                    | 🟢 CONVERTED | `system` PageType, reusable `cta_banner` section (PR #380). W1 batch; store-backed + round-tripped in production, published, released 2026-07-11.                                                                                                                                                                                                                                                                                         |

### Listing & article surfaces (W6, CONVERTED 2026-07-12)

The six T6.1 page objects: **headings/copy/SEO are object data; the query
machinery (post feeds, term filters, pagination, topic cards) stays the audited
build-time derivation.** Convention: the object's FIRST `lede` section is the
surface's header block (required by the `listing` PageType), rendered through
the surface's existing header furniture; every EXTRA section renders through
the component registry after the list/article — so "put a newsletter signup
below every article" is one `upsert_section` on `page_article`. Per-term
surfaces are ONE object per route family: their copy carries the `%term%`
token, interpolated with each term's display label at build. Seeds:
`scripts/lib/pages-listing-seed-data.mjs` (byte-identical transcriptions).

**Status: 🟢 CONVERTED (all five criteria, credentialed run 2026-07-12)** —
every `ensure` created the store record, all six page ops round-tripped in
production, published (`[skip netlify]` export commits `7956b13`…`b0f8d90`),
contract 6/6, inventory 6/6, `released:true`; store === seed === export
byte-verified (marker-stripped, record_version 11 ×6).

| Object              | Serves                                | Status       | Notes                                                                                                                                        |
| ------------------- | ------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `page_library`      | `/learn/library` (+ pagination)       | 🟢 CONVERTED | `listing`. Header lede ("Library" + blurb); title base + " — Page N" furniture.                                                              |
| `page_topics_index` | `/learn/topics`                       | 🟢 CONVERTED | `listing`. Header lede (kicker "Education library"); topic cards stay computed from category frontmatter (D§5.5), og image in seo.           |
| `page_topic_detail` | `/learn/topics/<slug>` (every topic)  | 🟢 CONVERTED | `listing`, per-term: heading `%term%`, kicker "Topic"; description pattern in seo.                                                           |
| `page_category`     | `/category/<slug>` (every category)   | 🟢 CONVERTED | `listing`, per-term: heading `%term%`, title "Category '%term%'".                                                                            |
| `page_tag`          | `/tag/<slug>` (every tag)             | 🟢 CONVERTED | `listing`, per-term: heading "Tag: %term%", title "Posts by tag '%term%'".                                                                   |
| `page_article`      | every article page (SinglePost route) | 🟢 CONVERTED | `content_detail`: route-level SEO defaults (robots fallback = config.yaml) + optional sections below the post. Publishes with zero sections. |

### Shared sections

| Object                   | Used by                         | Status       | Notes                                                                                                                                                                                                              |
| ------------------------ | ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sec_newsletter_signup`  | `page_home` (via `shared_ref`)  | 🟢 CONVERTED | **All five criteria met 2026-07-10:** store-backed, every permitted op round-tripped in production, published, released.                                                                                           |
| `sec_home_audience_grid` | `page_home` (via `shared_ref`)  | 🟢 CONVERTED | **New + converted 2026-07-10.** "This is for you if…" — `content_grid`, sanctioned `cards` source (curated text cells; replaced the bespoke `checklist` usage). Store-backed, round-tripped, published, released.  |
| `sec_home_start_grid`    | `page_home` (via `shared_ref`)  | 🟢 CONVERTED | **New + converted 2026-07-10.** "Start here" — the SAME `content_grid` type, `query` source (latest posts): one reusable type, two roles by configuration alone. Store-backed, round-tripped, published, released. |
| `sec_about_intro`        | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10** (/about decomposition). `bio` — intro heading + copy + portrait photo (the reusable bio type gained a URL `portrait`). Store-backed, round-tripped in production, published, released.          |
| `sec_about_thinking`     | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10.** `prose` — "A Different Way of Thinking About Health". Store-backed, round-tripped in production, published, released.                                                                          |
| `sec_about_products`     | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10.** `prose` — "Why Most Products Fall Short".                                                                                                                                                      |
| `sec_about_science`      | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10.** `prose` — "The Science Behind Real Results" (with list).                                                                                                                                       |
| `sec_about_research`     | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10.** `prose` — "From Research to Real Life" (with list).                                                                                                                                            |
| `sec_about_blog`         | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10.** `prose` — "Why This Blog Exists" (with list).                                                                                                                                                  |
| `sec_about_note`         | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10.** `prose` — "A Personal Note".                                                                                                                                                                   |
| `sec_about_cta`          | `page_about` (via `shared_ref`) | 🟢 CONVERTED | **New 2026-07-10.** `cta_banner` — "Start With the Science" + the two closing actions.                                                                                                                             |

### Navigation

**The only truly CONVERTED objects today** — store-backed and agent-editable via MCP.

| Object            | Role                    | Status       | Notes                                                                                                                                                                                    |
| ----------------- | ----------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav_header`      | Site header             | 🟢 CONVERTED | Store-backed (record_version ~54), agent-editable — proven by real edits this project. Still carries a field-test description that a store-side `object_patch` + publish should restore. |
| `nav_footer`      | Default footer          | 🟢 CONVERTED | Store-backed, agent-editable; rendered on every page without a footer override. Store review_state is `changes_requested` from an old review never resolved.                             |
| `nav_footer_home` | Homepage footer variant | 🟢 CONVERTED | Store-backed, agent-editable; applied via `page_home.navigationOverrides.footer`.                                                                                                        |

Fleet renderability guard (2026-08-02): published `page` NavTargets resolve
through the committed Page collection on every navigation/action render path.
Every containing navigation/page/section/template publish is blocked until its
page-kind targets are themselves published, guaranteeing those route exports.
Until taxonomy-route resolution exists, `taxonomy` NavTargets are hard-blocked
by `render_nav_targets` at create/validate/patch/publish and must be expressed as
route-kind URLs. This closes the contract/renderer gap that broke the platform
release after adding `page_library` to `nav_header`.

### Singletons & templates

🟢 **`site_drlurie` is CONVERTED (W4, credentialed run 2026-07-11)** — all five
criteria: store-backed in production (create + publish + release
`released:true`; export commit `a20f107`, **store === seed === export
byte-verified**), `set_site_fields` (the type's only op) round-tripped, contract
advertised ≡ exercised, recorded here. Seed `scripts/lib/site-seed-data.mjs`
(byte-identical transcription of the previously hardcoded values), export
`src/data/site/site.json`. **LIVE from the object** (pre-conversion literals as
fallback when the export is absent — `src/utils/site-object.ts`, a deliberately
synchronous eager-glob loader so component evaluation order is unchanged):
brandTokens (every CustomStyles custom property, light + `dark:` keys) ·
logo.text · chrome{showRssFeed, showThemeToggle} · metadataDefaults (title
template, description, ogImage, twitter handle, og site_name) ·
defaultNavigation{header, footer}. **CARRIED but config.yaml stays
authoritative for routing** (Wolf B2): urls · blog{listPath, postsPerPage,
categoryBase, tagBase} — permalink wiring is a later cutover. NOT in the
object: i18n · ui.theme · analytics · googleSiteVerificationId;
chrome.announcement deferred (Wolf B3). (The field-test stubs were deleted in
PR #378.)

🟢 **`tax_drlurie` is CONVERTED (W3, 2026-07-11)** — Wolf's decision: a curated,
agent-editable vocabulary (5 categories + 26 tags distilled from the drifted
frontmatter of 93 posts; approved canonical list + raw→canonical mapping in
`scripts/lib/taxonomy-seed-data.mjs`). **All five criteria met by the
credentialed run 2026-07-11**: store-backed in production, every permitted term
op round-tripped (add/update/deprecate/reactivate/remove), published, released
(`released:true`; export commit `627fa8d`, store === seed === export). Its first
consumer is live automatically: the validation context wires
`resolveTaxonomyTerm`, so `content_grid` query terms now validate against the
real registry. **Step 2 SHIPPED 2026-07-11**: publish-article resolves
category/tags against this registry at publish time (slug resolution +
`merged_into` aliases; unresolvable terms → 422; canonical slugs materialized
into frontmatter; skips gracefully when no registry), all 93 posts' frontmatter
was normalized via the committed `RAW_TO_CANONICAL` map, and the blog renderer
displays term labels from the registry — full §5.5 is live for articles.

**Templates were ACTIVATED + CONVERTED 2026-07-11 (W2.5)** — design-principles
rule 5 ("templates are recipes; PageTypes are law"). The `object_instantiate_template`
MCP tool creates a new page from a recipe through the standard create validation
(`dry_run: true` previews without persisting); a required slot without a
blueprint instantiates from the registry defaultData of its first allowed type.
Three starter recipes are store-backed in production (batched run 2026-07-11 —
all 4 template ops round-tripped + instantiate `dry_run` proven, published,
released; metadata trio backfilled + fully re-drilled by the W8.4 run
2026-07-14, published at content revision 20):

| Object         | appliesTo  | Status       | Notes                                                                                                                                        |
| -------------- | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tpl_interior` | `standard` | 🟢 CONVERTED | Lede open + prose body + optional cta close (the W1 interior shape). All 4 template ops + instantiate `dry_run` round-tripped in production. |
| `tpl_landing`  | `standard` | 🟢 CONVERTED | Hero open + curated card grid + cta close (campaign shape). Round-tripped in production, published, released.                                |
| `tpl_legal`    | `system`   | 🟢 CONVERTED | One required blueprint-less prose slot — exercises the defaultData fallback. Round-tripped in production, published, released.               |

### Recipe family (W8) — CONVERTED 🟢 (released 2026-07-14; verb proofs 2026-07-15)

Designed, built (W8.1–W8.3b), and run (W8.4 credentialed run 2026-07-14 via
the session MCP connection) the same wave
([`09-template-system-plan.md`](09-template-system-plan.md)). Two object types
complete rule 5's recipe family (data, many, agent-editable; applied by COPY
at instantiation; never live-bound). All five playbook criteria hold per
object — the application-verb production proofs ran 2026-07-15:

| Object                  | Type               | Status       | Notes                                                                                                                                                                                |
| ----------------------- | ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stpl_hero_landing`     | `section_template` | 🟢 CONVERTED | Landing/campaign hero opener (`hero` blueprint). All 3 ops round-tripped in production; published, released.                                                                         |
| `stpl_audience_grid`    | `section_template` | 🟢 CONVERTED | Curated text-cell grid — hand-written "who this is for" / feature cells (`content_grid`, `source.kind: cards`).                                                                      |
| `stpl_related_articles` | `section_template` | 🟢 CONVERTED | Automatic further-reading strip (`content_grid`, `source.kind: related`, tag similarity, 3 tiles).                                                                                   |
| `stpl_newsletter_cta`   | `section_template` | 🟢 CONVERTED | The standing email-capture block (`newsletter_signup`, Netlify "newsletter" form).                                                                                                   |
| `stpl_cta_banner`       | `section_template` | 🟢 CONVERTED | Closing CTA banner — the interior-page closer.                                                                                                                                       |
| `thm_drlurie_default`   | `theme`            | 🟢 CONVERTED | The canonical palette, 19 color keys + 3 font stacks — live again since Wolf's ordered restore (2026-07-15). `set_theme_fields` round-tripped; apply verb proven end-to-end (twice). |

All six: created in production (`agent_name: w84-conversion-run`) → every
permitted patch op drilled with exact inverses (stpl:
`set_section_template_meta` / `update_blueprint_data` / `replace_blueprint`;
thm: `set_theme_fields`) → validated clean at publish level (incl.
`blueprint_standalone_renderable`, `theme_token_keys`, `brand_token_values`,
`recipe_metadata`) → published → released (deploy ready 2026-07-14T16:23Z);
store === seed === export verified byte-level. The same run backfilled the
metadata trio onto the 3 live `tpl_*` (Step 0 — now published at content
revision 20; exports content-identical to the W8.3b pre-materialization) and
re-proved `object_instantiate_template` dry*run on all three (incl.
tpl_legal's registry-fallback path). **Verb proofs (2026-07-15, after a connector reset exposed the W8 tools):**
`object_instantiate_section_template` dry_run in BOTH modes for EACH of the
five `stpl*\*`records — 10/10 eligible, zero blockers (per-object
conversion, the W2.5 precedent) — plus`site_apply_theme`dry_run and ONE
REAL default apply end-to-end (atomic op,`applied_theme`in history,
publish`ec2cbd3`, release). **The real apply exposed LIVE-PALETTE DRIFT:**
the site's brandTokens were rebranded in production on 2026-07-13 (teal/
terracotta, Source Serif heading) after the seeds were written, so the
"no-op" apply put the old palette live for ~6 minutes (09:30:57–09:37:13Z);
restored byte-exact (export commit `eba0c42`) and re-released. RESOLVED
SAME DAY (Wolf's ruling): the 2026-07-13 palette change was an agent's
casual color edit, not a sanctioned rebrand — Wolf ordered the original
palette restored (real apply of thm_drlurie_default, publish `2f88ef6`,
released 10:35:46Z). The theme IS the live palette again and the site seed's
brandTokens match production again — the PALETTE follow-ups are CLOSED,
and `site-seed-data.mjs`was RESYNCED to the live "Skincare" branding
2026-07-15 via`scripts/sync-site-seed.mjs`(a drift-guard test in
site-seed.test.ts keeps seed === production) — the site family is safe to
reconcile again. NEW DIRECTION (Wolf,
pending build): palette changes via themes ONLY (close the direct
brandTokens patch path); theme creation restrictable to a maker agent;
optional human-approval pin per type already exists in approval-policy.`tpl_fieldtest` (fieldtest family) still lacks the trio — patching it 422s
until backfilled or retired.

**Recipe self-description + reuse-first (W8.3b, 2026-07-14).** Every recipe
(template / section_template / theme) must carry `description`, `whenToUse`,
and `scope` (`evergreen` = standing/strategic, `one_off` = single-project) to
PUBLISH — drafts warn. `object_inventory` serves these as one-line `recipe`
summaries on every recipe row, so **REUSE FIRST is the documented default**:
one cheap inventory call answers "what recipes exist and which fits" before
any body fetch; a new recipe is created only when none fits. Each of the 19
section types also carries an `editor.useWhen` one-liner (served via
`object_contract.section_types` / `registry_get`). Creation can be restricted
per type via the committed `src/config/creation-policy.ts` (humans always;
agent allowlists; currently fully open — agent names are self-declared until
OQ-3, so treat as coordination, not security).

---

## MVP TODO objects

What still has to become a real object for Dr. Lurié to function as a full CMS —
i.e. for an agent (or a human via the admin UI) to edit **every meaningful part**
of the live site through the one governed workflow. Roughly in priority order.

### 1. Remaining hand-coded pages → page objects 🟢 CONVERTED (W5, credentialed run 2026-07-13)

The last three hand-coded route files are DELETED; all three pages are
store-backed page objects served by the object-page catch-all. Built per
[`design-principles.md`](design-principles.md) from three NEW REUSABLE section
types (`steps`, `content_split`, `pricing_table`) + existing generics — no
bespoke per-page types (`feature_grid` deliberately not minted: `content_grid`
`cards` already covers icon grids). The credentialed `--production --release`
run drilled every permitted op, published, and released all three (store ===
export; `object_inventory` returns them). **This empties the hand-coded-page
backlog for good — every routable page on the site now renders from a page
object.** (The three MOCK products the pricing tiers reference stay at
`approval_required` — see §6; the pages render from the already-committed
product exports regardless.)

| Object              | Route                     | Status / composition                                                                                                                                                                              |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page_pricing`      | `/pricing`                | 🟢 CONVERTED — lede + `pricing_table` (tiers REFERENCE the three products; price/availability/CTA resolve from commerce data at build) + `steps` + faq + cta_banner. MOCK copy (Wolf 2026-07-12). |
| `page_services`     | `/services`               | 🟢 CONVERTED — lede + `content_split` + `content_grid` cards (icon grid) + cta_banner. MOCK copy (Wolf 2026-07-12).                                                                               |
| `page_shop_preview` | `/solutions/shop-preview` | 🟢 CONVERTED — REAL copy verbatim as one `content_split` (the bespoke shop-hero + scoped styles generalized into the component). Nav route-kind links unchanged.                                  |

### 2. Real `site` object 🟢 CONVERTED (W4, credentialed run 2026-07-11)

`site_drlurie` is store-backed in production and the layout renders from it
(see "Singletons & templates" above): brand tokens, logo text, chrome toggles,
metadata defaults, and default navigation are agent-editable via
`set_site_fields`; urls/blog are carried in the object while config.yaml stays
authoritative for routing (Wolf B2, 2026-07-11).

### 3. Real `taxonomy` object 🟢 CONVERTED (2026-07-11)

**Wolf decided: curated agent-editable vocabulary** (not a read-only mirror, not
a full article-pipeline cutover). `tax_drlurie` converted via the credentialed
run, and **step 2 SHIPPED 2026-07-11** (see "Singletons & templates" above):
the bounded enforcement hook + the one-time normalization pass + registry
display labels — full §5.5 is live for articles. The full
content_item→ObjectRecord conversion remains deferred as its own wave (OQ-8) —
deliberately NOT a taxonomy prerequisite.

### 4. System pages → page objects 🔵 DONE, in review (PR #380)

`page_privacy`, `page_terms`, `page_404` are built (see the Pages table) via the
process now written down in [`conversion-playbook.md`](conversion-playbook.md).
The `content_item` resolver gap from this batch is CLOSED (2026-07-11, trap 4):
manual grid curation validates against committed content and is agent-usable. The `content_grid` `static`
variant was retired 2026-07-10 (schema + seed script; the sanctioned `cards`
source replaced it — playbook trap 9 is closed).

### 5. Listing pages 🟢 CONVERTED (W6, 2026-07-12)

The `listing` and `content_detail` PageTypes are **defined law** (all five
PageTypeIds implemented), the listing loaders are formalized, the six page
objects shipped with a byte-identical cutover, and Wolf's credentialed run
the same day converted all six (see "Listing & article surfaces" above) —
the biggest remaining MVP chunk is closed.

### Shop surfaces (S2, BUILT + SEEDED 2026-07-12 — awaiting credentialed run)

Three MOCK products (Wolf's mockup-data directive) + the two shop page
objects. Rendering: `/shop` is served by the object-page catch-all from
`page_shop` (the FIRST zero-code catch-all page); `/shop/<slug>` is the
SinglePost-shaped loader (`src/pages/shop/[slug].astro`) deriving paths from
published + available product exports, with the buy box/hero from the product
object, `presentation.page_ref` sections via ObjectSections, SEO defaults from
`page_product_detail`, and product_viewed/checkout_started beacons. The
`product_preview` type was upgraded to the M-8 source union (query/manual/
cards) over product objects — mode decides the price badge. Seeds:
`scripts/lib/pages-shop-seed-data.mjs`; local rehearsal all-green (every op
drilled incl. `set_product_fields`, contract 1/1 + 6/6, inventory 5/5,
exports materialized). **Production-run wrinkle (new): products are
review-required — the driver stops at `approval_required` by design; Wolf
approves each product in /admin/objects, then the publish re-runs.**

| Object                      | Serves                       | Status    | Notes                                                                                         |
| ---------------------------- | ------------------------------ | --------- | ----------------------------------------------------------------------------------------------- |
| `prod_barrier_repair_guide` | `/shop/barrier-repair-guide` | 🟣 SEEDED | MOCK fixed $19 download; placeholder stripe_test linkage + artifact ref (replace pre-launch). |
| `prod_starter_checklist`    | `/shop/starter-checklist`    | 🟣 SEEDED | MOCK free lead magnet; claim path lands with S3 (buy box shows Coming soon).                  |
| `prod_support_the_work`     | `/shop/support-the-work`     | 🟣 SEEDED | MOCK PWYW tip, fulfillment `none`; session path lands with S3.                                |
| `page_shop`                 | `/shop`                      | 🟣 SEEDED | `standard`; lede + `query` product grid — new products appear with zero page edits.           |
| `page_product_detail`       | every `/shop/<slug>` page    | 🟣 SEEDED | `content_detail` SEO defaults (the page_article idiom); zero sections + drillProbe.           |

### 6. Shop module (products + commerce) — S1 + S2 + S3 BUILT (2026-07-12): the §9 critical path is complete

The plan is [`06-shop-module-plan.md`](06-shop-module-plan.md) (Stripe-only v1,
digital goods). **S1a is done**: the `product` object type is live end-to-end in
the sandbox — `product.v1` body schema (fulfillment discriminated union),
`prod_` ids, the `set_product_fields` patch op (with the §3 canonicality funnel:
price cache + Stripe linkage refuse agent patches), the product validation
criteria (slug shape/uniqueness via the live `isSlugTaken` resolver, mode↔fields
coherence, publish-gated Stripe linkage, artifact trust, `commerce_price_sync`
backstop), the materializer (`src/data/site/products/{id}.json`),
`object_contract('product')`, and the **review-required approval flip** (§0.4).
Stripe env keys are pre-marked in the deploy-safety scanner (§8.5). **S1b is
done too** (same day): the `commerce` (orders, strong consistency) and
`commerce-events` (append-only, immutable) blob stores, the
`commerce_order.v1` record lib (`writeOrderIfAbsent` — the webhook idempotency
mechanism; raw email lives only here; only token HASHES are stored), the
`commerce_event.v1` event lib (8 types, PII-minimized `sha256:` actor hashes),
and the public `save-commerce-event` sendBeacon endpoint (client-authored
types only — authoritative events cannot be forged). **S1c is done too**
(same day): `create-checkout-session` (store-gated buyability, charges the
linked `price_id` — never the cache, §3), the signature-verified idempotent
`stripe-webhook` (replay-safe orders AND deterministic-key events),
`get-purchase` token-gated delivery (HMAC expiring tokens, 72h), and the
`/shop/thank-you` success page polling `checkout-session-status` (§8.8) —
the official `stripe` SDK is the one new dependency. The §9 exit test ran in
sandbox form (webhook replayed twice → one order, no duplicate events); the
LIVE Stripe test-mode run needs keys (STRIPE_MODE + both key pairs +
PURCHASE_TOKEN_SECRET, all deploy-scanner-marked) and is a launch-gate item.
**S3 is done too** (same day): PWYW checkout (the session function enforces
the minimum, §3), the free-claim path (direct token issuance + opt-in
tie-in), unlock checkout/fulfillment (pre-generated artifact named at
session creation), and the two MCP tools — `product_set_price` (Stripe
Price create/archive + one governed `set_product_price` patch; publish
stays human-gated) and `order_reissue` (regenerates links from the order
record alone; orders now store `fulfillment.artifact_ref`). **Criterion 4
is closed for the product type** (contract 2/2 ops drilled). **W5 (same
day) shipped the after-S3 page conversions** (see §1 above) plus the
`commerce_orders` MCP tool (netlify/lib/commerce-admin.ts) — read-only
order list/detail by email/product/order_key, the support-lookup half of
store administration that makes `order_reissue` operable from "customer
lost the email". W5 also fixed a latent S2 bug: the productObject
collection's entry ids were the product SLUG (Astro's glob loader prefers
a top-level `slug` field), so the buy box embedded a product_id the
checkout functions could never resolve — `generateId` now pins ids to the
filename (= object id). **The credentialed `--production --release` run
happened 2026-07-13: the three W5 PAGES are published + released +
store-backed → CONVERTED (§1).** The three MOCK products stopped at
`approval_required` as designed — they flip to converted once Wolf
approves each in /admin/objects and re-runs the same command (idempotent).
Remaining launch gate: the LIVE Stripe exit test (needs keys).

### Articles as objects (W7.3 + W7.8 + W7.9 + corpus, 🟢 CONVERTED 2026-07-13)

`content_item` is the ninth governed type: the annotated-node article model
(per-block strategy/intent — the behavioral framework — plus the envelope
judge/score substrate), the six node ops with exact inverses, `create_variant`
(+ `object_create_variant` MCP tool with `dry_run`), validation (taxonomy
slugs, one slug space with the committed posts, renderable rich-text grammar,
the reader-projection leak scan), the materializer →
`src/data/site/articles/`, and the render path: published article objects
join `fetchPosts()` as first-class posts (listings/tags/RSS included) with
per-node canvas chips (pencil + node-scoped Ask-AI) riding the standard
EditSession → `update_node` → publish/release path. **CONVERTED 2026-07-13:
the credentialed run happened the same day, executed op-by-op over the
session MCP connection** — `req_agent_object_model_demo_20260713_01` created
in the production store, all six node ops drilled in one batch ending
byte-identical (history carries the exact-inverse captures), validate clean
(slug unique across the 83 committed posts), `create_variant` dry-run proven
(node ids re-minted, claims re-pointed, lineage set, nothing persisted),
published (export commit `60cd213`,
`src/data/site/articles/req_agent_object_model_demo_20260713_01.json`),
released (deploy `6a54cf0d…` ready 11:42:57Z). The demo article is LIVE at
/object-model-demo — 173 pages, node wrappers + canvas identity verified in
dist, zero strategy-vocabulary leaks, listed in library + RSS. All five
conversion criteria hold for the type. Found + fixed by the run: the seed's
taxonomy terms (`skin-science` category / `skincare-education` tag) don't
exist in the production registry — the seed now carries
`reflections`/`reflections` (the article_taxonomy check is registry-gated, so
local rehearsals can't catch this class). Note: unpublish is still
unsupported (OQ-2) — the demo stays live until edited.

**Corpus LIVE (2026-07-13, credentialed run; not in the converted-object
ledger):** after the legacy
wipe (all 83 `src/data/post/*.md` deleted — the `post` collection is now
permanently empty), a **ten-article corpus** was seeded
(`scripts/lib/articles-corpus-seed-data.mjs`, two per registry category) and
run through `create → publish → release` over the session MCP connection. All
ten `req_agent_*_20260713_01` articles (skin_barrier_basics, reactive_skin,
minimal_routine, reading_labels, skin_after_40, retinoids_after_40,
niacinamide, sunscreen, ten_step_myth, not_self_worth) are real production-store
records (`object_inventory` returns them, `unpublished_changes:false`),
published, and released — one build (deploy ready, 2026-07-13T19:42Z). Creates
were run **strictly sequentially** — parallel `object_create` overwhelmed the
MCP gateway. `page_article` (`content_detail`) gained a `content_grid`
`s_related` (`source:{kind:"related",algorithm:"tag_similarity"}`, limit 3,
columns 3, "More to read") at position 0, so every article renders a selectable
related-tile block. The demo (`req_agent_object_model_demo_20260713_01`) stays
LIVE at `/object-model-demo` as the annotation showcase — enriched 2026-07-19
by the artifact-pipeline drill: two new nodes (`n_demoartifacts`, a
pdf-tool-generated `/img/` webp image with caption; `n_demoworksheet`, an
action CTA to a pdf-tool-generated `/pdf/` worksheet), generated under a
storage grant, `verify_agent_artifact` 5/5, published (commit `3cea365`),
released, and verified live (`verify_article_images` verified:true
deployReady:true; the PDF URL serves 200 from production).

### 7. Object tracking & analytics (W13) — 🟢 CONVERTED (T13.11/T20.3 credentialed production drive, 2026-09-01)

The 2026-07-19 directive, code-complete through T13.10 and driven to
production 2026-09-01: tracking as an attribute of every object + the
`tracking_config` singleton (`trk_drlurie`).

🟢 **`tracking_config` is CONVERTED (T13.11/T20.3, credentialed production
drive 2026-09-01, drlurie)** — all five criteria: renders (loader + own
adapter present in live production HTML, all pixels absent per the
all-disabled baseline), store-backed (`object_inventory` returns
`trk_drlurie` in production), round-trips (`set_tracking_config_fields`
set → verify → inverse-restore proven against production, plus the
`set_tracking` op proven set→verify→inverse on 9 of the ten other governed
types via MCP — `section_template` and `editorial_voice` hit transient
`object_list`/patch 502s and were left untouched, not converted-and-broken;
re-verify those two separately), contract-complete
(`object_contract('tracking_config')` advertised ≡ exercised), recorded
(this row + the conversion-map mark + the state-of-play drive entry, same
change). The own first-party event pipeline (the loader riding the
`data-cms-*` identity attributes → `/api/t` relay → `tracking_event.v1` →
owner sink per the `tracking-sink-reference/` kit; Blobs mirror + replay
script) + the consent runtime/banner (geo-adaptive per OQ-W13-1; GPC
absolute, id-upgrade block and `_dlid` lifecycle pinned by
`tests/netlify/consent-runtime.test.ts`, 24/24 green) + all six ad adapters
behind config flags (disabled in-repo; GTM permanently OUT) + the
goal→conversion bridge + CSP Report-Only with the hosts-drift gate are all
live in production. Seed `scripts/lib/tracking-config-seed-data.mjs` (T13.10).
**Honest caveats, not rounded up:** the live stats delta under-counted
(scroll_depth/nav_click/cta_click did not increment on the drive run,
`section_impression` has never fired at all — consistent with the measured
25.8% capture rate vs. server-side Netlify Analytics); `dims` `producer` and
`node_strategy` are still 0 pending content that carries producer metadata;
the money join (commerce_event ↔ tracking) is NOT YET EXERCISABLE — no
product object or `buy_click` element exists on `/shop/` today. None of
these block the five conversion criteria, but none are silently claimed
clean either — full table in the 2026-09-01 state-of-play entry. **CSP
promotion (was T21.4) is a deliberate non-goal of this drive** — see that
same state-of-play entry for why (no `report-uri`/`report-to`, so the
Report-Only soak collected no data; the Netlify Identity widget script also
needs an allowlist entry before enforcing). Plan:
[`12-object-tracking-and-analytics.md`](12-object-tracking-and-analytics.md).

### Not on the MVP path (noted so they aren't mistaken for gaps)

- **Legacy committed posts (src/data/post/\*.md)** — WIPED (Wolf 2026-07-13):
  all 83 smoke-test `.md` deleted, the `post` collection is permanently empty
  (`.gitkeep` holds the glob base; a benign Astro "empty collection" warning).
  Every article is now a `content_item` object.
- **`/object-showcase` (`page_object_showcase`)** — a QA/dev surface, not real
  content: 21 sections covering every placeable section type, populated with
  throwaway data, one below another, so each block can be hovered and
  canvas-tested for bugs. `seo.robots.index:false`, deliberately unwired from
  nav. Store-backed + released, but not part of the site IA — do not treat its
  presence as a content gap.
- **Real `template` objects** — ACTIVATED + CONVERTED at W2.5 (see "Singletons &
  templates"): three starter recipes store-backed in production + the instantiate
  tool live. Agents can create and evolve more freely.
- **`homes/mobile-app`, `homes/personal`, `homes/startup`** — Astrowind starter-theme
  demo pages, not real Dr. Lurié content. Candidates for deletion, not for cutover.
- **`rss.xml`, `search.json`** — generated endpoints, not editable content.

---

## Boundaries & standing caveats

- **Rendered ≠ published-in-store.** Every LIVE page object's derived export
  (`src/data/site/pages/*.json`) is committed and the route renders from it at build
  time. That is not the same as the record existing in the **production blob store**
  (what the object verbs edit). The store is proven working end-to-end (the
  2026-07-08 field-test round published one of every type, since cleaned up), and
  `nav_header` is confirmed store-published — but the migrated content pages were
  seeded as committed exports, so confirm a given page via `object_inventory` before
  assuming an agent can `object_patch` it in the store.
- **The field-test objects were deleted (PR #378).** The throwaway `page_fieldtest`,
  `sec_fieldtest`, `tpl_fieldtest`, and `site`/`taxonomy` stubs proved the pipeline
  end-to-end, then were removed. One remnant remains: `nav_header` still carries a
  field-test description at store `record_version 52` — restore it store-side
  (`object_patch` + publish), not by editing the export.
- **Two sources of truth still live outside the object model:** `src/config.yaml`
  (site config) and article frontmatter (taxonomy). Until TODO #2 and #3 land, edits
  to those do **not** flow through the object workflow.

---

## Why only nav is converted — the roadmap blocker (root-cause analysis, 2026-07-10)

The goal is agents editing objects on every page via MCP. We are far from it, and
here is the honest why:

1. **"Converted" was defined as "renders," so half-done work looked finished.** Every
   page "cutover" produced a committed export that Astro renders and stopped there.
   The editability half — a real store record an agent can round-trip — was labelled
   a "deferred handoff" and **never executed**. The playbook now forbids this: see
   its definition of done.
2. **The store-seed + publish step needs production credentials no working session
   has had.** `object_publish`'s real path commits via the GitHub Git-Data API and
   requires `GITHUB_CONTENT_TOKEN` + `GITHUB_REPOSITORY` (and the MCP write path needs
   `PUBLISH_SECRET`). Every conversion session ran in a sandbox without them, so the
   real seed could only be _rehearsed_ against a local file-backed store, never
   completed against production. That is the single biggest reason only nav is real:
   **nav_header/nav_footer/nav_footer_home were published in an earlier, credentialed
   phase; nothing since was.**
3. **The MCP tool/action surface is incomplete for "full manipulation."** Concrete
   gaps found 2026-07-10:
   - **No lifecycle removal verb** — 14 object tools exist, none can archive/delete or
     unpublish an object (`object_publish` rejects `null`). So the field-test junk
     records can't be removed, and "delete a page" is impossible via MCP.
   - **No nested-block patch ops** — `upsert_block`/`move_block`/etc. from
     [`block-tree.md`](block-tree.md) were designed but never built; only flat
     section ops (`upsert_section`, `update_section_data`, …) exist. Fine while
     sections stay flat; a hard blocker the moment nesting is real.
   - ~~**`content_item` reference resolution is stubbed** — so a `content_grid` `manual`
     source can't validate against real articles (playbook trap 4).~~ **CLOSED
     2026-07-11**: the validation context resolves content_item ids against
     committed content (`netlify/lib/content-item-index.ts`); manual curation
     is agent-usable.
4. **No standing round-trip verification.** ~~Nothing repeatably proves an object is
   agent-editable; the one-off driver scripts were thrown away each session.~~
   **Closed for the home family 2026-07-10:** `scripts/home-conversion-roundtrip.mjs`
   is the standing driver — ensure/heal each record, exercise EVERY permitted op,
   validate, publish, contract- and inventory-check, in `--local` (rehearsal) and
   `--production` (real conversion) modes. Extend the same pattern to other
   families as they convert.

**What "finishing the roadmap" therefore requires (the honest remaining work):** a
credentialed publishing path (or a documented human-run step) to seed each object
into the production store; the missing MCP verbs (archive/unpublish) and, when
nesting lands, the block ops; the `content_item` resolver; and a standing test that
drives create→patch→publish→render per object as the enforceable "converted" gate.
Until those exist, a "convert this page" task cannot actually be completed — say so
rather than shipping a rendered stub.

_Last audited: 2026-07-12, `claude/w6-cms-conversion-lus2d7` (W6 listing
surfaces CONVERTED: PRs #408/#409 merged + Wolf's credentialed
`--production --release` run all-green same day — six objects store-backed,
round-tripped, published, `released:true`; 37 objects converted total).
Prior: 2026-07-10 evening, `claude/home-page-conversion-state-6wsc2r`
(home-page family CONVERTED)._

## Editorial requests (W19, 2026-08-23)

Not a governed content object — a per-site **record store**, deliberately
outside the object substrate for the same reason Marginalia is: it is written
by a background sweeper many times a minute and must never take an object's
edit lock.

| Thing | Where | Notes |
|---|---|---|
| `editorial-request.v1` | blob store `editorial-requests`, `requests/by-id/<request_id>.json` | One doc per editorial job. `request_id` is the `req_<flow>_<topic>_<yyyymmdd>_<nn>` Platform mints — also the eventual `content_item` id and the artifact request id, so it is the correlation key for the whole job. |
| `RequestIndex` | `requests/index.json` | The single blob every admin tab polls. Projected from the docs; `rebuildIndex` regenerates it at any time. |
| `NotifyState` | `requests/notify/<person>.json` | Per person: mute list, the `last_notified` dedup map, and the e-mail preference. |

Only the sweeper writes a running request's status. Archive and cancel have
their own writers; there is no general-purpose save.
