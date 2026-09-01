# Conversion Map — every actual and potential object, as a tree

> **What this is (Wolf, 2026-07-10):** the complete object universe of the
> Dr-Lurié Astro project — every object that exists, every surface that still
> needs to become one, and every _potential_ object that can be composed from
> others. One node per object: its **attributes**, what it **depends on**, what
> **depends on it**, its **status**, and a **PROPOSED conversion priority**.
> This document exists for Wolf to set **boundaries, relationships, and
> priority** — the priority column is a proposal; edit it, and agents follow
> the edited order.
>
> Status marks match [`object-inventory.md`](object-inventory.md):
> 🟢 CONVERTED (all five playbook criteria) · 🟣 RENDERS (export only — a
> rendered stub) · 🔴 TODO (no object at all) · 🔵 optional ·
> ⚪ potential (does not exist; composable from other objects) · ⛔ never an
> object.
>
> Machine truth for full field schemas is `object_contract('<type>')` — the
> attribute lists here are the human summary, not the schema.
> **How to convert any node:** [`conversion-playbook.md`](conversion-playbook.md)
> (the driver-centric recipe). Record results in `object-inventory.md` +
> `state-of-play.md`, and keep THIS tree's status marks current in the same
> change.

## The tree

```text
site_drlurie ─ SITE SINGLETON ─ 🟢 CONVERTED (W4, credentialed run 2026-07-11; export commit a20f107)
│   the root everything hangs off; seed scripts/lib/site-seed-data.mjs → export src/data/site/site.json
│   brandTokens match production again since Wolf's ordered palette restore (2026-07-15,
│     publish 2f88ef6) — the 2026-07-13 agent color edit was unsanctioned and is undone
│   seed RESYNCED to production 2026-07-15 (name/logo/metadataDefaults now match the live
│     "Skincare" branding) via scripts/sync-site-seed.mjs; a site-seed drift-guard test keeps
│     seed === export — the site family is safe to reconcile again
│   LIVE from the object (pre-conversion literals as fallback when the export is absent):
│     brandTokens (every CustomStyles custom property, light + dark:` keys) · logo.text ·
│     chrome{showRssFeed, showThemeToggle} · metadataDefaults (title template, description,
│     ogImage, twitter handle, og site_name) · defaultNavigation{header, footer} (D§5.4:
│     the ONLY place default menus bind)
│   CARRIED but config.yaml stays authoritative for routing (Wolf B2, 2026-07-11): urls ·
│     blog{listPath, postsPerPage, categoryBase, tagBase} — permalink wiring is a later cutover
│   NOT in the object (still config.yaml/code): i18n · ui.theme · analytics ·
│     googleSiteVerificationId · trailingSlash; chrome.announcement deferred (Wolf B3)
│   dependents: EVERY page (Layout/Metadata.astro), rss.xml, sitemap, robots directives
│
├── CHROME — navigation objects (type: navigation)
│   ├── nav_header ─ 🟢 CONVERTED
│   │     attributes: brand · groups[] > items[] (menu, depth ≤ 2) · actions[] (CTA budget 3, warn-only)
│   │     depends on: target refs → pages (page-kind must be published) / routes / listing
│   │     dependents: every page's header
│   ├── nav_footer ─ 🟢 CONVERTED — default footer; dependents: every page without an override
│   ├── nav_footer_home ─ 🟢 CONVERTED — dependents: page_home via navigationOverrides.footer
│   └── ⚪ announcement ─ potential ─ priority W-later
│         Announcement.astro widget exists in the codebase but is not rendered anywhere today.
│         If revived: a small site-level object (message, link, on/off) — never hardcode it.
│
├── PAGES — type: page (route + seo + navigationOverrides + ordered sections[])
│   page attributes (all pages): route · pageType · title · seo{title, description, ogImage,
│     robots} · navigationOverrides{header?, footer?} · template(provenance) · sections[]
│   page depends on: every shared_ref target section · navigationOverrides nav objects ·
│     (via content_grid/content_embed sections) the content_item pipeline
│   NEW pages are fully agentic (2026-07-11): the object-page catch-all serves any
│     published Page object at its route with zero code (file routes/article
│     permalinks/blog·topics·admin prefixes excluded, skips warned at build)
│   │
│   ├── page_home ─ / ─ 🟢 CONVERTED (2026-07-10, all five criteria)
│   │   ├── s_hero ─ hero (inline) ─ kicker · heading · body(rich) · actions[LinkAction]
│   │   ├── s_audience ─ shared_ref → sec_home_audience_grid 🟢
│   │   ├── s_startgrid ─ shared_ref → sec_home_start_grid 🟢
│   │   ├── s_bio ─ bio (inline) ─ kicker · heading · body · trustNotes[] · disclaimer ·
│   │   │     portraitAssetRef (unused → MEDIA) · anchor
│   │   └── s_newsletter ─ shared_ref → sec_newsletter_signup 🟢
│   │
│   ├── LEDE FAMILY ─ 5 interior pages ─ 🟢 CONVERTED (W1, batched run 2026-07-11)
│   │   │   (scripts/lib/pages-interior-seed-data.mjs; store-backed, round-tripped, published,
│   │   │   released). page_newsletter is a plain lede (shared newsletter section optional later).
│   │   ├── page_start_here ─ /start-here ─ [lede]
│   │   ├── page_member_updates ─ /member-updates ─ [lede]
│   │   ├── page_newsletter ─ /newsletter ─ [lede]   (candidate: + shared_ref → sec_newsletter_signup)
│   │   ├── page_free_guide ─ /guides/free-guide ─ [lede]
│   │   └── page_early_access ─ /solutions/early-access ─ [lede]
│   │         lede attributes: kicker · heading · body(rich) · actions[] · anchor
│   │
│   ├── SYSTEM PAGES ─ 🟢 CONVERTED (W1, batched run 2026-07-11) (same combined batch +
│   │   │   driver run as the lede family; store-backed, round-tripped, published, released)
│   │   ├── page_privacy ─ /privacy ─ [prose]   prose: body (p/h2/h3/ul/ol allowlist)
│   │   ├── page_terms ─ /terms ─ [prose]
│   │   └── page_404 ─ /404 ─ [cta_banner]   cta_banner: heading · body · actions[]
│   │
│   ├── page_about ─ /about ─ 🟢 CONVERTED (2026-07-10) ─ decomposed off the bespoke `about`
│   │   │   anti-pattern into 8 standalone shared sections of REUSABLE types (the design-
│   │   │   principles win); a `standard` page of 8 shared_refs. Store-backed, round-tripped
│   │   │   in production, published, released. (The bespoke `about` TYPE was retired 2026-07-10.)
│   │   ├── s_intro ─ shared_ref → sec_about_intro 🟢 ─ bio (heading + copy + portrait photo)
│   │   ├── s_thinking ─ shared_ref → sec_about_thinking 🟢 ─ prose
│   │   ├── s_products ─ shared_ref → sec_about_products 🟢 ─ prose
│   │   ├── s_science ─ shared_ref → sec_about_science 🟢 ─ prose (list)
│   │   ├── s_research ─ shared_ref → sec_about_research 🟢 ─ prose (list)
│   │   ├── s_blog ─ shared_ref → sec_about_blog 🟢 ─ prose (list)
│   │   ├── s_note ─ shared_ref → sec_about_note 🟢 ─ prose
│   │   └── s_cta ─ shared_ref → sec_about_cta 🟢 ─ cta_banner (heading + body + actions)
│   │
│   ├── FORM PAGES ─ 🟢 CONVERTED (W2, batched run 2026-07-11) — store-backed, published, released.
│   │   │   All three bespoke per-page section types are now retired: the palette is
│   │   │   fully generic (design-principles rule 1 satisfied).
│   │   ├── page_contact ─ /contact ─ decomposed into 3 inline GENERIC sections:
│   │   │     lede{kicker,heading} · contact_form{formName,heading,subtitle,description,
│   │   │       disclaimer} (the fixed name/email/message field set is furniture) ·
│   │   │       content_grid{cards[{icon,title,description}]} ("How we can help", icons
│   │   │       added to the card cell). Bespoke `contact` type RETIRED. Scoped rule-4
│   │   │       visual diff on /contact; local round-trip proven.
│   │   └── page_thank_you ─ /thank-you ─ one `form_confirmation` section (the `thank_you`
│   │         type RENAMED to the reusable post-submit type; ?form= swap script unchanged).
│   │         eyebrow · heading · message · formMessages[{form,heading,message}] · actions[].
│   │         Renders byte-identically; local round-trip proven. Depended on by form redirects.
│   │
│   ├── HAND-CODED PAGES ─ 🟢 CONVERTED (W5, credentialed run 2026-07-13; route files DELETED,
│   │   │   catch-all-served; store-backed, round-tripped, published, released) ─
│   │   │   seeds: scripts/lib/pages-w5-seed-data.mjs
│   │   ├── page_pricing ─ /pricing ─ lede + pricing_table (tiers REFERENCE the 3 products;
│   │   │     price/availability/CTA resolve from commerce data at build) + steps + faq +
│   │   │     cta_banner. MOCK copy (Wolf 2026-07-12).
│   │   ├── page_services ─ /services ─ lede + content_split + content_grid `cards`
│   │   │     (feature_grid NOT minted — cards already covers icon grids) + cta_banner.
│   │   │     MOCK copy (Wolf 2026-07-12).
│   │   └── page_shop_preview ─ /solutions/shop-preview ─ REAL copy verbatim as ONE
│   │         content_split (bespoke hero + scoped <style> generalized INTO the component —
│   │         no equivalence gate needed; nav route-kind links unchanged, post-launch
│   │         repoints to /shop with one op)
│   │
│   ├── LISTING SURFACES ─ 🟢 CONVERTED (W6, credentialed run 2026-07-12; export
│   │   │   commits 7956b13…b0f8d90, released:true, store === seed === export) ─
│   │   │   pageType 'listing'/'content_detail' are DEFINED law: the page objects own
│   │   │   headings/copy/SEO (first lede = the header block; extra sections render
│   │   │   after the list via the registry), the query machinery stays the audited
│   │   │   build-time derivation. Per-term surfaces are ONE object per route family
│   │   │   with `%term%` pattern copy interpolated at build.
│   │   │   Seeds: scripts/lib/pages-listing-seed-data.mjs · byte-identical cutover.
│   │   ├── page_library ─ /learn/library ─ 🟢 [lede] ─ the blog index + pagination
│   │   ├── page_category ─ /category/[category] ─ 🟢 [lede "%term%"] ─ per-category listing
│   │   ├── page_tag ─ /tag/[tag] ─ 🟢 [lede "Tag: %term%"] ─ per-tag listing
│   │   ├── page_article ─ /%slug% ─ 🟢 content_detail ─ SEO defaults for EVERY article +
│   │   │     optional sections below the post (publishes with ZERO sections —
│   │   │     minVisibleSections 0; the SinglePost furniture is untouched)
│   │   ├── page_topics_index ─ /learn/topics ─ 🟢 [lede] ─ topic cards stay computed
│   │   │     from category frontmatter (D§5.5 — no Topic entity)
│   │   └── page_topic_detail ─ /learn/topics/[topic] ─ 🟢 [lede "%term%"]
│   │
│   ├── DEMO PAGES ─ ⛔ not conversion targets — deletion candidates
│   │     /homes/mobile-app · /homes/personal · /homes/startup (Astrowind starter demos)
│   └── ADMIN SURFACES ─ ⛔ never objects ─ /admin/** (tooling that EDITS objects)
│
├── SHARED SECTIONS — type: section (standalone single-instance wrapper; reused via shared_ref)
│   ├── sec_newsletter_signup ─ 🟢 CONVERTED ─ newsletter_signup: kicker · heading · body ·
│   │     formName('newsletter' → Netlify form) · consentText · anchor
│   │     dependents: page_home (candidate: page_newsletter, any future landing page)
│   ├── sec_home_audience_grid ─ 🟢 CONVERTED ─ content_grid · cards source (curated text cells)
│   ├── sec_home_start_grid ─ 🟢 CONVERTED ─ content_grid · query source ─ depends on:
│   │     content_item pipeline (published posts feed the cards)
│   └── ⚪ future shared sections ─ any section worth "edit once, changes everywhere"
│         (e.g. a sec_cta_free_guide reused across interior pages)
│
├── SECTION-TYPE PALETTE — code registry (one schema + component + editor hints per type);
│   │   NOT store objects themselves — the vocabulary pages/sections are composed FROM.
│   │   Adding a ⚪ type is code work (one union member + one registry module + one component).
│   ├── reusable, exist: hero · lede · prose · checklist(now unused on home; keep or retire) ·
│   │     content_grid(query|manual|cards; cards cells now take an optional `icon` —
│   │       covers the "how we can help" feature-grid shape) · card(leaf; block-tree later) ·
│   │     bio(now with optional URL `portrait` — the reusable "person intro", used on home + about) ·
│   │     newsletter_signup · testimonial · cta_banner · faq · link_list · product_preview ·
│   │     contact_form(now with optional subtitle/description) · form_confirmation(the reusable
│   │       post-submit type, ex-`thank_you`) · search · content_embed
│   ├── bespoke single-use types: NONE — the palette is fully generic as of 2026-07-11
│   │     (`about` retired 2026-07-10; `contact` retired + `thank_you`→`form_confirmation` 2026-07-11)
│   ├── wrapper: shared_ref (pointer, never rendered itself)
│   └── W5 types MINTED 2026-07-12 (all reusable, agent-configurable):
│         pricing_table (tiers[] referencing product objects — money data resolved at
│           build, never typed into sections) · steps (ordered icon step cells) ·
│         content_split (kicker/heading/rich body + actions + ≤2 staggered images) ·
│         feature_grid NOT minted — content_grid `cards` already covers it ·
│         (maybe) brand_row / stats if those widgets ever go live
│
├── TAXONOMY ─ singleton (tax_drlurie) ─ 🟢 CONVERTED (W3, credentialed run 2026-07-11)
│     kinds: category (a.k.a. topic) · tag; term: term_id · slug · label · description? ·
│       status(active|deprecated) · merged_into?
│     DECISION (Wolf, 2026-07-11): curated agent-editable vocabulary — 5 categories +
│       26 tags distilled from the 93 posts' drifted frontmatter (Wolf approved the
│       canonical list + raw→canonical mapping; scripts/lib/taxonomy-seed-data.mjs).
│       Registry = source of truth for OBJECT-SIDE consumers from day one (the store
│       validation context wires resolveTaxonomyTerm automatically, so content_grid
│       query terms validate live). STEP 2 SHIPPED 2026-07-11: the bounded
│       publish-article hook resolves article terms against this registry (slug +
│       merged_into aliases; unresolvable → 422 TAXONOMY_TERMS_UNRESOLVED; canonical
│       slugs materialized into frontmatter; skips gracefully when no registry), all
│       93 posts normalized via RAW_TO_CANONICAL, and the blog renderer displays term
│       labels from the registry. Full content_item→ObjectRecord conversion stays
│       deferred as its own wave (OQ-8) — explicitly NOT a taxonomy prerequisite.
│     CONVERTED by the credentialed run 2026-07-11: store-backed, all 5 term ops
│       round-tripped in production, published, released (export commit 627fa8d;
│       store === seed === export). resolveTaxonomyTerm is live — content_grid
│       query terms now validate against the real registry.
│     dependents: content_grid queries · listing pages · learn/topics · rss categories
│
├── CONTENT_ITEM (articles) ─ type: content_item ─ 🟢 CONVERTED (W7.3+W7.8 built; W7.9
│     credentialed run 2026-07-13 via the session MCP connection: create → 6/6 node ops drilled
│     byte-identical → validate → create_variant dry-run → publish 60cd213 → released, deploy
│     ready — the demo article req_agent_object_model_demo_20260713_01 is LIVE at
│     /object-model-demo with per-node canvas chips; seed taxonomy fixed to registry terms).
│     CORPUS 2026-07-13: the 83 COMMITTED .md posts were WIPED (Wolf: mostly junk, rewrite not
│       migrate) + a 10-article content_item corpus (req_agent_*_20260713_01, 2 per registry
│       category) was created → published → released in one build; page_article gained a
│       related content_grid ("More to read", tag_similarity). All articles are now objects.
│     NEW articles are objects (W7.4/W7.6 waived; see [`08-articles-plan.md`](08-articles-plan.md) §0.5)
│     attributes: slug · title · deck? · description? · author? (T9.23a, ≤120 chars, free-text byline —
│       renders as "By <author>" when set, no byline otherwise) · image? · taxonomy{category?,tags[]} ·
│       seo · nodes[] (the ANNOTATED node list — every block carries private.strategy hook/agitation/…/
│       resolution + intent, plus commercial/rendering/chat/visibility; public.body = plain text |
│       rich_text.v1) · envelope judge/score substrate: claims/sources/compliance/emotional_strategy/
│       scores[]/lineage. Legacy .md frontmatter (title/slug/excerpt/category/tags/…) unchanged.
│     ops: set_article_meta · upsert/update/move/remove_node · set_node_visibility (exact inverses) +
│       create_variant verb (A/B substrate). Materializes → src/data/site/articles/{req_id}.json,
│       joins fetchPosts() as first-class posts; per-node canvas chips (W7.8).
│     dependents: content_grid (query/manual) · content_embed · listings · rss.xml ·
│       search.json · related posts
│     ✅ enabler CLOSED (2026-07-11): the content_item resolver validates manual grid
│       picks against committed content (trap 4); render skips+warns on temporal drift.
│       Manual article curation in content_grid is agent-usable NOW.
│
├── TEMPLATES ─ type: template ─ 🟢 CONVERTED (W2.5, batched run 2026-07-11)
│     machinery LIVE end-to-end: template.v1 schema (name · appliesTo[pageTypes] ·
│       slots[{slotId, allowed[], required, repeatable, blueprint}]) · 4 patch ops ·
│       validation · materializer · the `object_instantiate_template` MCP tool
│       (instantiate verb: deep-copy slot blueprints → new page body via the standard
│       create path; required slot without blueprint → registry defaultData of its
│       first allowed type; stamps page.template provenance; dry_run previews without
│       persisting)
│     ├── tpl_interior ─ standard ─ lede + prose + optional cta (the W1 interior shape)
│     ├── tpl_landing  ─ standard ─ hero + curated card grid + cta (campaign shape)
│     └── tpl_legal    ─ system   ─ one required blueprint-less prose slot (exercises
│           the defaultData fallback)
│     seeds: scripts/lib/templates-seed-data.mjs · store-backed in production (all 4 ops
│       round-tripped + instantiate dry_run per recipe) · published · released 2026-07-11
│     boundary: recipes only — creation-time copy, never live-binding; PageType registry
│       stays the enforced law; behavior stays in generic components
│     🟢 W8.2 (SHIPPED): slots gain optional `blueprintRef`
│       → a section_template, dereferenced + deep-copied at instantiation only
│
├── 🟢 SECTION TEMPLATES ─ type: section_template ─ CONVERTED (W8.4 run 2026-07-14; verb proofs 2026-07-15 —
│     [`09-template-system-plan.md`](09-template-system-plan.md) §2–§3): the section-level
│     recipe — {name · description · whenToUse · scope · blueprint: ONE pre-configured
│     sectionInstance}; ops set_section_template_meta · replace_blueprint ·
│     update_blueprint_data (all round-tripped in production);
│     `object_instantiate_section_template` stamps the blueprint into a page (one
│     upsert_section under the caller's lock) or mints a standalone sec_* object;
│     blueprint must be a standalone-placeable type (no card leaf, no shared_ref);
│     stamp verb PROVEN in production 2026-07-15: dry_run BOTH modes × EACH record
│     (10/10 eligible, zero blockers)
│   ├── 🟢 stpl_hero_landing ─ hero (the page_home s_hero shape)
│   ├── 🟢 stpl_audience_grid ─ content_grid `cards` (the sec_home_audience_grid shape)
│   ├── 🟢 stpl_related_articles ─ content_grid `related`/tag_similarity (the page_article shape)
│   ├── 🟢 stpl_newsletter_cta ─ newsletter_signup (the sec_newsletter_signup shape)
│   └── 🟢 stpl_cta_banner ─ cta_banner (the W1/about closing-CTA shape)
│
├── 🟢 THEMES ─ type: theme ─ CONVERTED (W8.4 run 2026-07-14; verb proofs 2026-07-15 —
│     [`09-template-system-plan.md`](09-template-system-plan.md) §6): preset for
│     site.brandTokens — {name · description · whenToUse · scope · tokens};
│     op set_theme_fields (round-tripped in production); `site_apply_theme` computes ONE
│     exact-replace set_site_fields op (stale keys unset) under the caller's site checkout.
│     NOT taxonomy: nothing resolves against a theme; the site never live-inherits — apply
│     copies values. apply_theme PROVEN in production 2026-07-15 (dry_run + one real
│     apply end-to-end; a second real apply the same day executed Wolf's ordered restore
│     of the original palette — publish 2f88ef6, released). NEW RULE pending build (Wolf
│     2026-07-15): palette changes via THEMES ONLY — direct set_site_fields on brandTokens
│     to be closed; theme creation restrictable per agent; human-approval pin optional.
│   └── 🟢 thm_drlurie_default ─ the canonical palette (live again since the 2026-07-15 restore)
│
├── MEDIA / ARTIFACTS ─ artifact store (images, PDFs) ─ 🔵 pipeline exists (upload/trust);
│     refs consumed by: bio.portraitAssetRef · about.portrait · product cards · article images
│     gap: trusted-artifact resolver on the RENDER path (embedded-asset-block later)
│
├── FORMS (Netlify forms: 'newsletter', contact) ─ ⚪ potential form object (formName +
│     field definitions); today form shape lives inside newsletter_signup /
│     contact_form section data — sufficient for MVP; a standalone form object only if
│     forms multiply
│
└── DERIVED ENDPOINTS ─ ⛔ never objects — re-generated from the above at build:
      rss.xml · search.json · sitemap-index.xml · robots.txt
```

## Potential objects composable from existing objects (no new code, or nearly none)

| ⚪ Potential object               | Composed of                                                                  | Unlocked by                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Topics hub as a page object       | page + one `content_grid` (query source, per category)                       | W3 taxonomy (or now, with hardcoded category slugs)                                                 |
| Any campaign/landing page         | page + hero + content_grid + cta_banner + shared newsletter section          | nothing — possible TODAY, and **served live automatically** (the object-page catch-all, 2026-07-11) |
| Newsletter page with live signup  | page_newsletter + `shared_ref → sec_newsletter_signup`                       | W1                                                                                                  |
| Curated "start here" grid         | sec_home_start_grid switched `query → manual + fallback`                     | nothing — possible TODAY (resolver closed 2026-07-11)                                               |
| Related-content strip on any page | `content_grid` (query by tag/category) placed via `upsert_section`           | W3 taxonomy for term filters                                                                        |
| Shared CTA reused across pages    | new section object (cta_banner) + `shared_ref` from N pages                  | nothing — TODAY                                                                                     |
| Article with embedded objects     | content_item body as Rich Text with `embedded-entry-block → section objects` | W7 (rich text)                                                                                      |

## PROPOSED conversion order (Wolf: edit this table — it is the queue)

| Wave       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Why this order                                                                                                                                                                   | Size |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| W1         | ✅ CONVERTED (batched run 2026-07-11): Lede family (5 pages) + system pages (3 pages) — store-backed, published, released                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Everything but the store record already exists; pure driver work, proves the factory                                                                                             | S    |
| W1-enabler | ✅ DONE (2026-07-11): `content_item` resolver — manual grid curation validates against committed content; render skips+warns on drift                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Unblocks manual curation everywhere; small and high-leverage                                                                                                                     | S    |
| W2         | ✅ CONVERTED (batched run 2026-07-11): /contact → lede + contact_form + content_grid(icons); /thank-you → form_confirmation. Last bespoke types (`contact` retired, `thank_you`→`form_confirmation`) gone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Rendered stubs today; the last bespoke types retire with them                                                                                                                    | S-M  |
| W2.5       | ✅ CONVERTED (batched run 2026-07-11): `object_instantiate_template` verb + 3 starter recipes, store-backed in production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Machinery is built and dormant; makes new specialty pages a zero-code agent action                                                                                               | M    |
| W3         | ✅ DONE (credentialed run + step 2, 2026-07-11): tax_drlurie converted; publish-article enforcement hook + 93-post frontmatter normalization + registry display labels shipped — full §5.5 live for articles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Unlocks term-filtered grids, listings, topics hub                                                                                                                                | M    |
| W4         | ✅ CONVERTED (credentialed run 2026-07-11): site_drlurie store-backed; brandTokens/logo/chrome/metadataDefaults/defaultNavigation render from the object; urls/blog carried (config.yaml authoritative for routing per B2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Makes global config agent-editable; removes config.yaml as a second source of truth                                                                                              | M    |
| W5         | RE-GROUNDED in the shop module (2026-07-12 — see [`06-shop-module-plan.md`](06-shop-module-plan.md)): /pricing renders pricing_table tiers FROM product objects; shop-preview → content_split; /services + product content use MOCKUP data (Wolf, 2026-07-12 — supersedes the copy-or-delete wait). The ⚪ types mint after S1–S3 of the shop build. **S1+S2+S3 DONE 2026-07-12 (the full §9 critical path)**: `product` is the eighth object type (S1a), commerce/event stores + checkout→webhook→token delivery live (S1b/c, PRs #411–#413), /shop + /shop/[slug] render from 3 MOCK products + page_shop (first catch-all-served page) + page_product_detail. **W5 pages CONVERTED (credentialed run 2026-07-13)**: pricing_table/steps/content_split minted; /pricing, /services, /solutions/shop-preview are store-backed + published + released page objects, route files deleted; `commerce_orders` admin tool live. The 3 MOCK products stay at approval_required (review-required gate) — Wolf approves in /admin/objects to flip them too                                                                                                                                                                                                                                     | New reusable section types (pricing_table, steps, content_split) — DONE 2026-07-12                                                                                               | M-L  |
| W6         | ✅ CONVERTED (credentialed run 2026-07-12): listing/content_detail PageTypes defined; 6 page objects (library, topics ×2, category, tag, article) store-backed, round-tripped, published, released — byte-identical cutover held                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Biggest chunk; formalizes listing loaders; connects pages ↔ articles                                                                                                            | L    |
| W7         | PLANNED (2026-07-12 — see [`08-articles-plan.md`](08-articles-plan.md); Wolf resolved OQ-8: **one-time migration**, adapter retired): `content_item` becomes the ninth object type (keeps `req_*` ids; artifact trust unchanged); node envelope (strategy/intent/commercial — the DTC semantic layer, preserved by directive) stays the spine, `public.body` upgrades to `rich_text.v1` (Contentful model, substrate built in-wave incl. section bodies); one renderer for build/admin/canvas; `create_variant` + scores as the A/B substrate; ~31 tool names become aliases over object verbs; per-article cutover + DOM-equivalence harness over the 83 posts; canvas-for-articles as the final phase. Phases W7.1–W7.9, each its own session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Wolf's 2026-07-12 rulings supersede "post-MVP"; the §3.10 freeze lifts only inside approved phases                                                                               | XL   |
| W8         | CONVERTED (built W8.1–W8.3b + W8.4 credentialed run 2026-07-14; verb proofs 2026-07-15 — see [`09-template-system-plan.md`](09-template-system-plan.md)): the **recipe family** completes rule 5 — `section_template` (5 starter recipes live) + page-template `blueprintRef` composition + `theme` (`thm_drlurie_default` live; applied by `site_apply_theme`, exact-replace semantics) — completing the TEN governed types (`objectTypes`, `src/schema/object-record-v1.ts`) + rule 6 (layout = bounded data fields, never CSS) + W8.3b recipe metadata / creation-policy seam / reuse-first surfacing. Leaf-section fix + token value safety on `site` folded in. Application verbs PROVEN in production 2026-07-15 (stamp dry_run both modes × each stpl; apply dry_run + one real apply — which exposed live-palette drift, reverted byte-exact; theme/site seeds now stale vs production, Wolf to rule). Composable "composite" sections remain SPEC-ONLY, gated on OQ-W8-1…4                                                                                                                                                                                                                                     | Completes the recipe side of rule 5; makes new sections + re-skins zero-code agent actions                                                                                       | M-L  |
| W10        | 🟡 IN PROGRESS (2026-07-20 — see [`11-platformization-plan.md`](11-platformization-plan.md) §1): T10.1+T10.2 MERGED to main (bounded layout/shape/type token axes — schema/render/apply/validate/contract, byte-identical defaults); T10.3 survey + T10.4 rulings RATIFIED (2026-07-19, recorded in `design-vocabulary-gaps.md` §7); T10.5+T10.6 BUILT on branch `claude/w10-mints-w13-consent`: the section union is now 26 members (`media` with folded-in video embeds, `brand_row`, `stats`, `timeline`, `comparison_table` — schema+registry+components+editor hints, build-diff EMPTY) plus the five ratified variant fields (hero.variant, cta_banner.compact, content_split.imageLayout, steps.columns, testimonial.layout+variant — all additive-optional, pre-variant shapes re-validate untouched); T10.7 memo committed (`composite-sections-decision.md`: OQ-W8-1 scored NOT cleanly cleared — composite stays GATED; four ANSWER lines await Wolf); T10.8 starter recipes: 4 new stpl seeds + `thm_editorial_airy` (first axis-carrying theme variant), roundtrip driver now drills section_template/theme seeds AND the W13 `set_tracking` op on every family. Remaining: T10.9 credentialed seed run (human gate)                                                                       | Design vocabulary: bounded visual range for multi-site theming (rule 6 — enum axes, code-owned mappings)                                                                         | M    |
| W13        | ✅ CONVERTED (T13.11/T20.3 credentialed production drive, 2026-09-01 — plan [`12-object-tracking-and-analytics.md`](12-object-tracking-and-analytics.md); OQ-W13-1…6 RULED): `tracking_config` (`trk_drlurie`) is store-backed in production, all five playbook criteria proven — renders (loader + own adapter live, all pixels absent per baseline), store-backed (`object_inventory`), round-trips (`set_tracking_config_fields` + the ten-type `set_tracking` op, 9/11 proven — `section_template`/`editorial_voice` hit transient 502s and were left untouched, not converted-and-broken), contract-complete, recorded (object-inventory.md + this row + the 2026-09-01 state-of-play entry, same change). The own first-party pipeline (loader → `/api/t` relay → `tracking_event.v1` → owner sink + Blobs mirror), the geo-adaptive consent runtime/banner (GPC absolute, 24/24 tests green), all six native adapters (disabled in-repo; GTM OUT), the goal→conversion bridge, and CSP Report-Only with the hosts-drift gate are all live. **Honest caveats carried, not rounded up:** the live stats delta under-counted (scroll_depth/nav_click/cta_click flat, `section_impression` never fired — consistent with the measured 25.8% capture rate), `dims` producer/node_strategy still 0, and the commerce_event↔tracking money join is NOT YET EXERCISABLE (no `buy_click` element live on `/shop/` yet) — full table in the 2026-09-01 state-of-play entry. **CSP promotion (was T21.4) is a deliberate non-goal** of this drive: the Report-Only header carries no `report-uri`/`report-to`, so the soak collected no violation data, and the Netlify Identity widget script needs an allowlist entry before enforcing is safe. | The 2026-07-19 directive: aggressive-but-legal continuous collection, object-aware and project-scoped — analytics enters the object model (supersedes the config.yaml exclusion) | L    |
| any        | Housekeeping: delete /homes/\* demos · retire `checklist` type (or keep as reusable) · archive/unpublish MCP verbs · announcement object if wanted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Independent, non-blocking                                                                                                                                                        | S    |

**Keep this file current:** whenever an object converts, flip its mark here AND
in `object-inventory.md` in the same change (same rule, two views: the
inventory is flat per-object bookkeeping; this map is the relationship truth).
