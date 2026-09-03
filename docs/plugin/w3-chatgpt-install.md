# W3 — ChatGPT install runbook (CFG)

Operator steps for the two OpenAI shapes. **These belong in a config session, not a code session.**
Nothing here is automated, and nothing here needs a deploy.

Tenant: **drlurie** — `https://drluriescience.netlify.app`. Every step is tenant-generic; swap the
origin for another tenant. Per-tenant copies of the two setup cards ship inside the download itself
(`gpt/actions-setup.md`, `agent/app-setup.md`) with the tenant's own URLs already filled in — this
doc is the operator's view across both, plus the refusal test, which is the part no card covers.

---

## 0. Which shape

Both are supported; they are not alternatives.

| | **Custom GPT** (`gpt/`) | **Agent Studio** (`agent/`) |
|---|---|---|
| Reaches the tenant via | the Actions façade, `/api/plugin/*` | the tenant `/mcp`, attached as an App |
| Charter | **enforced by the server** — an out-of-charter tool is refused 403 | advisory; the App exposes the whole tool list |
| Distribution | share link / workspace / store; runs on the installer's plan | invite-only in the workspace; runs on the invitee's seat |
| Ledger actor | `plugin:openai-gpt` | `plugin:openai-agent` |
| Best for | distributed tenant-owner installs | power use, long multi-step runs |

**Before either:** the installer needs an identity on the tenant. Invite them as `publisher` or
`editor` first. Both shapes authenticate the human over OAuth, and an installer with no account can
attach every tool and then be refused on every write.

## 1. Produce the bundle (admin, 30 seconds)

On `/admin/plugins`: **Render**, then **Promote**, then **Download OpenAI config**. Exports serve
the *active* bundle only, so the promote is the review step.

The zip carries both shapes. It also carries `agent/<skill-name>-skill.zip`, the ready-to-upload
skill archive — see §3.

---

## 2. Custom GPT — Actions import and OAuth

**Schema.** GPT Builder → Actions → **Import from URL**:

    https://drluriescience.netlify.app/api/plugin/openapi.json

The document is generated from the live tool surface intersected with the charter, so it cannot
drift from what the tenant accepts. Re-import after any re-export.

**Authentication.** ChatGPT needs a *static* client id and secret, so register a client ONCE against
the tenant's authorization server and paste the pair into GPT Builder:

| field | value |
|---|---|
| Authorization URL | `https://drluriescience.netlify.app/oauth/authorize` |
| Token URL | `https://drluriescience.netlify.app/oauth/token` |
| Client registration (once) | `https://drluriescience.netlify.app/oauth/register` |
| Scope | **leave empty** |
| Token exchange method | POST |

⚠️ **Do not invent a scope.** The authorization server defines no plugin-specific scopes; sending an
unknown one fails in a way that looks exactly like a bad credential. If scopes are ever introduced,
read them from `/.well-known/oauth-authorization-server`.

---

## 3. Agent Studio — App, tools, skill

**Attach.** Apps → Browse apps → add an MCP server at `https://drluriescience.netlify.app/mcp`,
OAuth as yourself. Check the URL in the detail pane before attaching; near-duplicate saved
connectors accumulate.

**Settings.** Account: *Agent-owned* (one identity for everyone) or *End-user* (each person under
their own tenant identity). Action safety: **Allow low-risk actions** — see §5.

**Tools.** A fresh attach turns everything on. Keep the three artifact-bridge tools
(`create_agent_artifact_job`, `get_agent_artifact_by_slot`, `get_agent_artifact_job_status`) — they
replace a direct PDF-Tool attachment — and switch off PDF-template authoring and marginalia.

**Do not attach a direct PDF-Tool MCP app.** The tenant bridges that service server-side and mints
the storage grant itself; a direct attachment adds nothing and exposes `set_storage_grant` to the
model.

**Skill.** Skills → Add skill → **Upload skill** → **Upload .zip file** → pick
`agent/<skill-name>-skill.zip` from the bundle. Agent Studio wants a `.zip` whose ROOT is
`SKILL.md`; handing it the whole config bundle is refused with *"This archive isn't a supported GPT
export or plugin: it lacks `gizmo.yaml` and a plugin manifest"*, which reads like a broken tenant
and is only the wrong zip shape.

