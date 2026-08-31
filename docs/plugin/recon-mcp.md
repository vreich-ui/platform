# W0.1 — Tenant `/mcp` recon (drlurie)

Read-only recon, 2026-08-31. Source: `vreich-ui/platform` @ shallow clone of `main`,
plus the live `Dr_Lurie_Skincare` MCP connector tool listing.
Scope: what the publishing plugin can actually call, and what the plan assumed that is not true.

**Verdict on the W0 acceptance question: the publish path is COMPLETE. No tool is missing.**
The blockers are elsewhere (attribution, per-tool policy) — see §4.

---

## 1. Where the surface is defined

| Concern | File |
|---|---|
| Tool schemas (part 1) | `packages/core/server/lib/mcp-tool-definitions.ts` (1118 ln) |
| Tool schemas (part 2) | `packages/core/server/lib/mcp-tool-definitions-2.ts` (570 ln) |
| Tool schemas (membership) | `packages/core/server/lib/mcp-tool-definitions-membership.ts` (304 ln) |
| Dispatch + auth + tool visibility | `packages/core/server/functions/mcp.ts` (1560 ln) |
| Handlers | `packages/core/server/lib/mcp-tool-handlers.ts` (2143 ln) |
| Object-verb principal resolution | `packages/core/server/functions/object-store.ts` |
| **The behavioural rulebook** | `docs/agents/publishing-policy.md` — authoritative, cites enforcing code |

drlurie is **root-deployed**: it has no `sites/drlurie/netlify/functions/`. The root
`netlify/functions/mcp.ts` *is* the drlurie tenant endpoint (`https://drluriescience.netlify.app/mcp`).
The other three tenants (platform, zilberman, fernwell) each carry their own copy under `sites/<slug>/netlify/functions/`.
All four re-export the same shared core, so **the tool surface is tenant-generic already** — good for the plan's
"built tenant-generic" premise.

## 2. Tool inventory (86 names declared)

Grouped by what the plugin needs.

**Object lifecycle (the publish path)**
`object_contract` · `object_inventory` · `object_list` · `object_get` · `object_validate` ·
`object_create` · `object_create_variant` · `object_checkout` · `object_patch` · `object_refresh_lock` ·
`object_publish` · `object_checkin` · `object_discard` · `object_retire` ·
`object_instantiate_template` · `object_instantiate_section_template`

**Review verbs (exist, dormant for `content_item`)**
`object_submit_review` · `object_review_decide`

**Release / verification**
`release_to_production` · `deploy_status` · `trigger_netlify_build` · `verify_article_images` · `ping` · `capability_status`

**Media (PDF-Tool bridge, server-side — no bytes over MCP)**
`create_agent_artifact_job` · `get_agent_artifact_job_status` · `resume_agent_artifact_job` ·
`get_agent_artifact_by_slot` · `get_artifact_metadata` · `search_artifacts` · `list_artifacts_by_kind` ·
`list_artifacts_by_request` · `list_artifacts_for_request` · `search_images` · `import_image_from_url` ·
`import_images_from_url` · `get_image_search_job_status` · `get_image_search_bank` ·
`get_image_search_policy` / `set_image_search_policy` · `get_image_model_policy` / `set_image_model_policy` ·
`update_image_search_candidate` · `create_capture_job` · `get_capture_job_status` · `get_capture_snapshot`

**PDF templates**
`create_pdf_template` · `get_pdf_template` · `list_pdf_templates` · `validate_pdf_template` ·
`get_pdf_template_validation` · `publish_pdf_template` · `delete_pdf_template`

**Registry / theme / commerce / membership** (out of plugin scope)
`registry_get` · `site_apply_theme` · `product_set_price` · `commerce_orders` · `order_reissue` ·
`ownership_transfer` · `member_*` (13) · `invitation_*` (2) · `membership_*` (3) · `marginalia_*` (4)

**Internal-only / not exposed** (filtered out of `tools/list`)
`save_artifact` · `restore_artifact` · `soft_delete_artifact` · `create_artifact_from_url` ·
`create_artifact_upload_intent` · `migrate_artifact_indexes` · `reconcile_artifact_indexes` ·
`wipe_blob_stores` · `membership_status` · `get_agent_artifact_by_filename`
*(the live connector listing confirms these are absent from the OAuth surface)*

## 3. ⚠️ The plan's assumed tool names do not exist

Execution plan §2 names the publishing contract as
`article.create_draft`, `article.patch`, `media.attach`, `article.submit_review`, `article.publish`,
`site.get_context`, `article.get`.

**None of these exist.** There is no `article.*` or `media.*` namespace and no dotted names at all.
The real contract, from `docs/agents/publishing-policy.md` §4:

