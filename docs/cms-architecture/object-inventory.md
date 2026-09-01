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
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 **CONVERTED** | Real content, renders live **and** an agent can fully manipulate it through the MCP (the playbook's 5 criteria all met). Nav + the home-page & /about families today.                                                                            |
| 🟣 **RENDERS**   | Builds and serves from a committed export, but has **no editable store record** — a rendered stub, not converted. Most "pages" are here.                                                                                                         |
| 🟡 **SHELL**     | Exists structurally (a record is published, or a route is scaffolded) but is a **placeholder, a test artifact, or not yet wired to drive the live site**. The real source of truth is still somewhere else. The note says which half is missing. |
| 🔴 **TODO**      | Needed for the CMS MVP. Not built yet.                                                                                                                                                                                                            |

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

---

## The object types (use & boundaries)

Each entry: **what it is for** · **boundaries** (what it does NOT do) · status.

### Pages

All are `page` objects: `route` + `pageType` + `title` + `seo` +
`navigationOverrides` + ordered `sections[]`.

