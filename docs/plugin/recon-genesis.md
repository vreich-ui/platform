# W0.2 — Genesis recon (vreich-ui/cms-agent)

Read-only recon, 2026-08-31. Source: shallow clone of `vreich-ui/cms-agent` @ `main`.
Question asked: *which workflow(s) create a tenant and write brand_voice/image_style/etc, and where
does an `emit_plugin_manifest` node fit?*

**Answer: the host workflow the plan assumes does not exist yet. W4 is blocked on building it.**

---

## 1. What genesis actually is today

`src/agent/capture/siteGenesis.ts` — the driver behind `site.duplicate({newSite})` (T12.11).
It is **infrastructure genesis**, not editorial genesis. It does:

1. repo scaffold via `create-site.mjs --json`
2. Netlify site create + blob-store probe + auto-mintable secrets
3. build hook + `NETLIFY_BUILD_HOOK_URL`
4. deterministic env defaults (`TRACKING_PROJECT_ID=trk_<slug>`)
5. CMS-Agent registration (`project.create`, `<SLUG>_MCP_TOKEN` env **name** only)
6. derives and persists the tenant MCP endpoint `https://<site>/mcp`
7. mints + installs the Platform→CMS-Agent `CMS_AGENT_MCP_TOKEN` bearer, then discards the raw value

Everything past account authority is surfaced as an explicit human checklist (GitHub binding,
Netlify Identity, ADMIN_EMAILS, pdf-tool storage grant, DNS, …) — never silently skipped.

**It writes zero editorial objects.** No voice, no image style, no offer architecture, no content strategy.

## 2. Registered conductors — the complete list

`capture_conductor` · `clone_conductor` · `publishing_conductor` (+ `conductor` / `conductor_shell` scaffolding)

There is **no** `genesis_conductor` and no editorial-genesis workflow.
Grep for `genesis_conductor|genesisConductor|editorial.genesis|editorialGenesis` across `src`, `docs`, `ui`
returns nothing.

## 3. Editorial objects — what exists, what doesn't

| Object type | Status |
|---|---|
| `editorial_voice` | **Live** on Platform. drlurie's singleton is `voice_drlurie` (published). Read via `object_get {object_type:"editorial_voice", object_id}`. |
| `editorial_strategy` | **Does not exist.** Decided 2026-08-30, not built. |
| `visual_standard` | **Does not exist.** Decided 2026-08-30, not built. |
| `offer_architecture`, `content_strategy`, `image_style`, `pdf_templates`, `publish_policy` (as CMS objects) | **Do not exist** as object types. The plan's §2 diagram treats all of these as existing genesis outputs — they are not. |
| `plugin_manifest` | Greenfield. No reference anywhere in either repo. |

Voice plumbing that already works and should be reused, not reinvented:
- `src/agent/workspace/voicePrefetch.ts` — reads the live `editorial_voice` object, shape-checks it
  against the contract's required fields, warns and falls back to a seeded voice when the project
  declares no `objectDialect.voiceObjectId`.
- `src/agent/projects/projectTypes.ts:55–56` — `objectDialect.voiceObjectId` is the per-project pointer.
- `src/agent/projects/drLurie/editorialVoice.ts`, `src/agent/projects/fernwell/voice.ts` — per-project seeds.
- `src/agent/projects/projectHooks.ts:115` — the live-contract-body seam.

## 4. Where `emit_plugin_manifest` fits — and why it can't be placed yet

The plan's W4.1 says the node "runs after voice/image/offer objects are written". There is no node
that writes them, so there is nothing to run after.

Three placements, in order of how much I'd argue for them:

- **(a) Wait for `genesis_conductor` (recommended).** The 2026-08-30 decisions already commit to a
  `genesis_conductor` with option-card Q&A in the site's admin chat, plus the two new object types.
  `emit_plugin_manifest` is a natural terminal node there. W4 should be re-scoped as *"add the node
  once genesis_conductor lands"* and moved behind that work — **or the genesis_conductor becomes a
  precondition wave of this plan.**
- **(b) Hang it off `siteGenesis.ts`.** Wrong seam. That driver runs before any editorial object
  exists; the manifest would render from an empty voice and be immediately stale.
- **(c) Make it standalone and idempotent now.** A `plugin_manifest` renderer in Platform (W1) that
  reads whatever editorial objects exist and can be invoked from the admin UI (W5.1) — with
  `emit_plugin_manifest` added to genesis later as *one more caller*, not the only one.

**Recommendation: (c) for this cycle, (a) as the follow-on.** It decouples W1/W2/W3 from a workflow
that isn't built, lets the loop be proven on drlurie (whose `voice_drlurie` is live) this week, and
makes W4 a five-line node addition rather than a wave.

If you take (c), W4's acceptance test changes: *"run genesis dry-run on a throwaway tenant →
manifest exists"* becomes *"invoke the renderer against drlurie → manifest exists; re-invoke after a
voice edit → manifest changes"*. The genesis-lab/`site_duplicate` acceptance target moves to the
follow-on.

## 5. Constraints inherited from this repo

- Node **literal** changes require `npm run nodes:update` + redeploy. A new node is a literal change.
- Per-milestone commits; each task ships its own acceptance test.
- The publish charter (`section_template`/`template`/`theme`/`site`) is never widened.
- Mechanical publish tests must run through the main pipeline tools — a test-only wrapper tool is not
  a valid test (ruling 2026-08-27).
- The CMS-Agent workspace MCP is **not** the publishing backend; it drives the tenant MCP verbs
  through `project.call_tool`, a pure pass-through (`src/agent/projects/projectMcpAdapter.ts`).
  Argument shapes are therefore identical whether called directly or through the adapter.
- Cloud sessions can `git clone --depth 1` these repos but **cannot push**.

---

## Addendum — what W1 actually built (2026-08-31)

Option (c) from §4 was taken. The manifest renderer is **standalone and idempotent**, invoked from
the admin surface, with no dependency on a genesis workflow:

- `packages/core/server/lib/plugin/` — `manifest-types.ts`, `build-tools.ts`, `render-skill.ts`,
  `build-manifest.ts`, `manifest-store.ts`, `read-voice.ts`.
- `admin-plugin-manifest` (all four tenants) — `GET` reads the doc plus staleness; `POST render`
  renders a draft; `POST promote` makes it active.

`emit_plugin_manifest` therefore becomes **one more caller** of `buildManifestBundle` when
`genesis_conductor` lands, not a wave of its own. W4's acceptance test changes accordingly:
*"invoke the renderer against drlurie → a bundle exists; edit the voice → `GET` reports it stale"*.

Two deviations from the plan, both deliberate and both reversible:

1. **`plugin_manifest` is not a 13th governed object type** (plan D1). It is a derived document in
   its own blob store, following `governance-store.ts`. A governed type would bring locks, review, a
   publish gate and git export materialization — every render committing a file under
   `sites/<slug>/data/site/` and entering the release batch — for a document that is a pure function
   of its inputs. The reasoning is recorded at the top of `manifest-types.ts`.
2. **The endpoint is `/.netlify/functions/admin-plugin-manifest`, not `/api/plugin/manifest`**
   (plan W1 acceptance). Every admin endpoint in this repo is called at
   `/.netlify/functions/admin-*` with no redirect (`packages/core/lib/admin/*-client.ts`); inventing
   a second convention for one endpoint would be the odd one out. The `/api/plugin/*` prefix is still
   the right shape for the **W3.1 public façade**, which is a different surface with different auth.