```
0.  pick request id        req_<flow>_<topic>_<yyyymmdd>_<nn>   (never auto-generated)
1.  object_inventory / object_list      reuse-first check
2.  create_agent_artifact_job → get_agent_artifact_job_status    media FIRST, fail-closed
3.  object_create           content_item, object_id = request id, pass agent_name
4.  object_checkout         lock, 900 s lease
5.  object_patch            node upserts, taxonomy, seo, hero — media as PUBLIC /img/… /pdf/… paths only
6.  object_validate         dry-run the exact candidate patch
7.  object_publish          dark commit '[skip netlify]', production.live:false — free, invisible
8.  (repeat 3–7 per article)
9.  release_to_production   ONCE per batch — the only paid step
10. deploy_status {commit}  poll 10–15 s to deployStatus:"ready" AND productionConfirmed:true
11. verify_article_images   {url, expectedImages, expectedDocuments, commit}
12. object_checkin          release lock
```

Read-before-write discovery tools (these replace `site.get_context`):
`object_contract {object_type}` → body schema, allowed patch ops, constraints, `publish_policy`,
`creation_policy`, `media_policy`, workflow sequence, error catalog, **and `aggression_ceiling`**.

**Action for W1:** rewrite the plan's §2 publishing contract against these names before `tools.json` is built.

## 4. Findings that block or change the plan

### 4.1 D3 (`actor=plugin:<platform>`) — implementable, with one gap. **Decide this.**

⚠️ `publishing-policy.md` §8.5 (dated 2026-07-22) says `agent_name` is forwarded "only on the
create-family verbs". **That doc is stale.** The 2026-08-28 object-lock attribution fix widened it.
Verified against `mcp.ts` at HEAD:

**`agent_name` IS forwarded** (`CMS_AGENT_NAME_ATTRIBUTION_TOOLS`, `mcp.ts:797–812`):
`object_create` · `object_create_variant` · `object_instantiate_template` ·
`object_instantiate_section_template` · `site_apply_theme` · `product_set_price` · `order_reissue` ·
`object_checkout` · `object_refresh_lock` · `object_checkin`

**`agent_name` is NOT forwarded**: `object_patch` (`mcp.ts:1198–1205`) · `object_publish`
(`mcp.ts:1206–1224`) · `object_validate` · `object_submit_review` · `object_review_decide` ·
`object_discard` · `object_retire` · `release_to_production`.

The store records `actor: principal` on every history entry including publish
(`object-verbs.ts:982,1518–1945`; `object-publish.ts:102,343`), and the principal is derived from
`agent_name` with a `'unattributed-agent'` fallback (`object-store.ts:79–80`). drlurie's own policy
file states it plainly: *"Every publish — autonomous or approved — still writes the full audit trail
(actor, patch + inverse, receipt)."*

So: **create, checkout, checkin and lock refresh will carry `actor=plugin:claude` with zero code.**
The publish row itself will not.

**But `object_publish` has a `producer` field** (`mcp-tool-definitions-2.ts:445–472`) —
`{run_id, node_id, prompt_version, model}`, all four required when present, *"recorded in publish
history and the derived export."* That is a legitimate, already-built attribution seam:

```
producer: { run_id: "plugin_<platform>_<request_id>",
            node_id: "plugin:<platform>",
            prompt_version: "<manifest_version>",
            model: "<the chat app's model>" }
```

