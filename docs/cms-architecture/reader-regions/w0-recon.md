# W0 T0.1 — reader-regions recon (anchors only)

> Read-only pass over `main` at `0ef0306`. Anchors, not code. Every line number
> is that commit's; re-grep the symbol rather than trusting the number after a
> rebase.

## 1. How a plugin principal is identified on `/mcp`

There is **no `isPlugin` flag**. The distinguishing field is `surface` on the
derived `Principal`, and the only thing that can produce a plugin value is the
auth layer — never a tool argument.

| Anchor | What it establishes |
|---|---|
| `packages/core/server/functions/mcp.ts:312` | `LambdaEvent.pluginSurface?: string` — an **in-process event field**, deliberately not a header, so a client cannot claim it. |
| `packages/core/server/functions/plugin-actions.ts:181` | The only writer: the Actions façade stamps `pluginSurface: 'plugin:openai-gpt'` before re-entering `mcpHandler`. |
| `packages/core/server/lib/caller-actor.ts:80` | OAuth branch: `surface = trimmed(source.pluginSurface) ?? oauth.surface` — an OAuth grant carries its own `surface` derived from the client's redirect host. |
| `packages/core/server/lib/caller-actor.ts:88` | Non-OAuth branch: `surface = trimmed(source.pluginSurface)` only. |
| `packages/core/server/functions/mcp.ts:1708` | The one existing precedent for reading it at dispatch: `preflightToolCall` computes `toNonEmptyString(event.pluginSurface) ?? event.oauthPrincipal?.surface` for the per-surface kill switch. |
| `packages/core/server/lib/whoami.ts:~205` (`buildWhoami`) | `surface` is `actor.surface` or the literal `'unknown'`; `whoami` reports it. |

