# 12 — Object Tracking & Analytics Plan (W13): tracking as an attribute of every object, project-scoped trackers, own-first pipeline

Status: **governing plan for W13** (drafted 2026-07-19, strategy session on
`claude/object-tracking-strategy-jh76f4`). Records the owner directive of
2026-07-19 (vreich) and the session's confirmed decisions. Companion briefs:
`cms-pipeline/T13.1`–`T13.13`; queue rows appended to `cms-pipeline/queue.tsv`.
Nothing in this wave is built yet — this doc + briefs are the deliverable of
the strategy session; W13's own open questions are tracked wave-locally here
(§13, the 06/08 convention) — **all six answered 2026-07-19, zero open**.

## 0. Directive, and the amendment it makes

**The directive (2026-07-19):** implement tracking as an **attribute of each
existing object**. All usual trackers: Google Ads and others; an **own
tracker** (the owner runs a DB that listens to triggers and stores events —
own development **preferred** over Plausible, which stays only as a fallback);
**native advertiser platforms** (Taboola/Outbrain/MGID class). Trackers must
account for **object type** and the **user activity collectable** per type.
The strategy is **legal but aggressive** continuous data collection. Trackers
are **project-dependent** — Dr. Lurie is one of several projects.

**Session decisions (vreich, 2026-07-19, confirmed):** (1) this session ships
strategy doc + briefs + queue rows only, no code; (2) own-tracker events reach
the owner DB through a **first-party relay** (same-origin path → Netlify
function → forward), not direct-to-endpoint and not blobs-only; (3) consent
posture is **geo-adaptive aggressive** (§8); (4) branch pushed, **no PR**
(house rule).

**The amendment.** Until now the docs deliberately kept analytics OUT of the
object model: 03-mapping §1.7-6 classed analytics scripts as "layout
infrastructure with no editorial content", 04-phased-plan L172 said no phase
touches them, and `object-inventory.md` records `analytics` as one of the
site-object fields that stays in config.yaml/code. **This directive
supersedes that exclusion.** Tracking enters the object model in two governed
places (§2, §3); the legacy `config.yaml analytics:` block and the inert
`Analytics.astro`/`SplitbeeAnalytics.astro` components are retired by T13.5.
Recorded here so a future wave doesn't "correct" tracking back out of the
model.

**What does NOT change:** the leak rule (private annotations never render);
the commerce event log (06-plan §6) stays the authoritative money record;
`admin-workflow-lock.ts` / `publish-article.ts` / legacy article tools stay
untouched; OQ-W7-2 (traffic-split serving) stays deferred.

## 1. Goals / non-goals

**Goals (v1 = W13):**

1. Every governed object carries an agent-editable `tracking` attribute
   (enable/label/tags/goals) — patchable via MCP, surfaced in the contract,
   round-tripping like any other body field.
2. A per-project **`tracking_config`** singleton (eleventh governed type,
   `trk_drlurie`) declares which trackers run, with what IDs, under which
   consent regime, and which activities are collected per object type.
3. An **own first-party tracker**: ≤4KB loader → batched beacons →
   `/api/t` relay function → validated `tracking_event.v1` → owner DB
   (Postgres reference kit with `pg_notify` triggers), Blobs mirror as
   replay buffer. Object-aware by construction (events carry
   object/section/node identity from the `data-cms-*` attributes already in
   production HTML).
4. Vetted **provider adapters**: google_ads (+optional ga4), meta_pixel,
   taboola, outbrain, mgid, plausible (dormant fallback slot). Conversions
   fire only from per-object `tracking.goals` declarations.
5. **Geo-adaptive consent**: own tracker cookieless and consent-free
   everywhere; advertising pixels auto-fire outside restricted regions,
   Consent-Mode-v2-gated inside; GPC honored.

**Non-goals (v1):** reader-facing events for `site`/`theme`/`template`/
`section_template` (agent-side usage is derivable from envelope `history[]`
— a future inventory report, zero client cost); web-vitals collection;
server-side conversion uploads (Google Ads API / Meta CAPI — seams recorded,
§7); a TCF-certified CMP (§8); traffic splitting / variant serving
(OQ-W7-2); reporting UI of any kind (the owner DB is the analysis surface);
GTM (**ruled OUT** — OQ-W13-3, 2026-07-19); scores-feedback
_implementation_ (the design is commissioned as T13.13; implementing it is
a later decision on that design).

## 2. The `tracking` attribute (all ten types)

New `src/schema/bodies/tracking-attribute-v1.ts` on the
`recipe-metadata-v1.ts` pattern — one shape, ten consumers, every field
schema-optional so **all pre-W13 records keep parsing** (the additive
guarantee). Spread `...trackingAttributeShape` into all ten body schemas.

```ts
export const GOAL_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/; // neutral slugs — these reach HTML
export const CONVERSION_LABEL_RE = /^[A-Za-z0-9_-]{4,64}$/; // provider conversion label/id

export const trackingGoalSchema = z.strictObject({
  goal: z.string().regex(GOAL_KEY_RE), // own-tracker goal key ('buy_click', 'opt_in', …)
  on: z
    .enum(['view', 'impression', 'cta_click', 'form_submit', 'buy_click', 'completion', 'outbound_click'])
    .optional(),
  provider_conversions: z
    .array(
      z.strictObject({
        provider: z.enum(['google_ads', 'ga4', 'meta_pixel', 'taboola', 'outbrain', 'mgid']),
        label: z.string().regex(CONVERSION_LABEL_RE),
        value_source: z.enum(['none', 'product_price']).optional(),
      })
    )
    .optional(),
});

export const trackingAttributeSchema = z.strictObject({
  enabled: z.boolean().optional(), // absent = inherit the per-type default from tracking_config
  label: z.string().max(120).optional(), // reporting name — NEVER rendered
  tags: z.array(z.string().max(48)).max(12).optional(), // reporting grouping — NEVER rendered
  goals: z.array(trackingGoalSchema).max(8).optional(),
});

export const trackingAttributeShape = { tracking: trackingAttributeSchema.optional() };
```

**One uniform patch op, `set_tracking`** — not per-type amendments, because
the existing grammar makes piggybacking impossible in three places:
`set_nav_meta` is a hand-pinned strict object, and `taxonomy` and `section`
have **no body-level fields op at all** (term ops / page-side section ops
only). One op keeps the contract story identical across all ten types:

```ts
const setTrackingSchema = z.strictObject({
  op: z.literal('set_tracking'),
  // Deep-merge into body.tracking (null-inside-fields unsets a key; arrays
  // replace wholesale — goals[] has no stale-key trap). Top-level null
  // removes body.tracking entirely, so the inverse of a first-set on a bare
  // object is exact. No prune machinery needed.
  fields: z.union([fieldsSchema, z.null()]),
  ...guard,
});
```

- Appended to **all ten** entries of `patchOpNamesByObjectType`
  (`src/schema/object-patch-ops.ts`). Agent-submittable (NOT privileged) —
  each type's normal publish gate still applies.