**Instructions.** Paste `agent/operational-instructions.md`. If the agent already has instructions,
merge rather than replace. The field applies Markdown as you type, so **paste** the Attribution
block rather than typing it — a line with several underscores turns into italics and the
underscores vanish.

**Agent Studio does not autosave.** It counts pending changes in the header and holds them until you
press **Update**.

---

## 4. Test the refusal

This is the part worth doing, because it is the only proof that the charter is a boundary rather
than a description. **The façade checks the charter BEFORE authentication**, so every probe below
runs with no credential at all.

Verified against live drlurie, 2026-09-03:

| probe | expected |
|---|---|
| `GET /api/plugin/openapi.json` | **200** — the schema is public by design |
| `POST /api/plugin/openapi.json` | **405** |
| `GET /api/plugin/object_get` | **405** — tools are POST-only |
| `POST /api/plugin/object_get` (no token) | **401** — in charter, so it reaches auth |
| `POST /api/plugin/wipe_blob_stores` (no token) | **403** `tool_not_in_plugin_charter` |
| `POST /api/plugin/not_a_tool` (no token) | **403** `tool_not_in_plugin_charter` |

```console
$ curl -s -X POST -H 'content-type: application/json' -d '{}' \
    https://drluriescience.netlify.app/api/plugin/wipe_blob_stores
{"ok":false,"error":"\"wipe_blob_stores\" is not in this plugin's charter.",
 "error_code":"tool_not_in_plugin_charter",
 "manifest_version":"dr-lurie-claude-20260903-f3506d7e"}
```

Two things to read off that. `wipe_blob_stores` is a **real** privileged tool on this tenant, not a
made-up name — the refusal is the charter working, not a 404 in disguise. And because the 403 lands
before auth, a leaked token cannot widen the charter: the only way to add a tool is to re-render and
re-promote a manifest.

An unknown tool name is refused the same way rather than 404ing, which is the right shape: the
charter is an allowlist, so "not in it" is the whole answer.

**Agent Studio has no equivalent.** Its App exposes the entire tool list and the charter is
advisory there — the skill describes the job rather than a boundary the server enforces. That is
the trade for the shape's extra reach, and it is why the Custom GPT is the shape to distribute.

---

## 5. Known issue — "No read actions"

Agent Studio lists every tool under **Write actions**, including `object_get`, `object_contract` and
`ping`, and reports *"No read actions are available for this app."* **Detaching and re-attaching
does not clear it** — tested against a clean re-attach on 2026-09-03.

The tenant is not at fault, and you can prove it with no credential:

```
GET https://drluriescience.netlify.app/api/plugin/openapi.json
  /api/plugin/object_get        x-openai-isConsequential: false
  /api/plugin/object_contract   x-openai-isConsequential: false
  /api/plugin/object_publish    x-openai-isConsequential: true
```

That flag and the MCP `annotations.readOnlyHint` come from one field on the tool definition. Agent
Studio ignores the hint. Set Action safety to **Allow low-risk actions**: with the Read bucket
empty, the stricter setting confirms every single call.

---

## 6. When authorization fails, check this first

    https://drluriescience.netlify.app/mcp?health=auth

No auth needed. Live shape:

```json
{"ok":true,"oauth":{"realm":"dr-lurie",
 "accepted_audiences":["https://drluriescience.netlify.app/mcp"],
 "token_store_reachable":true}}
```

- `accepted_audiences` — a token minted through a host **not** in that list is refused permanently,
  and client-side it is indistinguishable from a wrong password. Apex vs `www.`, a custom domain, a
  deploy alias: all different audiences.
- `token_store_reachable` — false means a store outage is refusing every token, which also looks
  like a bad credential.

## Related

- `docs/plugin/w2-claude-install.md` — the Claude connector and skill.
- `docs/plugin/w6-acceptance-2026-09-03.md` — the live end-to-end run from Agent Studio.
- `docs/cms-architecture/20-publishing-plugin.md` — the design this implements.
