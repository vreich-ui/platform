# 20 — Publishing plugin

The per-tenant plugin that lets a human drive Claude, ChatGPT or Gemini to write in a publication's
voice and publish to its CMS. Built W0–W5, Aug 2026.

The plan's W5.3 called this an "ARCHITECTURE.md section"; this repo has no such file, so it lands as
the next numbered plan doc instead.

---

## 1. What it is, and what it is not

**Is:** a bundle — a rendered skill, a derived tool list, and a connection card — generated per
tenant from live CMS state, exported in three platform shapes, and installed by a human into their
own chat app. The human drives every session.

**Is not:** the autonomous plane. The CMS-Agent publishing workflow is a separate thing and is
untouched by this. These two planes now both write articles, on purpose (§4).

## 2. The pieces

```
editorial_voice ─┐
site identity    ├─→ buildManifestBundle() ─→ plugin-manifest blob (draft | active)
tool definitions ┘                                    │
approval posture                                      ├─→ skill zip          (Claude org skills)
                                                      ├─→ .plugin bundle     (Cowork: skill + connector)
                                                      ├─→ GPT config zip     (instructions + knowledge)
                                                      ├─→ Gem instructions   (drafting only)
                                                      └─→ /api/plugin/openapi.json  (ChatGPT Actions)

tenant /mcp  ◄── Claude connector, Cowork .mcp.json
/api/plugin/<tool>  ──► the same /mcp handler, same OAuth  ◄── ChatGPT Actions
```

| concern | where |
|---|---|
| Manifest types, store, builder, staleness | `server/lib/plugin/{manifest-types,manifest-store,build-manifest}.ts` |
| Skill renderer | `server/lib/plugin/render-skill.ts` |
| Derived tool list | `server/lib/plugin/build-tools.ts` |
| Exports | `server/lib/plugin/export-{claude,openai,gemini}.ts`, `zip.ts` |
| Actions schema | `server/lib/plugin/build-openapi.ts` |
| Admin API | `server/functions/admin-plugin-manifest.ts` |
| Actions façade | `server/functions/plugin-actions.ts` |
| Admin page | `admin/PluginsPage.tsx` + `lib/admin/plugins-client.ts` |

## 3. Decisions worth knowing

**The manifest is a derived document, not a governed object type.** The plan (D1) proposed a 13th
`objectTypes` entry. A governed type brings locks, review, a publish gate and git export
materialization — every render committing a file under `sites/<slug>/data/site/` and joining the
release batch — for something that is a pure function of voice + ceiling + tool surface + posture.
It lives in its own `plugin-manifest` blob store with a draft/active pair, following
`governance-store.ts`. Promoting it to a governed type later is additive.

**The tool list is derived from `governance.toolClass`, not hand-maintained.** Every tool definition
already carries its own risk class; the plugin allowlist is a filter over it plus a short, reasoned
denylist. `x-openai-isConsequential` is computed from the same field.

**`tools.json` is advisory on `/mcp` and enforcement on the façade.** `visibleToolDefinitions`
filters only internal-only / optional-handler / membership tools — there is no per-client tool
allowlist on the MCP path, so a Claude connector can call anything the tenant exposes. The façade,
by contrast, refuses a tool outside the active charter with 403 `tool_not_in_plugin_charter`. Do not
describe the Claude-side list as a permission boundary; it describes the job.

**The façade adds no business logic and no second auth surface.** It wraps a call in a JSON-RPC
`tools/call` and hands it to the exported `/mcp` handler with the Authorization header untouched.
Every gate runs in the path `/mcp` uses, because it is that path.

**Exports serve the active bundle only.** A draft is a proposal; promoting is the review step. This
is why the Actions schema 409s until something is promoted.

## 4. ART-1 — a deliberate exception, recorded

`object_create` for `content_item` is refused in admin chat (ART-1). The reasoning is sound: a new
article should come from the publishing workflow, which produces the sourcing/claim/compliance
record ART-2 wants **and applies the aggression ceiling**, which is enforced on that path and no
other.

**The plugin does not go through that path.** It creates and publishes `content_item` directly over
the object verbs. That is a ruling, not an oversight (Wolf, 2026-08-31): *"otherwise I would not
need this plane at all"* — the value is any LLM being able to publish directly.

What that costs, stated plainly so nobody rediscovers it as a bug:

- **No judgement substrate.** The plugin writes no claims/scores/compliance record. `article_claim_substrate`
  warns on every plugin article, permanently, and cannot be cleared by supplying sources — only a
  `claims` array satisfies it, and the skill forbids writing one (a high-risk claim without
  verification would block the publish outright).
- **The ceiling is honour-system.** The skill reads it, writes it into itself as an explicit bound,
  and states that nothing enforces it. Nothing does.

The mitigation today is that the plugin is human-driven: the editor is the gate. The follow-on, if
this ever loosens, is server-side ceiling enforcement in `object_validate` so every hand-authored
path is clamped regardless of actor.