- **One-writer funnel** (the `set_site_brand_tokens` / `set_product_price`
  precedent, inverted): `forbidKeys(['tracking'], …)` added to the seven
  open fields ops (`set_page_meta`, `set_article_meta`, `set_site_fields`,
  `set_template_meta`, `set_section_template_meta`, `set_theme_fields`,
  `set_product_fields`) so exactly one op writes the attribute everywhere.
- **Inverse:** `set_tracking` with the captured before-tree of
  `body.tracking` (or `fields: null` when it was absent) — the existing
  fields-op inverse mechanics in `src/lib/object-patch-apply.ts` /
  `derivePatchInverse`, tests mirroring `set_theme_fields`.
- **Validation:** new `tracking_attribute` criterion in
  `netlify/lib/object-validate.ts` — regex conformance; warn-at-draft /
  block-at-publish when a goal's `on` activity is not collectable for that
  object type per the §6 matrix. Validation never reads `trk_drlurie`
  (store-independent); disabled providers are simply skipped at render.
- **Contract:** automatic once the op joins the union + allowlists; plus one
  `constraints` line per type stating the funnel and the goal-key
  neutrality rule.

**Leak boundary (explicit, tested):** `tracking.label` and `tracking.tags`
NEVER render — the renderer leak tests extend to grep built HTML for seeded
label/tag sentinels, exactly like strategy vocabulary. The only new rendered
attribute is **`data-cms-track="off"`** on section/node wrappers whose
object sets `enabled: false` (the loader's opt-out marker). Goal keys and
provider conversion labels DO reach the page (inside the loader's build-time
config JSON — the client has to fire them), which is exactly why
`GOAL_KEY_RE`/`CONVERSION_LABEL_RE` force neutral slugs: **strategy
vocabulary lives in `private.*` and `tracking.label/tags`; anything in
`goals` is public by construction.**

## 3. `tracking_config` — the eleventh governed type (`trk_drlurie`)

The per-project tracker registry: one singleton per site, named
`trk_<project>` (the `site_drlurie`/`tax_drlurie` convention),
`schema_version: 'tracking_config.v1'`. Follows the W8.3 theme type's
end-to-end file surface verbatim (enum entry in `object-record-v1.ts`, body
schema, patch op, ids + mint, validate, verbs/mcp, patch-apply, materialize +
materializer, content collection, contract, seeds, tests).

**Body (`src/schema/bodies/tracking-config-v1.ts`)** — three blocks:

- **`providers`** — a **fixed-key strict object** (not an array; plain
  deep-merge edits one provider without upsert ops): `own`, `ga4`, `gtm`,
  `google_ads`, `meta_pixel`, `taboola`, `outbrain`, `mgid`, `plausible`.
  Every block: `{ enabled: boolean, <typed id field>, consent_class:
'essential'|'analytics'|'advertising' }` with per-provider regex-pinned
  IDs — `AW-\d{6,12}` (google*ads.conversion_id), `G-[A-Z0-9]{4,14}`
  (ga4.measurement_id), `GTM-[A-Z0-9]{4,10}`, `\d{8,20}` (meta pixel_id),
  numeric account ids for the natives, bare-https origin for
  `plausible.api_host`. `own` additionally carries `ingest_path`
  (default `/api/t`), `endpoint_env` / `auth_env` (\*\*env-var NAMES matching
  `/^[A-Z]A-Z0-9*]{2,63}$/`, never values or URLs** — the CMS-Agent
house pattern), `sample_rate`(0–1),`batch { max_events ≤25,
  max_wait_ms }`, `blob_mirror: 'fallback'|'always'|'off'`. Refinements:
`enabled: true`requires the id field non-empty; env fields must not
contain`://`.
- **`consent`** — `{ posture: 'geo-adaptive'|'consent-first'|'us-first',
restricted_regions: ISO-3166-alpha-2[] (seed = EEA + UK + CH),
honor_gpc: boolean, banner: { headline ≤120, body ≤600, accept_label,
reject_label, manage_label? } }` — plain validated strings; the banner
  itself is a code component (§8).
- **`defaults`** — the per-object-type collection matrix (§6): which
  activities are collected for page / section / content_item / product /
  navigation / taxonomy, plus `outbound_links` and `utm_capture` booleans.
  A per-object `tracking.enabled` beats the type default.

**The safety law (the `checkBrandTokenValue` analogue).** Agents never
inject script text or URLs — they flip typed switches and supply
regex-validated IDs. All script text lives in code-owned adapter templates
(§4), which **re-assert the regex at render** before interpolating (the
write-AND-render double enforcement `theme-tokens.ts` established). No
free-URL field exists anywhere in the body.

**Machinery specifics:** id grammar `trk_[a-z0-9_]+` added to the ceiling +
per-type patterns in `src/lib/object-ids.ts` (+ mint self-check); patch op
`set_tracking_config_fields` (the `set_site_fields` idiom — open deep-merge,
no forbidKeys; inverse = captured before-tree); create refuses a second
active `tracking_config` (the site-singleton rule); materializer →
**`src/data/site/tracking.json`** (repo convention: singletons export to a
specific filename directly under `src/data/site/`, like `site.json` /
`taxonomy.json` — NOT a per-type directory); content collection
`trackingConfigObject` with a synchronous loader; publish criterion
`tracking_config_ready` (enabled providers have ids; banner copy present
whenever any advertising-class provider is enabled and posture ≠
`us-first`; `restricted_regions` non-empty under `geo-adaptive`).

**Governance (the blast-radius argument).** Publishing this object changes
which third-party scripts execute on every page — a strictly larger blast
radius than `brandTokens` (which is already funneled through a privileged
op). Posture: `src/config/creation-policy.ts` override
`tracking_config: { agents: [] }` (human/seed-minted only — agents edit,
they don't mint; the singleton rule for site/taxonomy), and
`src/config/approval-policy.ts` override `tracking_config:
'require-approval'` **plus the Tier-3 convention: a human executes the
publish**, like navigation/taxonomy/site. Both are the standing one-line
levers. OQ-W13-2 asks Wolf to ratify.

**RULED (vreich, 2026-07-19 — supersedes the recommendation above):**
publish ships **AUTONOMOUS** — no approval-policy override (the
`all-autonomous` master covers it); autonomy is config-driven ("auto if
configured in config"), and the posture gains an **owner-facing toggle in
the admin UI** (task T13.12, riding the T9.15 override-layer outcome).
The creation restriction STANDS (`{ agents: [] }` — humans/seeds mint,
agents edit). Flipping to require-approval stays a one-line lever (or the
toggle) whenever wanted.

## 4. Provider adapters & render integration

All code under `src/lib/tracking/` + `src/components/tracking/` — core
machinery in the doc-11 sense (fleet-propagates); the `trk_<client>` record

- Netlify env values are per-site data (never propagate).

* **`src/components/tracking/TrackingScripts.astro`** replaces the inert
  `Analytics.astro` mount in `src/layouts/Layout.astro` (the
  `config.yaml analytics:` block and `SplitbeeAnalytics.astro` retire with
  it — importers verified first, per the deletion gotcha). Behavior:
  **bails on `/admin`** (AdminLayout flows through Layout — mandatory,
  tested); renders NOTHING when no `tracking_config` export exists (zero
  build risk before the seed lands); otherwise assembles the build-time
  **loader config JSON** (`<script type="application/json" id="trk-config">`):
  project id (from the site export), enabled providers' typed IDs, consent
  block, defaults matrix, and the **goal map** `{object_id → goals[]}`
  aggregated from every collection's `tracking` field. No per-element goal
  attributes in HTML.
* **Emission order:** (1) inline consent bootstrap (§8) — always before any
  vendor tag; (2) own-tracker loader (§5); (3) adapters for enabled
  providers only.
* **Adapters** `src/lib/tracking/adapters/{own,ga4,gtm,google-ads,meta-pixel,taboola,outbrain,mgid,plausible}.ts`:
  pure `(providerConfig, consentPolicy) → { head: string, cspHosts: {script,
connect, img, frame} }`. Fixed, pre-minified snippet templates; only
  regex-revalidated IDs are interpolated (throw at build otherwise).
  `advertising`-class snippets emit as `<script type="text/plain"
data-trk-gate="advertising">` and are activated (cloned to real scripts)
  by the bootstrap on region-clear or consent grant.
* **Partytown: stays OFF in v1** (`hasExternalScripts=false` unchanged).
  Main-thread gtag is deliberate — Consent Mode v2 ordering and conversion
  accuracy are the whole point of the Google Ads adapter. Escape hatch
  recorded: if the native pixels degrade INP, flip `hasExternalScripts` and
  forward `dataLayer.push`/`_tfa.push` for those adapters only — its own
  decision later, not v1.
* **View Transitions discipline** (`<ClientRouter>` is live):
  **`astro:page-load` is the ONLY pageview trigger** (fires on first load
  AND every swap — the double-fire guard); `send_page_view: false` +
  manual page_view for gtag/ga4; plausible manual mode; the loader re-binds
  observers on `astro:page-load` and flushes + disconnects on
  `astro:before-swap`; all listeners registered once at module scope.
* **CSP (net-new):** `netlify.toml` gains a `[[headers]] for = "/*"` block —
  **`Content-Security-Policy-Report-Only` first** (T13.8), promoted to
  enforcing only after a clean soak (T13.11). Inline scripts + astro-compress
  force `script-src 'self' 'unsafe-inline'`; the real value is
  `connect-src`/`img-src`/`frame-src` pinning. The own relay is same-origin
  (`connect-src 'self'`). Each enabled adapter contributes its `cspHosts`;
  a repo test compares the union for the enabled set in
  `src/data/site/tracking.json` against `netlify.toml` and **fails on
  drift** — CSP updates ride the same change that enables a provider.
* **astro-compress:** adapter snippets ship pre-minified so build diffs stay
  stable; a dist test asserts `#trk-config` still parses as JSON
  post-compress and the loader asset stays within budget.

## 5. The own tracker (first-party pipeline — the centerpiece)

Owner preference: own development over Plausible. The `plausible` provider
slot exists but stays dormant; §11's parity checklist defines "own tracker
is enough".

### 5.1 Loader

`src/lib/tracking/loader/` — TS, bundled by Astro from a `TrackingScripts`
`<script>` (hashed `/_astro/*` asset: same-origin, generic name,
immutable-cached). **≤4KB min+gzip, hard ceiling 6KB, build-test-enforced.**
No dependencies. Collects (gated by the §6 matrix + per-object opt-outs +
`data-cms-track="off"`):

- **Pageviews** on `astro:page-load`; route + page object identity.
- **Impressions + dwell**: ONE `IntersectionObserver` (threshold 0.5) over
  `[data-cms-section-id]` and `[data-cms-node-id]` — the attributes ALREADY
  stamped by `section-annotations.ts`, `render-nodes.ts`, and
  `PageLayout.astro`. Impression once per element per pageview; dwell
  accumulates visible-ms, reported on flush.
- **Scroll depth**: max-bucket (25/50/75/90/100), once each.
- **Engagement time**: visibility-aware accumulator (visibilitychange +
  focus/blur), capped; reported on flush — no heartbeat (cost).
- **Clicks** (one delegated listener): nav (`[data-cms-nav-object]`),
  section CTAs (anchor/button inside `[data-cms-section-id]`), product
  buy_click, outbound (foreign hostname), tag/term links.
- **UTM + referrer**: first pageview of a session only; echoed onto later
  events server-side via the session hash, never re-sent.

**Identity — two modes:**

- **Default: cookieless, consent-free, ZERO device storage.** Visitor and
  session are computed **server-side at ingest**:
  `sha256(TRACKING_SALT + utc_date + ip + ua + project_id)` (daily-rotating
  visitor hash — the Plausible model) + a session hash on a 30-min window.
  No persistent identifier on the device → outside the ePrivacy
  storage-consent rule. This is what makes "aggressive" legal by default.
- **Consented upgrade:** after an analytics grant, mint `_dlid` (uuid,
  first-party, 13-month cap) — events then carry `visitor.vid`. GPC
  suppresses the upgrade even after a banner accept.

**Batching/transport:** in-memory queue; flush at `batch.max_events`
(default 20) or `max_wait_ms` (default 10s), and ALWAYS on `pagehide`,
`visibilitychange→hidden`, and `astro:before-swap` (VT navigations never
fire pagehide). `navigator.sendBeacon` with fetch-keepalive fallback — the
`NetlifyOptInCapture` / shop-beacon house precedent. `sample_rate` applies
to high-volume classes (impressions/dwell) — pageviews and goals always 1.0.

### 5.2 `tracking_event.v1`

`src/schema/tracking-event-v1.ts` (+ `tracking_batch.v1` wrapper, ≤25
events). **commerce_event.v1 rules apply verbatim:** append-only,
additive-only evolution (v2 only for breaking changes, dual-write during
transition), server-side authoritative / client-side best-effort lossy,
PII-minimized. Fields:

```
schema='tracking_event.v1' · event_id (uuid, idempotency key) ·
project_id (SERVER-stamped from env — client value ignored) · ts ·
event ∈ { pageview, section_impression, section_dwell, node_impression, node_dwell,
          scroll_depth, engagement, cta_click, nav_click, buy_click, outbound_click,
          form_start, form_submit, term_view, tag_click, read_progress, completion, goal } ·
url { path, route } ·
object { object_type, object_id, section_id, section_type, node_id, node_kind, term_id }
       (nullable; regex + isObjectIdForType re-validated at ingest) ·
props (ALLOWLISTED per event: depth_pct, dwell_ms, pct_read, href_host, goal,
       label_slug, value_cents, …) ·
visitor { mode: cookieless|consented, vid?, vhash, shash } (vhash/shash ingest-computed) ·
consent { analytics, ads, gpc } ·
context { referrer (session-first only), utm{source,medium,campaign,content,term},
          viewport{w,h}, lang, ua (server-stamped), geo{country,subdivision}
          (server-enriched; city dropped at ingest — OQ-W13-4 ruling) }
```

PII rules: no raw email ever; **raw IP is hashed into vhash and discarded**;
anon identifiers only; `props` is an allowlist, not a passthrough (the
`save-commerce-event` `sanitizeData` precedent).

### 5.3 Ingest relay (first-party)

- `netlify.toml` redirect: `from = "/api/t"` → `/.netlify/functions/track-ingest`
  (status 200, force) — same-origin, generic path (ad-blocker posture). New
  `netlify/functions/track-ingest.ts` + `netlify/lib/tracking-events.ts`
  (the `commerce-events.ts` sibling).
- **Validate:** parse regardless of content-type (sendBeacon quirk); batch
  ≤25 / body ≤64KB; per-event zod parse with **individual drop, never
  all-or-nothing**; object ids re-validated; `/admin` paths rejected.
- **Enrich:** geo from the Netlify function geo context (exact accessor
  pinned in T13.3), UA, server `project_id`, vhash/shash (daily
  `TRACKING_SALT`).
- **Forward:** POST NDJSON to `process.env[<own.endpoint_env>]` with
  `Authorization: Bearer env[<auth_env>]`, 2s timeout, no retries
  (fire-and-forget; at-most-once).
- **Blob mirror:** on sink absence/failure (or `blob_mirror:'always'`)
  append to a new **`tracking-events`** store, keys
  `events/<yyyy-mm-dd>/<ts>-<uuid>.json` (the commerce-events layout;
  `getTrackingEventsBlobStore` in `netlify/lib/blob-store.ts`). The mirror
  exists for **replay into the owner DB only** — never a reporting surface
  (house rule: no reporting on blob listing). Mirror retention: **90
  days** (OQ-W13-4 ruling) — recorded policy; enforcement is a future
  cleanup script, no schema field.
- **Abuse:** same-origin only (reject foreign `Origin`), instance-local
  token bucket, enum/regex gates, fast 202 always.
- **Region oracle:** `GET /api/t?mode=region` → `{country}` from the geo
  context (no storage; country only) — the §8 gate's data source; the first
  pageview beacon's response also carries it, so steady-state adds no extra
  invocation.

### 5.4 Owner-DB reference kit (endpoint-agnostic)

T13.9 delivers docs + SQL only (`docs/cms-architecture/tracking-sink-reference/`):
any HTTPS sink accepting `POST NDJSON + Bearer + 202` works. Reference:
Postgres `tracking_events` table (`event_id UNIQUE` for idempotent replay
from the mirror; `project_id/ts/event` + object columns; `jsonb`
props/context; btree indexes on `(project_id, ts)`, `(project_id,
object_id, ts)`, `(project_id, event, ts)` + gin on props) and an
`AFTER INSERT` trigger firing `pg_notify('tracking_events', …)` — the
owner's "DB listening to triggers", verbatim. Plus a blob-mirror replay
script honoring `event_id` idempotency.

**The strategy join lives in the owner DB, not in events.** Committed
exports (`src/data/site/articles/*.json`) carry per-node `private.strategy`
— exports round-trip private fields by design; rendered HTML is the leak
boundary. The owner DB ingests exports into a `node_strategy(project_id,
object_id, node_id, strategy, intent, …)` dimension; engagement-by-strategy
is a JOIN on `(object_id, node_id)`. **Events carry `node_id` only —
leak-safe by construction.** OQ-W13-5 ANSWERED (vreich, 2026-07-19): the
join is **BLESSED**, and the scores-feedback design (metrics-derived
`scores[]` entries) is **commissioned as T13.13, design-only** —
implementation remains a later decision on that design.

### 5.5 Ad-blocker posture (honest)

First-party origin + generic `/api/t` + hashed loader asset + no
third-party-cookie dependence defeats hostname-list blocking (what kills
GA/pixels). Stated limits: heuristic/strict blockers can still kill generic
beacon patterns; `/.netlify/functions/track-ingest` remains nameable (the
redirect hides, it doesn't remove); Safari caps a client-set `_dlid` at ~7
days (later mitigation: set it via a function response header). **Never
claim 100% capture** — the server-side commerce log (Stripe webhook) stays
the authoritative denominator for money events.

## 6. Object type × activity matrix (the `defaults` block)

| Type                                           | Collected (v1 defaults)                                                                                  | Notes                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **page**                                       | pageview, scroll_depth, engagement                                                                       | web-vitals deferred (loader budget)                                                                                                                                 |
| **section**                                    | impression, dwell, cta_click, form_start/form_submit                                                     | keyed off existing `data-cms-section-id`/`-type`; shared sections carry their `sec_*` id                                                                            |
| **content_item** (+nodes)                      | read_progress (pct of public nodes seen), node_impression, node_dwell, completion (last-node impression) | events carry node_id/kind ONLY; strategy joins in the owner DB (§5.4); shares optional later                                                                        |
| **product**                                    | buy_click (+ pageview via its page)                                                                      | `product_viewed`/`checkout_*` stay commerce events — **commerce_event = money truth, tracking_event = behavior truth**; no double-logging                           |
| **navigation**                                 | nav_click (header/footer, item href/label slug in props)                                                 | via `data-cms-nav-object`/`-nav-role`                                                                                                                               |
| **taxonomy**                                   | term_view (term routes → term_id), tag_click                                                             |                                                                                                                                                                     |
| **site / theme / template / section_template** | — (no reader events)                                                                                     | agent-side usage derivable from `history[]`; explicit non-goal. The attribute still parses on them (uniform schema); `label`/`tags` remain meaningful for reporting |

Per-object `tracking.enabled: false` beats the type default;
`tracking.goals[].on` binds a goal to one of these activities (validated
per type, §2).

## 7. Ad-platform conversions

- **google_ads:** `gtag('config','AW-…')` main-thread. Conversions resolve
  from the build-time goal map: `purchase` on the checkout success/thank-you
  surface (value from `value_source:'product_price'`, resolved at build from
  the product export — store-backed, no client guessing); `opt_in` bridged
  from `NetlifyOptInCapture` success via `document.dispatchEvent(new
CustomEvent('trk:goal', …))` (the loader consumes the same bridge);
  `contact_submit` from contact_form success. **Consent Mode v2:** defaults
  denied (`ad_storage`, `ad_user_data`, `ad_personalization`,
  `analytics_storage`) in restricted regions, `ads_data_redaction: true`,
  `url_passthrough: true`, update on grant. **Enhanced conversions OFF in
  v1** (needs a hashed-email pipeline; raw email exists only in order
  records by house rule). **Server-side conversion upload from
  `stripe-webhook` is the recorded later-seam** — the commerce event log
  already carries everything needed.
- **ga4** (optional, `analytics` class): `send_page_view:false`, manual
  page_view on `astro:page-load`; goals mirrored as events.
- **meta_pixel:** init + PageView; goal map → standard events
  (Purchase/Lead/Contact). CAPI later — `tracking_event.event_id` is
  designed to be the dedup key.
- **taboola / outbrain / mgid:** page pixel + event-based conversions from
  the same goal bridge; S2S APIs later. All `advertising` class → gated
  identically to google_ads.
- **The mapping rule:** a provider fires ONLY conversions declared in some
  object's `tracking.goals[].provider_conversions`. One bridge function in
  the loader: activity fires → goal-map match on `(object_id, on)` → emits
  the own `goal` event AND calls each enabled provider's conversion stub.

## 8. Consent — "legal but aggressive" (geo-adaptive, confirmed)

- **Own tracker:** cookieless mode everywhere, immediately, consent-free.
  The legal footing, stated precisely: **even first-party analytics
  cookies/persistent IDs generally require consent under ePrivacy/GDPR —
  which is why the default mode stores NOTHING on the device** (daily-hash
  identity, §5.1). No banner needed for it anywhere.
- **Advertising pixels:** auto-fire outside `restricted_regions` (seed: EEA
  - UK + CH). Inside: Consent Mode v2 defaults denied + the own lightweight
    banner; grant → consent update + gated-script activation + consented-id
    upgrade. **Unknown region = restricted** until the region oracle answers
    (~50–150ms once per session, then cached; the pageview beacon response
    carries it thereafter). A client `Intl` timezone heuristic may only KEEP
    pixels held, never release them.
- **GPC honored everywhere** (`honor_gpc: true`): treated as ad-consent
  refusal + no persistent-id upgrade, regardless of region or banner state.
- **The banner** (`src/components/tracking/ConsentBanner.astro`) is a CODE
  component — agents influence only the validated plain-string copy in
  `tracking_config.consent.banner`. Stores `{analytics, ads, ts, region}`
  in `_dlconsent` (localStorage); re-openable via a footer "privacy
  choices" link (an ordinary navigation-object edit, zero code).
- **Accuracy note (carried verbatim into agent-facing docs):** Google
  requires a certified CMP (TCF) for ad **personalization** in EEA/UK —
  plain conversion tracking with Consent Mode v2 (denied defaults +
  redaction) is the aggressive-but-legal middle. If Wolf later wants EEA/UK
  personalization/remarketing, that is a TCF-CMP adoption project, not a
  config flip; this banner is deliberately NOT a TCF CMP.
- **Fallback postures** (one enum flip on `trk_drlurie`): `consent-first`
  (banner gates everything except the cookieless own tracker… which needs
  no gate; effectively: no pixels before grant anywhere) and `us-first`
  (unknown = unrestricted; pixels fire immediately, suppressed only on
  confirmed-restricted region or GPC).

## 9. Multi-project (doc-11 alignment)

- **Code vs data, the platformization split:** adapters, loader, ingest,
  schemas, grammar = core machinery (fleet-propagates; future
  `packages/core`). The `trk_<client>` record, its env values
  (`TRACKING_SINK_URL`/`TOKEN`/`SALT`, per-tenant Netlify env), and every
  ID = per-site data (never propagates).
- **Every event carries a server-stamped `project_id`** — one owner DB
  serves all tenants, partitioned by it. Per-tenant sinks are equally valid
  (the endpoint is per-site env anyway).
- The `tracking_config` seed joins the T11.7 provisioning-CLI checklist:
  minting a new client mints its `trk_<client>` (pixels disabled, own
  tracker pointed at the owner sink).
- The Monetizer MCP's per-tenant affiliate tracking namespaces (subid
  prefixes) are a natural future JOIN dimension in the owner DB — noted,
  not a dependency; it stays outside the governed docs.
- **Sequencing note:** W13 briefs are written against today's single-repo
  tree. If W11 (core extraction) lands first, paths move mechanically to
  `packages/core` — whichever wave runs second rebases file paths, nothing
  conceptual changes. The queue comment carries the same note.

## 10. Cost & performance

- **Invocation math (recorded honestly):** at ~100k pageviews/mo with rich
  collection (~25–35 events/pv), batching at ~20/beacon ≈ **150k–250k
  function invocations/mo** — above the free Netlify function tier.
  Mitigations, in order: the batch+final-flush design (already the
  default), `sample_rate` on impressions/dwell (pageviews/goals stay 1.0),
  pruning the `defaults` matrix per type, and — future — moving ingest to
  an Edge Function (the repo has none today; deliberate later option, not
  v1). An invocation count joins the monthly review.
- **Page weight:** ≤4KB loader + config JSON (size scales with goal-bearing
  objects only, not all objects — the goal map includes only objects with
  goals/opt-outs) + consent bootstrap ≈ under 8KB added, before any pixel.
  Pixels cost what pixels cost — that's the §8 gate's job.
- **Rendering:** zero new per-element attributes beyond
  `data-cms-track="off"`; the observer rides existing `data-cms-*`.

## 11. Risk register

1. **Docs-exclusion regression** — the §0 amendment is the guard; inventory
   - conversion-map rows updated this session so no future wave "cleans up"
     tracking as scope creep.
2. **Script-injection blast radius** — typed regex IDs only; fixed adapter
   templates re-validated at render; require-approval + human-executed
   publish (OQ-W13-2); **GTM recommended permanently OUT** (an
   unreviewable third-party container contradicts the vetted-adapter law;
   any future enablement is its own Wolf decision — OQ-W13-3).
3. **Leak rule vs engagement×strategy** — events carry node_id only; the
   join uses exports inside the owner DB (§5.4); leak tests extended to
   `tracking.label/tags`; goal keys are public-by-design behind neutral-slug
   regexes.
4. **Static-site geo limits** — unknown=restricted costs pixels one round
   trip on session start; region is IP-country only; no per-region HTML
   variance exists or is claimed.
5. **Ad blockers** — §5.5; never report own-tracker numbers as total truth;
   commerce log is the money denominator.
6. **Netlify cost at volume** — §10 math + mitigations; monthly review.
7. **View-Transitions double-fire** — `astro:page-load` as the only
   pageview trigger; flush on `astro:before-swap` (pagehide never fires on
   VT swaps); module-scope listeners; `/admin` bail is mandatory and
   tested (admin flows through `Layout.astro`).
8. **astro-compress** — pre-minified snippets; dist tests for `#trk-config`
   JSON integrity + loader size budget.
9. **Plausible parity** (what "own is enough" means): unique visitors
   (daily hash), pageviews, top pages, sources/referrers, UTM breakdowns,
   goals/custom events, device/geo rollups — all present in
   `tracking_event.v1`. Deliberately NOT covered (matching the ethics that
   make consent-free legal): cross-site tracking, fingerprinting beyond the
   daily hash, raw-IP retention. If parity slips, enabling the `plausible`
   slot is a config flip, not a wave.

## 12. W13 task breakdown & queue integration

Briefs: `cms-pipeline/T13.1-…` through `T13.13-…`; queue rows appended
after W12 (reordering queue.tsv IS the scheduler; W13 may be pulled ahead
of W10–W12 freely — see the §9 sequencing note on W11). Every task: `npm
run check` + `npm test` green, `build-diff` EMPTY vs pre-task main (until
the wave's deliberate render change lands in T13.5, which must itself be
byte-identical while no `tracking_config` export exists), one commit, no PR
unless asked.

| ID     | Scope                                                                                                                                                                                                                                                                                                                                | mode                                | depends_on   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------ |
| T13.1  | `tracking` attribute: shape file, spread ×10 bodies, `set_tracking` op + inverse + forbidKeys ×7, `tracking_attribute` criterion, contract lines, leak tests                                                                                                                                                                         | auto                                | —            |
| T13.2  | `tracking_config` type end-to-end (theme-pattern file surface → `src/data/site/tracking.json`; policies; singleton rule)                                                                                                                                                                                                             | auto                                | T13.1        |
| T13.3  | `tracking_event.v1`/batch schemas, `tracking-events` lib + blob store, `track-ingest` function (validate/enrich/forward/mirror), `/api/t` redirect, region oracle, abuse guards                                                                                                                                                      | auto                                | T13.2        |
| T13.4  | Own loader client (observers off `data-cms-*`, batching, VT-safe lifecycle, identity modes, size budget)                                                                                                                                                                                                                             | auto                                | T13.3        |
| T13.5  | `TrackingScripts.astro` (Layout swap, `/admin` bail, config+goal-map assembly) + `own`/`plausible` adapters + consent bootstrap skeleton; retire `Analytics.astro`/`SplitbeeAnalytics.astro`/config.yaml analytics                                                                                                                   | auto                                | T13.4        |
| T13.6  | `ConsentBanner` + geo-adaptive gating + GPC + Consent Mode v2 defaults                                                                                                                                                                                                                                                               | auto (OQ-W13-1 answered 2026-07-19) | T13.5        |
| T13.7  | `google_ads` + `ga4` adapters + goal→conversion bridge (purchase/opt_in/contact_submit)                                                                                                                                                                                                                                              | auto (OQ-W13-3 answered 2026-07-19) | T13.6        |
| T13.8  | `meta_pixel`/`taboola`/`outbrain`/`mgid` adapters; CSP Report-Only block + hosts-drift test + dist integrity tests                                                                                                                                                                                                                   | auto                                | T13.7        |
| T13.9  | Owner-DB reference kit (DDL + NOTIFY trigger + NDJSON receiver contract + mirror replay script — docs/SQL only)                                                                                                                                                                                                                      | auto                                | T13.3        |
| T13.10 | Seeds (`tracking-config-seed-data.mjs`) + roundtrip drill/reconcile: `set_tracking` on ALL ten types + the trk singleton; inventory/map/state-of-play records same change                                                                                                                                                            | auto                                | T13.2        |
| T13.11 | **Credentialed production drive**: env vars set; human-executed publish of `trk_drlurie`; release; live beacons verified at sink/mirror; the five converted-criteria proven for `tracking_config` AND a `set_tracking` round-trip on one object of each of the ten types via MCP; CSP promoted from Report-Only if the soak is clean | **human_gate**                      | T13.6–T13.10 |
| T13.12 | Admin governance toggle for tracking (owner-only posture surface; rides the T9.15 override-layer outcome) — OQ-W13-2 ruling                                                                                                                                                                                                          | auto                                | T13.2        |
| T13.13 | Scores-feedback design (metrics-derived `scores[]` — design-only; §15 appendix deliverable) — OQ-W13-5 ruling                                                                                                                                                                                                                        | auto                                | T13.3        |

**Schema-vintage trap applies to T13.11:** every schema/grammar change must
be merged and deployed to main before the credentialed run (playbook trap 12).

## 13. Open questions — ALL ANSWERED 2026-07-19 (OQ-W13, wave-local per the 06/08 convention)

Rulings taken interactively by vreich, 2026-07-19 (session C). Original
question text kept for history; each ruling is GOVERNING for W13.

- **OQ-W13-1 — Consent posture ratification — RATIFIED AS SEEDED
  (vreich, 2026-07-19):** posture `geo-adaptive`; `restricted_regions` =
  **EEA-30 (EU-27 + IS/LI/NO) + UK + CH**; geo granularity =
  **country + subdivision, city dropped at ingest** (also under OQ-W13-4);
  GPC honored globally; unknown region = hold pixels until the oracle
  answers. → T13.6 UNBLOCKED (queue row flipped to auto).
  _(Asked: geo-adaptive as seeded? regions list? city vs country?)_
- **OQ-W13-2 — tracking_config governance — ANSWERED, SUPERSEDES THE
  RECOMMENDATION (vreich, 2026-07-19):** publish autonomy is
  **config-driven — "auto if configured in config"** — and the committed
  config **ships AUTONOMOUS** (NO approval-policy override; the
  `all-autonomous` master covers it; flip to require-approval remains a
  one-line lever any time). Creation restriction STANDS: humans/seeds
  mint, agents edit (`creation-policy` override `{ agents: [] }`). NEW
  SCOPE: the posture must be surfaced as an **owner toggle in the admin
  UI** → task **T13.12** (rides the T9.15 override-layer outcome).
  _(Asked: ratify require-approval + Tier-3 human-executed publish? —
  declined in favor of config-driven autonomy + UI surfacing.)_
- **OQ-W13-3 — Provider set v1 — RATIFIED (vreich, 2026-07-19):** the
  FULL adapter set ships in v1 — google_ads, ga4, meta_pixel, taboola,
  outbrain, mgid — all disabled until flipped in `trk_drlurie`;
  `plausible` stays a dormant fallback slot; **GTM is permanently OUT**
  (an unreviewable script container contradicts the vetted-adapter law;
  any future enablement is its own Wolf decision). → T13.7 UNBLOCKED
  (queue row flipped to auto).
- **OQ-W13-4 — Retention/PII policy — RATIFIED, RECOMMENDED BUNDLE
  (vreich, 2026-07-19):** blob-mirror retention **90 days** (recorded
  policy; enforcement = a future cleanup script — no schema field);
  **no sampling at launch** (`sample_rate` stays 1.0 everywhere; the
  lever is reserved for when volume costs bite); geo **country +
  subdivision only, city dropped at ingest**; **GPC honored, legacy DNT
  ignored**.
- **OQ-W13-5 — The strategy join — BLESS BOTH (vreich, 2026-07-19):**
  (a) engagement×`private.strategy` joins in the owner DB from committed
  exports are **BLESSED** as leak-rule-compatible (events carry `node_id`
  only; rendered HTML stays the leak boundary); (b) the scores-feedback
  design — how metrics-derived `scores[]`/`scored_by` entries would work
  — is **COMMISSIONED as T13.13 (design-only)**; implementation remains a
  later decision on that design's evidence.
- **OQ-W13-6 — Own-sink contract — ANSWERED (vreich, 2026-07-19):**
  vreich provisions `TRACKING_SINK_URL` / `TRACKING_SINK_TOKEN` /
  `TRACKING_SALT` (per-tenant Netlify env) **before the T13.11 drive**;
  `tracking_event.v1` evolves **additive-only, v2 = dual-write** (the
  commerce_event.v1 rule); the Postgres + `pg_notify` reference kit
  stands as designed.

## 14. Verification & the five criteria

- **Build gates per task:** `npm run check`, `npm test`, `npm run build`,
  `build-diff` EMPTY (T13.5's swap must be byte-identical while no
  tracking_config export exists — the component renders nothing without
  one; that IS the gate).
- **New standing tests the wave adds:** leak-grep for label/tags sentinels;
  loader size budget; `#trk-config` dist JSON integrity; CSP hosts-drift;
  ingest validation (drop-not-fail, origin, limits); patch/inverse drills
  for `set_tracking` (×10) and `set_tracking_config_fields`.
- **The five criteria applied to W13** (playbook law — proven at T13.11):
  1. **Renders** — the loader + enabled adapters emit from the
     `tracking.json` export through the four gates.
  2. **Store-backed** — `trk_drlurie` is a production store record
     (`object_inventory` returns it), not a committed stub.
  3. **Round-trips** — every permitted action drilled via MCP: checkout →
     `set_tracking_config_fields` (+ inverse) → publish → release; PLUS
     `set_tracking` round-tripped on one object of each of the ten types.
  4. **Contract-complete** — `set_tracking` appears in all ten contracts,
     `tracking_config` has its own full contract, and every action is
     backed by the real MCP tools.
  5. **Recorded** — inventory row, conversion-map mark, state-of-play
     entry, same change.
- **Live-pipeline proof (beyond the five):** a real browser session on
  production emits pageview/impression/click beacons; events observed at
  the owner sink (or mirror) with correct object identity, project_id,
  vhash rotation, and consent flags; a restricted-region simulation shows
  pixels held + Consent Mode denied defaults; GPC suppression verified.

## 15. Scores-feedback design (T13.13, commissioned by OQ-W13-5 — DESIGN ONLY, nothing implemented)

**Status: a proposal awaiting Wolf's ruling.** Today `scores[]`
(`body.revision_control.scores[]`, §2.4 of the 08 plan) is exclusively
agent-authored judgment against the strategy annotations. This section
designs the next step — tracking metrics authoring score entries — without
changing anything until ruled on. Implementation is NOT commissioned by
this section existing.

### 15.1 Provenance — a metric score is distinguishable forever

A metric-derived entry uses the SAME `contentItemScoreSchema` shape (no
schema fork) with a namespaced identity and a mandatory evidence base:

- `scored_by: "metric:<framework>"` — the `metric:` prefix is the permanent
  provenance marker (agent judgments keep bare agent names; the namespace
  can never collide because agent names are self-declared WITHOUT colons
  today — validation would pin `^[^:]+$` for agent-authored entries the
  moment this ships).
- `framework: "engagement.v1"` (the metric framework, code-defined — §15.5);
  `dimension`: the §6 activity the score summarizes (`dwell`, `completion`,
  `read_progress`, `cta_click`).
- `rationale` (REQUIRED for metric entries, structured JSON string):
  `{window_start, window_end, n_sessions, source: "tracking_event.v1",
statistic: "p75_dwell_ms", value, threshold_profile}` — a score is never
  quotable without its evidence window and sample size. Structured-in-
  rationale keeps the schema additive-free in v1; IF Wolf prefers first-
  class fields, the additive alternative is an optional `evidence` object on
  `contentItemScoreSchema` (still additive — old entries parse untouched).

### 15.2 Transport — who writes, through what

**Recommended: (a) the owner DB computes; an agent submits through the
normal `object_patch` path.** A scheduled owner-side job (or a human) runs
the §5.4 join, renders proposed score entries, and an agent applies them
with an ordinary `update_node`-style patch op — concretely a new bounded op
`append_scores` (append-only by grammar; see §15.3) — through checkout →
validate → publish. Every write stays inside the governed grammar, the
approval policy, locks, history, and inverses. Nothing new to trust.

Weighed and not recommended:

- (b) a dedicated MCP tool (`article_record_metric_score`) — adds a
  privileged writer surface for no gain over (a); the funnel pattern
  (set_product_price) exists for CANONICALITY problems, and scores have no
  canonicality problem — append-only composition suffices.
- (c) a fully automatic writer (sink-triggered) — rejected for v1: OQ-3
  per-agent credentials do not exist yet, so an unattended writer would be
  an unattributable principal with publish-adjacent power; and the trust
  model treats the owner DB as OUTSIDE the CMS boundary (env-name-only
  coupling, §3). Reconsider only after OQ-3 lands.

### 15.3 Guard rules (hard — these are the law of the feature)

1. **Append-only:** metric writers may only APPEND `scores[]` entries —
   never mutate or delete existing entries (agent or metric), never touch
   any other field. The proposed `append_scores` op encodes this in the
   GRAMMAR (its only argument is the new entries array; capture = appended
   ids; inverse = remove-those-appended — exact).
2. **No cascade:** appending scores never triggers publish/release; the
   entry lands in the draft record like any patch and rides the normal
   publish flow. A metric score on a PUBLISHED record still requires the
   standard checkout/publish cycle to become part of the published body.
3. **Leak rule untouched:** `scores[]` stays non-rendered (the reader-
   projection scan already pins revision_control out of HTML — no change).
4. **Sample floor:** `n_sessions >= 50` (per-site threshold data, §15.5)
   or validation BLOCKS the entry — noisy small-sample scores cannot flood
   the envelope. Plus a per-(framework, dimension, window) uniqueness rule:
   re-runs replace nothing; a duplicate window is a validation blocker, so
   backfills are idempotent by refusal.
5. **Bounded volume:** ≤ N metric entries per record per window run (N=8
   proposed) — the envelope is a judgment ledger, not a metrics warehouse;
   the warehouse is the owner DB.

### 15.4 Variant judging (the create_variant / A-B loop this serves)

Scores on a variant (`lineage.parent_content_id` set) compare against the
parent's scores on the SAME `(framework, dimension)` with OVERLAPPING or
adjacent windows — the comparison is a read-side join over the family
(`object_inventory {variants_of}` already lists it), not new state.
**Honesty rule, stated on every comparison surface:** OQ-W7-2 (traffic
splitting) stays deferred, so parent and variant windows are SEQUENTIAL or
organic exposure — never concurrent randomized arms. Metric comparisons
are therefore directional evidence, not experiments; the design refuses
any UI/tooling copy that calls them A/B tests. What the loop buys today:
draft variant → publish → window passes → metric scores land on both →
an agent (or Wolf) judges with real reader behavior cited, and publishing
the winner stays one `object_publish`.

### 15.5 Multi-project

Framework definitions (`engagement.v1`: which statistics over which §6
activities, the statistic vocabulary) live in CORE CODE — one
implementation for every site (doc-11 alignment). Per-site knobs are DATA:
the sample floor, window lengths, and threshold profiles live in the
site's `trk_<project>` record (an additive optional `scoring` block —
schema change only when implementation is commissioned) so tenants tune
sensitivity without code.

### 15.6 What a YES commissions (so the ruling is scoped)

The `append_scores` op + grammar/inverse/tests; the metric-entry
validation rules (§15.3's floor/uniqueness/volume + the `scored_by`
namespace pin); the owner-side reference SQL for computing entries (an
extension of the §5.4 kit); and the agent runbook for the submit leg.
Explicitly NOT commissioned even by a YES: automatic writers (§15.2c),
traffic splitting (OQ-W7-2), rendering scores anywhere public.

**OQ-W13-5b — ANSWER (Wolf): ruling on §15 (adopt / adopt-with-changes / reject):** **\*\***\_\_\_**\*\***

## 16. Variant experiments — edge serving + exposure (T21.5, BUILT)

§15.4 designed the create_variant judging loop under a standing honesty rule:
traffic splitting (OQ-W7-2) stayed deferred, so parent/variant windows were
sequential or organic and comparisons were "directional evidence, not
experiments". **T21.5 commissions the split itself.** That rule now scopes
exactly to comparisons made WITHOUT an experiment entry; a family covered by an
`active` experiment below IS a concurrent randomized test, and may be described
as one.

### 16.1 The registry entry

`tracking_config.v1` gains `experiments[]` (≤20), patchable through
`set_tracking_config_fields` like every other block. Each entry is IDs only —
no URL an agent can author:

```
{ object_id, arms: [{ variant_id, route }] (2..6), status, winner? }
```

- `object_id` is the CONTROL: the family parent `content_item`.
- `arms` is the COMPLETE served set. **Exactly one arm must be the control
  itself** — listing it is what makes the control's traffic share weightable
  rather than implicit.
- Every other arm is a `content_item` whose `lineage.parent_content_id` equals
  `object_id` (i.e. an `object_create_variant` child), and its `route` must
  equal the route derived from its own slug. Validation refuses anything else,
  hard (write-blocking, not publish-gated): a bad arm is not an incomplete
  draft, it is a route the edge would rewrite live readers to.
- `status`: `draft` (authoring), `active` (serving), `concluded` (history).
  Only `active` serves; concluding reverts every reader to the control on the
  next build with no second switch to remember.

### 16.2 Build → two artifacts

`scripts/tracking-experiments-build.mjs` runs before `astro build` on every
site and writes:

| File                                             | Consumer                    |
| ------------------------------------------------ | --------------------------- |
| `<publicDir>/_trk/experiments.json`               | the loader and the tests    |
| `<edgeDir>/_experiments.generated.json`           | the edge function's bundle  |

Both carry `{object_id: {route, arms: [{variant_id, route, weight}]}}` — `{}`
when nothing is active. Two copies because **edge bundles cannot import from
`public/`**; the edge copy also carries `{restricted_regions, honor_gpc}`
because the edge cannot read `data/site/tracking.json` either.

Weights come from `GET ${TRACKING_SINK_URL}/weights?project_id=<id>`, 2s
timeout. Absent config, timeout, non-2xx, or an unusable row → **equal
weights**. A weight outage may change how traffic splits; it may never change
WHICH arms are served, and it may never fail a build.

### 16.3 The edge function

`netlify/edge-functions/variant-serve.ts`, declared `path = "/*"` in the root
`netlify.toml` and every `sites/*/netlify.toml`. Decision order (asserted by
name in `tests/netlify/tracking-experiments-edge.test.ts`):

1. **empty map → `context.next()`** — before a cookie, a geo read, or an RNG
   call. This is the zero-experiment guarantee, and it is the path every
   request on the fleet takes today.
2. **path is not a served CONTROL route → `next()`** — including a direct hit
   on a variant's own route, which is already an arm and must not be
   re-randomized.
3. **consent gate → serve the CONTROL, no cookie written:** `Sec-GPC: 1` (when
   `honor_gpc`), or `context.geo.country` ∈ `restricted_regions` without a
   `_dlconsent` cookie carrying `analytics:true`.
4. **sticky `_dlab` cookie** naming a still-served arm → that arm, not re-set.
5. **weighted pick** over the arms, and set `_dlab`
   (`{object_id: variant_id}`, 30d, `SameSite=Lax; Secure; Path=/`).

Every served branch is a `context.rewrite` — **the URL never changes**. The
response carries `x-trk-variant: <variant_id>` and appends `Vary: Cookie`.

Every decision lives in `packages/core/lib/tracking/experiments/edge-core.ts`,
which is type-checked and unit-tested; the four deployed `variant-serve.ts`
files are Deno wiring only and are excluded from `tsconfig` (Deno `.ts`
specifiers). A test asserts they stay that thin.

**Known gap, deliberate and fail-safe:** the consent runtime (§8) stores
`_dlconsent` in **localStorage**, which no edge function can read. Step 3 reads
a `_dlconsent` COOKIE of the same shape, so until something mirrors the choice
into a cookie, a restricted-region visitor always reads as "no analytics
consent" and is served the control — the conservative direction, identical to
the pre-experiment site. Closing it means writing a consent cookie, which is
itself a consent decision and is deliberately NOT taken here.

Unknown/unresolved `country` is NOT treated as restricted at this gate. §8's
"unknown = restricted" governs whether an advertising SCRIPT executes; which
ARTICLE a reader sees is not a tracking decision, and pinning it to the control
would make the split depend on Netlify's geo coverage.

### 16.4 Render + exposure

Every arm's article wrapper carries `data-cms-experiment="<control id>"` and
`data-cms-variant="<this arm's id>"` — both already-public object ids, no new
identifier in reader HTML. A NON-control arm additionally renders
`<meta name="robots" content="noindex" data-cms-experiment-arm="…">` and
canonicalizes to the control route (the arm's canonical REPLACES the page's own
— two conflicting canonicals are ignored wholesale, which would leave both arms
indexable).

The loader emits one `exposure` per page-load when the marker is present —
a new `TRACKING_EVENT_KINDS` member with `props: {experiment_id, variant_id}`,
both pinned to the content_item id grammar and allowlisted in
`server/lib/tracking-events.ts`. It is neither sampled nor gated by the §6
matrix: an exposure is the experiment's denominator, and a half-counted
denominator makes every arm comparison wrong rather than merely noisy. The sink
needs no change (`event` is free text, `props` is jsonb).

View Transitions are covered: the emit rides `bindPage`, which the
`astro:page-load` listener drives, so a client-side navigation between arms
counts the new one and a repeated bind of the same page counts nothing.

### 16.5 Turning one on

1. `object_create_variant` on the parent article; edit and publish the variant.
2. `set_tracking_config_fields` on `trk_<site>` with the `experiments` entry
   (`status: 'active'`, control listed among the arms), publish + release.
3. The next build materializes the map; the edge starts splitting.
4. To stop: set `status: 'concluded'` (and `winner`), publish, rebuild.

### 16.6 Proving it

`npm test` covers the schema, the reference rules, the materializer, the build
step (map + weights + the zero-experiment artifacts), every edge decision
branch including a ±2%-over-10,000-draws distribution check, and the loader's
one-exposure-per-page-load rule across a View Transitions navigation.

The dist half needs an ACTIVE experiment, which the committed fleet state does
not have — so it is a drill, not a test: `npm run drill:experiments:dist`
plants one over the real `object-model-demo` parent/variant pair, builds, checks
the built HTML (arm markers, the variant's noindex + canonical-to-control, the
control carrying neither), and restores the tree in a `finally`.

`node scripts/build-diff.mjs` is the standing guarantee: with `experiments: []`
it must stay EMPTY. Note that a spread of arm attributes onto the article
wrapper does NOT stay empty — Astro emits the scoped component class at runtime
for a spread, changing every article page. The attributes are written
explicitly for exactly this reason.