**Values.** `plugin:openai-gpt` (Actions façade, in-process), `plugin:claude`,
`plugin:openai-agent` (both from the OAuth grant's `surface`) — enumerated in
the `WhoamiResult.surface` doc comment, `whoami.ts:~78`. Everything else is a
non-plugin principal:

- **admin-chat / CMS-Agent** — reaches the object verbs through
  `object-store.ts` (publish key) or as a verified agent token; `surface` is
  absent unless an OAuth grant supplied one.
- **workflow / sweep** — same: publish key, no surface.
- **human** — `actor.kind === 'human'` via OAuth; may carry a `surface` when
  the human is driving a chat app, which is exactly the plugin case.

⇒ The test a `/mcp` charter gate must use is **`surface` starts with
`plugin:`**, not `actor.kind`. A human on `plugin:claude` IS the plugin
principal — that is the install the charter was granted to.

## 2. The active plugin manifest lookup

| Anchor | What it is |
|---|---|
| `packages/core/server/lib/plugin/manifest-store.ts:19` | `PLUGIN_MANIFEST_DOC_KEY = 'manifest.v1'` |
| `packages/core/server/lib/plugin/manifest-store.ts:26` | `getPluginManifestBlobStore(event, binding)` |
| `packages/core/server/lib/plugin/manifest-store.ts:31` | `getPluginManifestDoc(store) → { active?, draft? }` |
| `packages/core/server/functions/plugin-actions.ts:150-165` | The enforcement site: load `active`, then `!active.tools.some(t => t.name === toolName) && !PLUGIN_ALWAYS_IN_CHARTER.has(toolName)` → 403 `tool_not_in_plugin_charter` with `manifest_version`. No active manifest → **409**, store unreachable → **500**. |
| `packages/core/server/lib/plugin/build-tools.ts:87` | `PLUGIN_ALWAYS_IN_CHARTER = new Set(['whoami'])` |
| `packages/core/server/lib/whoami.ts:~230` | The same read, fail-soft: a store fault leaves `charter: null` rather than failing the call. |

`build-tools.ts:11-15` is the header comment that currently states the
**"ADVISORY on `/mcp`"** claim; `docs/CMS_INTEGRATION.md:425-431` and
`docs/plugin/recon-genesis.md:86` restate it.

## 3. Route / slug uniqueness — every caller

**Declarations** (`packages/core/server/lib/object-validate.ts`):
`isRouteTaken` `:209`, `isSlugTaken` `:215`, `isArticleSlugTaken` `:222`.

**Consumers** — three, each in its own namespace, none aware of the others:

| Anchor | Rule |
|---|---|
| `object-validate.ts:3136-3138` | `structure_route` — page route uniqueness **across pages only**. |
| `object-validate.ts:2614-2616` | article slug uniqueness **across `content_item` + committed legacy post stems**. |
| `object-validate.ts:2089-2091` | product slug uniqueness **across products** (`/shop/<slug>`). |

**The single producer** — `packages/core/server/lib/object-validation-context.ts`:
`isRouteTaken` `:313`, `isSlugTaken` `:324`, `isArticleSlugTaken` `:335`,
returned at `:429-431`. All three are sync closures over one pre-loaded
snapshot of the site-objects store (`records`), excluding `self.selfObjectId`.
`isArticleSlugTaken` additionally consults `contentItemIds` from
`content-item-index.ts` (`loadContentItemIds`).

**Nothing else constructs these callbacks.** `object-verbs.ts` passes the
context straight through (`validateObject(..., context)` at `:1474`, `:1552`,
`:1684`, `:1842`, `:2465`, `:2573`, `:2628`).

### The redirect table — where it is read

| Anchor | Role |
|---|---|
| `packages/core/server/lib/site-redirects.ts:41` | `siteRedirectsExportPath(exportRoot)` → `<exportRoot>/redirects.json` |
| `packages/core/server/lib/site-redirects.ts:~70` | `SITE_REDIRECTS_DOC_KEY = 'site/redirects.v1.json'` — the **blob-store doc is the source of truth**; `redirects.json` is derived. |
| `packages/core/server/lib/site-redirects.ts:~78` | `loadSiteRedirects(store)` — absent/malformed ⇒ `[]`, never throws. |
| `packages/core/server/lib/object-verbs.ts:2731` | The **only** runtime caller of `loadSiteRedirects` (the retire path). |
| `packages/core/server/lib/object-retire.ts:177-178`, `:228` | Writes both the export file and the store doc via `upsertRedirect`. |
| `packages/core/app/site-redirects-integration.ts:31-45` | **Build-time** reader of the committed `redirects.json` → Netlify `_redirects`. Validation failure or an unreadable file is a `logger.warn` and a skip. |

⇒ Validation has **no** redirect reader today. A resolver that must know the
redirect table needs `loadSiteRedirects` pre-loaded into the validation
context the same way `contentItemIds` is (`object-validation-context.ts`
already does one async pre-load pass before returning sync closures).

### Reserved prefixes and file routes

| Anchor | Role |
|---|---|
| `packages/core/app/utils/object-page-routes.ts:98` | `computeObjectPageRoutes` — the pure build-time owner check: `file_route`, `blog_slug`, `reserved_prefix`, `loader_owned_page_type`, `invalid_route`. |
| `packages/core/app/utils/object-page-routes.ts:54` | `reservedPrefixes: string[]` is an **input**, not a constant. |
| `sites/drlurie/app/pages/[...objectPage].astro:42` | drlurie's list: `[BLOG_BASE, CATEGORY_BASE, TAG_BASE, 'learn/topics', 'admin']` |
| `sites/{platform,zilberman,fernwell,genesis-lab-2}/app/pages/[...objectPage].astro:32` | The same list, per tenant. |
| `packages/core/cli/create-site.mjs:1853` | The scaffold copy — **P1 parity surface**: any change to the shape of this list lands here too. |

⇒ The reserved-prefix list lives in **five tenant files plus the scaffold**, not
in core. A core resolver either takes it as an argument (the
`computeObjectPageRoutes` pattern) or a core constant is introduced and the six
call sites are repointed in the same change (P1).

### Severity vocabulary (for the checks W0/W1 add)

`object-validate.ts` criteria carry a `CriterionStatus`
(`packages/core/lib/admin/readiness-criteria.ts:18`); `object-contract.ts:227`
carries the declarative `ConstraintSeverity`. The mapping in force:

| Constraint severity | Criterion status |
|---|---|
| `blocks_write` | `'missing'` regardless of `atPublish` |
| `blocks_publish` | `'missing'` when `atPublish`, else `'warning'` |
| `warns` | `'warning'` always |

`summarizeValidation` treats `'missing'` as a blocker and `'warning'` as an
operator note; `object-verbs.ts:1476` returns **422** on `!summary.eligible`.

## 4. `site.chrome.announcement.sectionRef` — dead or live?

**Dead: declared, validated, never rendered.** Complete set of occurrences
outside `docs/**` and `sites/*/data/**`:

| Anchor | What it does |
|---|---|
| `packages/core/schema/bodies/site-v1.ts:224-230` | Declares `chrome.announcement { enabled: boolean; sectionRef?: string }`. |
| `packages/core/server/lib/object-validate.ts:670-672` | `requireObject('section', sectionRef, 'chrome.announcement.sectionRef')` — reference integrity only. |
| `packages/core/app/layouts/PageLayout.astro:28` | Reads `site.chrome` but destructures only `showRssFeed` / `showThemeToggle`; the default literal omits `announcement` entirely. |
| `sites/drlurie/seeds/site-seed-data.mjs:35` | "chrome.announcement is deferred (B3) and omitted." |
| `sites/drlurie/app/pages/homes/{personal,mobile-app}.astro` | `<Fragment slot="announcement"></Fragment>` — inherited **AstroWind template** slots on two orphaned demo pages (`KNOWN_ISSUES` #59), unrelated to `site.chrome`. |

No file under `packages/core/app/**` or `packages/core/components/**` reads
`chrome.announcement`. A site object may therefore point `sectionRef` at a real
section, pass validation, and render nothing.

⇒ Recorded as `docs/KNOWN_ISSUES.md` #68. Per the wave brief the
`announcement` region row stays in the registry, unrendered.
