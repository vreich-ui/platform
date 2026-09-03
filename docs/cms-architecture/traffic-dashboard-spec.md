# `/admin/traffic` — dashboard specification (R6.0)

**Status:** APPROVED by Wolf 2026-09-03 — `GATE-TRK-5` passed. R6.1 may start.
**Commissioned:** 2026-09-03/04 (runner plan §R6). **Written:** 2026-09-03.
**Scope:** the `/admin/traffic` page on every tenant, both feeds, plus the `/stats` additions in `kugel-data` that the page needs.

Wolf's brief, verbatim intent: *better organized, compact boxes, every available data point, best UI/UX for the feature to be useful (research current practice online), traceable graphs with an optimal tech choice, and ignore `/admin/*` pages in the data.*

---

## 1. What exists today

Grounded in `main` at the time of writing, not from memory.

| Piece | File | State |
|---|---|---|
| Page shell + layout | `packages/core/admin/TrafficWorkspace.tsx` (470 lines) | Range picker, an own-tracker section, a Netlify section, per-section loading/error/empty states |
| Charts | `packages/core/admin/TrafficCharts.tsx` (180 lines) | Hand-rolled inline SVG. `buildLinePoints` / `pointsToPolyline` / `pointsToAreaPath`. No tooltip, no cursor, no zoom |
| Admin data function | `packages/core/server/functions/admin-traffic.ts` (188 lines) | GET-only behind the admin auth wall. `?source=own&days=7\|30` proxies the sink; otherwise Netlify. Memo cache (5 min TTL) + real `ETag`/`304`. Honest `{configured,enabled,error_code,message}` degrades — never a 500 for "not set up" |
| Netlify API client | `packages/core/server/lib/netlify-analytics.ts` (261 lines) | Calls `/pageviews`, `/visitors`, `/ranking/pages`, `/ranking/sources`. **`/ranking/not_found` and `/ranking/countries` are documented in the file header but never called.** Maps 401/403/404 all to "not enabled" |
| Own-tracker shaping | `packages/core/lib/admin/own-traffic-logic.ts` | `totals`, `daily`, `top_objects`, `top_sources`, `dims`, plus `captureRate()` |
| Range logic | `packages/core/lib/admin/traffic-logic.ts` | `7d` / `30d` / `90d` / `custom` (≤180 d), persisted per site+user in `localStorage` |

Two asymmetries worth naming before designing on top of them:

* **The range picker is effectively Netlify-only.** `OwnTrackerDays` is the literal union `7 | 30`; `90d` and `custom` silently fall back to 30 for the own feed.
* **The two feeds do not share a clock.** Netlify buckets by `ANALYTICS_TIMEZONE_OFFSET`; the sink buckets by UTC calendar day. Under a 24 h window these disagree by up to one bucket.

## 2. The defects this replaces

From the current render (`traffic-ui-current.png`):

1. Five oversized KPI tiles with tiny labels; **Capture rate** orphaned on a second row; **Last event** — a health signal — sitting in the KPI row as if it were a metric.
2. Netlify **Most-visited pages** is dominated by `/admin/agents`, `/admin/requests`, `/admin/traffic` — the operator's own clicks.
3. Own **Top sources** lists `drluriescience.n…`; a same-host referrer is internal navigation, not a source.
4. **Top objects** shows raw ids (`page_home`, `page_library`) with no title, no route, no link.
5. Two unrelated "over time" charts, no shared cursor, no tooltips, no zoom; sessions and visits drawn in near-identical blues.
6. No previous-period comparison anywhere.

## 3. What current practice actually does

Surveyed September 2026: Plausible, Fathom, PostHog Web Analytics, Netlify Analytics, Vercel Web Analytics, Umami, Simple Analytics, GoatCounter. Sources at §11.

**Convergent — near-universal, and therefore what we adopt:**

* **One KPI strip, 4–6 numbers wide**, above everything. Visitors/visits, views, bounce-or-engagement, and a duration metric are the common four; conversions appear only where goals are configured.
* **One shared time-series chart with a metric switcher**, not one chart per metric. In Plausible and Fathom the KPI label *is* the switcher: click "Views" and the chart plots views. Netlify and Vercel are the exceptions (a chart per metric / per tab) — and both are the products with non-clickable KPIs.
* **Comparison-period deltas** shown as a small delta under or beside each KPI ("+12% vs previous"). Universally available; universally **opt-in** via a toggle rather than always-on.
* **Breakdown panels grouped into 4–6 boxed cards, each internally tabbed** across related dimensions — Sources (referrers / channels / UTM), Pages (top / entry / exit), Locations, Devices. This "card with internal tabs" shape is the single most consistent structural convention across every product surveyed.
* **Click a row to filter the whole dashboard.** Filters render as removable pills near the chart and live in the URL so a filtered view can be bookmarked. A modifier-click (Fathom uses Cmd/Ctrl) opens the row's page instead of filtering.
* **Bot filtering is silent and server-side** — a background guarantee, never a dashboard toggle.
* **Internal-traffic exclusion is a settings concern**, not a report filter: IP lists, hostname allow-lists, URL-pattern rules.