Three options:
- **(a) `agent_name` + `producer`, zero server code.** Create/lock rows carry `agent_name`;
  publish rows carry `producer.node_id = "plugin:claude"`. Two field names for one concept —
  slightly ugly, ships today, and `manifest_version` rides along for free (solves the §5 skill-drift
  risk in the plan's Risks list).
- **(b) Also thread `agent_name` through `object_patch` + `object_publish`.** ~1 hour, contained,
  benefits every agent. One consistent field everywhere.
- **(c) Both.** Do (a) now so W2 is unblocked; add (b) as a small W1.0.

**Recommendation: (c).** Ship (a) in W1 so the W2 acceptance test can be run this week, and land (b)
as W1.0 in the same patch — the plugin then reads one field and the ledger stops lying about who
patched.

### 4.2 A per-tool policy taxonomy exists; per-*client* enforcement on the MCP path does not

> **Amended 2026-08-31 (W0.3).** Every tool definition carries
> `governance: { toolClass, autonomyFloor?, preview? }` with
> `toolClass ∈ read | draft | creation | publication | privileged | membership`
> (`mcp.ts:276–289`). It is consumed by the admin-chat registry (`agent/registry.ts`,
> `agent/generated-tools.ts`); `mcp.ts` declares the type but does not enforce it on the MCP path.
> **W1.3 should derive `tools.json` from `governance.toolClass` instead of hand-maintaining an
> allowlist** — see `legacy-gpt.md` §A.5. The rest of this section stands.

What exists:
- `visibleToolDefinitions(event)` (`mcp.ts:1338–1348`) filters on exactly three things: internal-only
  tools, optional-handler tools, and membership tools (OAuth **human** principals only). There is no
  per-tenant or per-client tool allowlist.
- `publish_policy` (`packages/core/lib/registry/object-contract.ts:825–1153`, master posture in
  `src/config/approval-policy.ts`) gates **per object type**, not per tool: master `all-autonomous`;
  `product` requires approval; **`content_item` is Tier-1 autonomous today** — articles go
  checkout → patch → `object_publish` directly with **no review verbs in the path**.

Consequences:
- W1.3's `tools.json` is an **advisory client-side allowlist** — the model is asked not to call a
  tool, the server will still answer it. That is fine for a human-driven plugin; it must not be
  described as enforcement.
- The plan's publishing contract includes `article.submit_review`. For `content_item` the review
  verbs are **dormant**. Drop that step from the plugin's procedure; keep `object_submit_review`
  documented in `skill.md` for when the posture flips (`publishing-policy.md` §8.6).
- W3.3's "mechanical test must include a `manual` policy case that halts" **does have a real case.**
  drlurie's committed posture (`sites/drlurie/config/approval-policy.ts`) is
  `master: 'all-autonomous'` with two overrides: `product: 'require-approval'` and
  **`editorial_voice: 'require-approval'`** (D1, 2026-07-28 — "one silent change moves all downstream
  output at once"). So an `editorial_voice` publish attempt from the plugin halts at the gate today,
  with no posture flipping and no test-only wrapper. Use that as W3.3's manual case.
- Corollary for the plugin's charter: **the plugin must never try to edit the voice object.** It
  reads `editorial_voice` and writes `content_item`. Put that in `skill.md` as a hard rule and leave
  `editorial_voice` write verbs out of `tools.json`.

### 4.3 `aggression_ceiling` is a hard constraint on the Magnetic Marketing skill

`object_contract{content_item}` returns `aggression_ceiling` — four dials in `[0,1]`:
`claim_strength`, `urgency`, `emotional_agitation`, `cta_density`. Source of truth is the committed
`sites/<client>/config/site-identity.ts`. It is a **ceiling, not a target**. An absent ceiling is a
blocker by design — `object_contract` throws rather than return a contract without one.

W1.2's `skill.md` renderer must read this per tenant and write it into the skill as an explicit
bound on the copy method. A DTC copy skill that ignores it will produce copy the site's own
policy forbids.

## 5. Auth — what the connector cards need

- **OAuth** (the intended path): full OAuth server at `netlify/functions/mcp-oauth.ts`; principals
  resolve to a Netlify Identity **human** + client id (`mcp.ts:237–244, 1524`). Membership tools are
  visible only to these. Realm = the site slug.
- **Shared bearer** `MCP_HTTP_AUTH_TOKEN` and **per-agent verified tokens** — server-to-server.
- **URL-borne token** `?key=<token>` (W14 F9) exists *specifically* because "claude.ai's
  custom-connector form takes a URL and OAuth credentials — there is NO field for a shared bearer"
  (`mcp.ts:344–348`). Useful fallback for a W2 connector card, but it puts a secret in a URL —
  prefer OAuth for the plugin and keep `?key=` for diagnostics only.
- **Audience pinning is the #1 connector failure mode.** A token minted through a host not in the
  deploy's accepted-audience list is refused forever and is invisible client-side.
  `GET /mcp?health=auth` (unauthenticated) reports `accepted_audiences` and
  `token_store_reachable`. **Put this URL on the W2.3 / W3.4 CFG cards.**
- Liveness: `GET /mcp?health=1`. Cold-start diagnostics: `ping`.

## 6. Confirmations for the plan (no change needed)

- **D4 holds.** Bytes never travel over MCP. Media is made server-side by PDF-Tool and referenced by
  public path `/img/{id}/{sha}.ext` or `/pdf/{id}/{sha}.pdf`. Agents never mint storage keys.
- **Publish ≠ release.** `object_publish` is free and invisible (`[skip netlify]`); a single
  `release_to_production` per batch is the only paid step. The plugin's procedure must batch.
- **Tenant-generic is real.** One shared core serves all four tenants; a renderer keyed on tenant
  slug will work without per-tenant server code.
- **Stale docs to avoid**: `docs/agents/publishing-instructions.md`, `mcp-final-agent-sequence.md`,
  `mcp-article-body-v1.md` describe the frozen `save_json_blob_*` pipeline. `publishing-policy.md`
  supersedes them and says so.