## 4a. OpenAI ships in two shapes (ruling, 2026-09-01)

W0.3 closed by capturing the live publisher: it is a **ChatGPT Agent (Agent Studio)**, not a classic
Custom GPT, attaching the tenant `/mcp` directly as an App. Both shapes are now supported; neither is
optional.

| | Custom GPT | Agent Studio |
|---|---|---|
| Connection | Actions façade `/api/plugin/*` | tenant `/mcp` attached directly as an App |
| Tenant layer | instructions (≤8k) + knowledge files | operational instructions + the skill zip |
| Charter | **enforced** — 403 outside it | advisory only |
| Distribution | share link / workspace / store; runs on the installer's own plan and credits | invite-only; runs on the invitee's seat |
| Composability | @-mentionable beside other GPTs | bridge mode: paste content in |
| Ledger actor | `plugin:openai-gpt` | `plugin:openai-agent` |

One export (`?export=gpt`) carries both, as `gpt/` and `agent/`. The tenant-specific content is
authored ONCE in the skill renderer: `gpt/` gets a projection under the 8k cap, `agent/` gets the
skill itself retargeted to its own actor. There is no hand-maintained duplicate.

**The actor ids are the point.** Two surfaces with different enforcement guarantees must be separable
in publish history, or the ledger cannot answer why one article reads differently from another.

**The installer is the install unit.** Both shapes authenticate the human over OAuth. Installing for
a tenant owner means `member_invite` with `publisher` or `editor` FIRST — an installer with no
account attaches the tools successfully and then fails every write, which reads as a broken
connector. The admin page makes this step one.

## 4b. What the chat plane is not for

A publication-wide job — re-voicing every article, a batch refresh — is twenty-plus
lock/patch/publish cycles with a per-tool confirmation on each, in one conversation. That is fragile
on every surface, and it is not what this plane is for.

- **Chat plane** (this plugin): one article, or a handful.
- **CMS-Agent publishing workflow**: publication-wide batches.

The skill and both OpenAI shapes carry this rule and are instructed to hand off rather than start,
offering a single article as a sample instead.

## 5. Attribution

`agent_name` reaches create, the lock verbs, and — since W1.0 — `object_patch` and `object_publish`.
`object_publish` additionally carries `producer {run_id, node_id, prompt_version, model}`, recorded
in publish history; `prompt_version` is the `manifest_version`, so a published article points at the
exact skill revision that wrote it.

**Tool annotations (2026-09-01).** `tools/list` now emits MCP `annotations` derived from
`governance.toolClass` — `readOnlyHint` for reads, `destructiveHint` only for the tools that really
remove or overwrite, `idempotentHint` only where an `idempotency_key` is actually implemented, and
`openWorldHint` for the tools that reach outside the tenant. This was found by capture: the live
Agent reported **"Read actions: none"** and confirmed every `object_get`. The same change stops
`tools/list` leaking the internal `governance` field into a protocol response. A client holding a
cached tool list needs re-attaching to see it.

⚠️ **A deployed schema is not a reachable one.** A remote MCP client caches tool schemas. The W2
acceptance run found `object_patch` still advertised without `agent_name` after the change was live,
and refreshing the connector's tool *list* did not re-read the changed schema. `producer` does not
depend on this and is the reliable seam.

## 6. Staleness

`sources` records the voice record version, the tool-surface digest and the approval posture.
`manifestStaleReasons` compares them against live; the admin page shows each drift by name.
Installed exports never update themselves — `manifest_version` is how you tell which revision a team
member is running.

## 7. What is not built

- **W4, genesis integration.** There is no `genesis_conductor` and no editorial-genesis workflow in
  CMS-Agent; of the objects the plan assumed (`editorial_strategy`, `visual_standard`,
  `offer_architecture`, `content_strategy`, `pdf_templates`), only `editorial_voice` exists. The
  renderer was deliberately built standalone and idempotent so `emit_plugin_manifest` becomes one
  more caller rather than a wave of its own.
- **Gemini tool calling.** A Gem has no custom tool calling, so the Gemini export is drafting-only
  by construction (plan D6). The instructions say so in their first paragraph, because a
  half-capable export whose model claims to have published is worse than none.
- **Retiring the legacy ChatGPT bridge.** Still needs the one W0.3 item never answered: how the
  existing Custom GPT is attached, and which credential it holds.

## 8. Runbooks

- `docs/plugin/w2-claude-install.md` — Claude connector + skill, and the `?health=auth` triage.
- `docs/plugin/w3-chatgpt-install.md` — Actions import, OAuth, and testing the refusal.
- `docs/plugin/w2-acceptance-2026-08-31.md` — the live end-to-end run and its four defects.
- `docs/plugin/recon-mcp.md`, `recon-genesis.md`, `legacy-gpt.md` — the W0 recon this was built on.