**Divergent, with our position:**

* *Density.* Fathom/Plausible run compact cards ≈300–450 px tall with ~8–10 rows and a "view more"; GoatCounter deliberately refuses density. We take the compact-card side — this page is read on a laptop by one operator.
* *Session definitions never reconcile across tools.* Vercel uses a one-day request hash, Simple Analytics infers visits from referrer domain, Plausible/Fathom use a session window. **Our two feeds will disagree on visitors and sessions by construction, not by bug**, and the page must say so rather than inviting Wolf to hunt a discrepancy that is definitional.

## 4. Decisions

Each decision states what it rejects, so a future reader can tell a choice from an accident.

**D1 — Two tabs, one grammar.** `Own tracker (first-party)` is the default tab; `Netlify (server-side)` is the second. `?source=` persists in the URL. Both tabs render the *same* components — KPI strip, one chart, ranking cards — so moving between them is a change of data, not of vocabulary. *Rejects:* stacking both feeds on one scroll (today's layout), which forces the reader to hold two clocks and two definitions in mind at once.

**D2 — One KPI strip of five, and health leaves it.** Own tab: **Pageviews · Sessions · Visitors · Consented % · Purchases**. Netlify tab: **Pageviews · Unique visitors · Top page share · 404s · Bandwidth** (each omitted if its endpoint 404s). `Last event`, `Capture rate` and sink status move to a **footer meta strip**. *Rejects:* the current five-plus-one-orphan row; a health timestamp is not a metric and must not be sized like one.

**D3 — Comparison on by default for preset ranges.** A `Compare: previous period` toggle sits in the range picker. Default **on** for `7d`/`30d`/`90d`, **off** for `custom`. Each KPI carries `+12%` / `−4%` with an explicit sign and an arrow — **never colour alone** — and the chart draws the previous period as a dashed ghost series. *Divergence, deliberately:* every surveyed product defaults comparison off. They serve visitors who open a dashboard casually; this page is opened by one operator on a cadence, for whom "up or down since last week" is the actual question. If the strip proves noisy, flipping the default is a one-line change.

**D4 — One chart, metric switcher on the KPI labels.** The KPI tiles are the switcher, Plausible/Fathom-style: the active tile is visually selected and the chart plots it. Own tab switches across pageviews / sessions / visitors / engagement events / purchases; Netlify tab across pageviews / unique visitors. *Rejects:* the plan's earlier "one chart per metric", and today's two-charts-no-relationship.

**D5 — Four tabbed ranking cards per tab.** Own: **Pages** (top / entry / exit) · **Sources** (referrer / UTM source / UTM medium / UTM campaign) · **Locations** (country) · **Engagement** (per-object funnel: pageview → read progress → completion → CTA click → buy click). Netlify: **Pages** · **Sources** · **Locations** · **Not found**. Max height 320 px, 8 rows, "view all" expands in place. *Rejects:* one flat card per dimension, which is what makes the page long.

**D6 — Object ids never reach the screen.** `admin-traffic.ts` resolves `object_id` → title + route from the tenant's `data/site/**` export, cached per deploy. Each row links to the live page, with a secondary link to its admin object. An id that cannot be resolved renders as the id with a muted "unresolved" marker — visible, not hidden. *Rejects:* showing `page_home` to a human.

**D7 — Click-to-filter, URL-persisted.** Clicking a country, source, or object row adds a filter; active filters render as removable chips above the chart; the filter set lives in the query string. Every card and the chart re-query under the filter. Cmd/Ctrl-click opens the row's target instead. Own tab only in R6 — the Netlify API takes no filter parameters, so on that tab rows are links, not filters, and the card says so once.

**D8 — Exclusions are a property of the data, not a checkbox.** `/admin/*` and `/.netlify/*` are excluded from every ranking and every total on both feeds; same-host referrers bucket to **Internal** and are never ranked; test traffic (the R7.3 `x-trk-test` header) and known bot user-agents are excluded at ingest. One caption — *"excl. admin, internal & test"* — appears once per tab, not per card. Where the Netlify API cannot filter, the admin function computes the excluded totals from the ranking rows and labels them "excl. admin". *Rejects:* a user-facing toggle; the operator's own clicks are never the answer to any question this page is asked.

**D9 — The two feeds are compared on pageviews only.** **Capture rate = own pageviews ÷ Netlify pageviews** over the same window, in the footer strip, with the standing honesty rule from doc 12 §5.5 — never a claim of 100 %. Sessions and visitors are **not** cross-compared anywhere on the page, and the footer says in one line that the two feeds count sessions differently by design.

**D10 — Range picker applies to both tabs.** `7d` / `30d` / `90d` / `custom` (≤180 d). No `24h` option — see §9.3. The sink's `days`-only parameter is replaced by `from`/`to` (R6.2), which is what removes the current silent fallback to 30.

## 5. Page anatomy

```
┌ Traffic ─────────────────────── [Own tracker] [Netlify] ─ [7d 30d 90d ⌄] [⇄ Compare] ┐
│ chips:  country: IL ✕   source: newsletter ✕                                          │
├───────────────────────────────────────────────────────────────────────────────────────┤
│  Pageviews    Sessions     Visitors     Consented    Purchases      ← KPI strip = the  │
│  4,102 ▲12%   1,940 ▲8%    1,510 ▼3%    36% ▲2pp     14 ▲4            metric switcher │
├───────────────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │  one time series · solid = this period · dashed = previous · shared cursor     │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│  ▸ data table for this chart (collapsed, keyboard-reachable)                          │
├───────────────────────────────────────────────────────────────────────────────────────┤
│  ┌ Pages ──────────────┐ ┌ Sources ────────────┐ ┌ Locations ──┐ ┌ Engagement ─────┐  │
│  │ top│entry│exit      │ │ referrer│utm ...     │ │ country     │ │ funnel per obj  │  │
│  │ ≤320 px, 8 rows     │ │                     │ │             │ │                 │  │
│  └─────────────────────┘ └─────────────────────┘ └─────────────┘ └─────────────────┘  │
├───────────────────────────────────────────────────────────────────────────────────────┤
│  last event 4 min ago · capture rate 71 % vs Netlify · sink ok · excl. admin & test    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Grid: three columns ≥1280 px, two at 1024–1279, one below. No card taller than 320 px.

## 6. Data the page needs

### 6.1 `kugel-data` `/api/tracking-sink/stats` (R6.2, no auth, aggregates only — unchanged posture)

Accepts `from`/`to` in addition to `days`; `filter` (`country` | `source` | `object_id`) for D7; `exclude_test=1`, default on.

Adds to the payload:

* `previous` — the same object for the immediately preceding window of equal length (D3).
* `top_countries`, `top_referrer_hosts` (same-host → the literal `internal` bucket).
* `utm` — `source` / `medium` / `campaign` tables.
* `devices` — viewport buckets `<640`, `640–1023`, `≥1024`, plus top-10 `lang`.
* `entry_pages` / `exit_pages` — first and last pageview per `shash`.
* `scroll_depth_distribution` — 25 / 50 / 75 / 90 / 100 buckets.
* `engagement_funnel` per object — pageview → read_progress → completion → cta_click → buy_click.
* `events_by_kind` per day. **No `hourly` bucket** — see §9.4.

### 6.2 `admin-traffic.ts` (R6.2)

* Wire `/ranking/not_found` and `/ranking/countries`; render both trend series (`/pageviews` **and** `/visitors`); probe `/bandwidth` once per deploy and omit the KPI if it 404s.
* Apply the D8 exclusions **server-side**, never in the client.
* Resolve object ids to title + route from `data/site/**`, cached per deploy (D6).
* Keep the existing memo/ETag/304 cache and the honest not-configured shapes exactly as they are — they are already right.

## 7. Charts (R6.3)

**Decision: adopt uPlot** (v1.6.32), dynamically imported so the admin bundle is untouched until the page opens, mounted in `useEffect`, no React coupling. Rankings stay HTML bars — no library.

| Library | Size (min) | Cursor sync across charts | Drag-to-zoom | Tooltip | Coupling |
|---|---|---|---|---|---|
| **uPlot 1.6.32** | ~50 KB | **built-in** | **not built in** — plugin/hooks | hooks, build your own | none |
| Chart.js 4.5 | ~65–70 KB | community crosshair plugin | official zoom plugin | built-in | none |
| Observable Plot | ~40–60 KB | no native concept | no | pair with D3 | none |
| Recharts 2.x | ~90–140 KB | `syncId` prop | brush only | `<Tooltip>` | hard React |

**Correction to the runner plan.** §R6.3 of the plan justifies uPlot partly on "ships … drag-to-zoom". It does not: uPlot deliberately omits drag scrolling and zooming because native selection semantics are ambiguous, and points you at the plugin/hooks API. Cursor sync — the feature that actually makes this page *traceable* — **is** built in and is the real reason to choose it. Drag-to-zoom is therefore a small local plugin (~40 lines against `setSelect`), and if it slips it slips alone.

Rules: one shared time axis per tab; previous period as a dashed ghost; the tooltip shows every visible metric for the hovered bucket; clicking a bucket sets the range to that day; hovering any chart moves the cursor on all of them.

## 8. Accessibility (R6.3/R6.4)

uPlot ships **no** accessibility affordances — canvas is opaque to a screen reader. The mitigations are therefore load-bearing, not garnish:

* A **keyboard-reachable data table** under every chart, holding the same numbers (collapsed by default, focusable, announced).
* **Never colour alone**: deltas carry a sign and an arrow; series carry direct labels or dash patterns, not only hue. This also fixes defect 5 — sessions and visits must not be two near-identical blues.
* Text contrast ≥ 4.5:1; the page functions at 200 % zoom.
* Every interactive element — tiles, tabs, rows, chips — reachable by keyboard with a visible focus ring.
* Acceptance: Lighthouse a11y ≥ 90 on `/admin/traffic`.

## 9. Questions — resolved at the gate

Answered by Wolf 2026-09-03 when this document was approved. Recorded here so a later reader sees a decision, not an omission.

1. **D3's default-on comparison** — **kept**, divergence and all. Comparison-period deltas default ON for `7d`/`30d`/`90d`, off for `custom`.
2. **Netlify tab click-to-filter** — not possible; that API takes no filter parameters. Rows on the Netlify tab are links, and the tab says so once. Click-to-filter (D7) is own-tab only in R6.
3. **`24h` / hourly** — **dropped.** At current volume an hourly view is mostly noise and it costs a separate bucketing path in `/stats`. The range picker is `7d` / `30d` / `90d` / `custom` (≤180 d); D10's mention of a `24h` option does not apply, and `/stats` gains no `hourly` field.
4. **Engagement card** — **kept in R6.** It is the only card that shows what the first-party tracker can do and Netlify cannot, and `engagement_funnel` was already inside R6.2's scope.

## 10. Build order and acceptance

| Task | Model | Est. | Gate |
|---|---|---|---|
| R6.0 spec | Opus high | 1 h | **this document — `GATE-TRK-5`** |
| R6.1 layout, tabs, shared components, empty/partial states | Sonnet medium | 2 h | fixture renders per tab, incl. one feed down |
| R6.2 data points (`kugel-data` `/stats` + `admin-traffic`) | Sonnet high | 3 h | contract tests both sides; exclusions unit-tested |
| R6.3 uPlot charts + data tables | Sonnet medium | 2 h | Playwright: hover chart A → chart B legend updates; Lighthouse a11y ≥ 90 |
| R6.4 exclusions + hygiene | Opus medium | 1 h | no admin path in any rendered ranking, both feeds |

Commits: `T21.10: traffic spec`, `T21.11: traffic layout + tabs`, `T21.12: stats data points`, `T21.13: uPlot charts`, `T21.14: exclusions`.

## 11. Sources

- [Plausible — introduction to the dashboard](https://plausible.io/docs/guided-tour)
- [Plausible — excluding internal traffic](https://plausible.io/docs/excluding)
- [Fathom — dashboard explained](https://usefathom.com/docs/start/dashboard)
- [Fathom — March 2026 analytics rebuild](https://usefathom.com/changelog/mar2026-analytics-rebuild)
- [PostHog — web analytics dashboard](https://posthog.com/docs/web-analytics/dashboard)
- [Netlify — web analytics overview](https://docs.netlify.com/manage/monitoring/web-analytics/overview/)
- [Vercel — web analytics](https://vercel.com/docs/analytics)
- [Umami — metric definitions](https://docs.umami.is/docs/metric-definitions)
- [Simple Analytics — what we collect](https://docs.simpleanalytics.com/what-we-collect)
- [GoatCounter — design philosophy](https://www.goatcounter.com/design)
- [uPlot](https://github.com/leeoniya/uPlot)
- [chartjs-plugin-zoom](https://github.com/chartjs/chartjs-plugin-zoom)
- [A11Y Collective — accessible charts checklist](https://www.a11y-collective.com/blog/accessible-charts/)
- [Deque — making interactive charts accessible](https://www.deque.com/blog/how-to-make-interactive-charts-accessible/)
