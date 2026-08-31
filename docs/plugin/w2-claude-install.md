# W2.3 — Claude install runbook (CFG)

Operator steps for the Claude export. **These belong in a config session, not a code session.**
Nothing here is automated by W2, and nothing here needs a deploy.

Tenant: **drlurie** — `https://drluriescience.netlify.app`. Every step is tenant-generic; swap the
origin for another tenant.

---

## 1. Produce the bundle (admin, 30 seconds)

`POST /.netlify/functions/admin-plugin-manifest {"action":"render","platform":"claude"}`
→ then `{"action":"promote"}`.

Exports serve the **active** bundle only, so the promote is the review step: a draft is a proposal,
and shipping one straight to org skills would put an unreviewed skill in front of the team.

Then download either or both:

| what | URL | install where |
|---|---|---|
| Skill zip | `…/admin-plugin-manifest?export=skill` | Claude org skills |
| Cowork plugin | `…/admin-plugin-manifest?export=plugin` | Cowork — installs the skill *and* the connector in one file |

Both carry `X-Plugin-Manifest-Version`. That string is what you compare against the live manifest
when an install looks stale.

**If you install the `.plugin`, skip step 2** — its `.mcp.json` already points at the tenant
endpoint. Step 2 is for the skill-zip path, or for a Claude org that wants the connector available
outside the plugin.

## 2. Add the custom connector (org owner, once)

Organization settings → Connectors → Add custom connector.

| field | value |
|---|---|
| Remote MCP URL | `https://drluriescience.netlify.app/mcp` |
| OAuth | **always required** |

Members then click **Connect** and sign in once. The endpoint refuses anonymous calls, so there is
no "works without auth" state to be confused by.

⚠️ **Do not use the `?key=<token>` URL form.** It exists for diagnostics and puts a shared secret in
a URL. OAuth is the path for anything a human installs.

## 3. Set the publish tools to *Ask* for the first week

Per-tool Allowed/Ask/Blocked controls give you a manual mode with **no code change** — which is
worth knowing, because there is no per-client per-tool policy on the server (W0.1 §4.2).

Set to **Ask**: `object_create`, `object_patch`, `object_publish`, `release_to_production`.
Leave reads on Allow. Loosen once you trust the output.

## 4. When authorization fails — check this first

Open **`https://drluriescience.netlify.app/mcp?health=auth`** (no auth needed). It answers the two
questions the Netlify logs would otherwise cost you twenty minutes to reach:

- `accepted_audiences` — a token minted through a host **not** in this list is refused **forever**,
  and the failure is invisible client-side and looks exactly like a bad credential. This is the top
  connector failure mode.
- `token_store_reachable` — a governance-store outage refuses every token while also looking like a
  wrong password.

Liveness only: `…/mcp?health=1`. Cold-start timing: the `ping` tool.

## 5. Acceptance — the W2 exit test (record the result)

From a **fresh** Claude chat with the skill and connector attached:

1. Ask for one short drlurie article. Confirm it reads the voice at session start rather than
   writing from memory.
2. Confirm it drafts in blocks with a single CTA, and stays under the aggression ceiling.
3. Confirm it ends with a Sources block, and **warns** rather than blocking when a claim is
   unsourced.
4. Say "publish". Watch for: media produced first and fail-closed → `object_create` → checkout →
   patch → validate → `object_publish` (dark) → checkin → *it asks before releasing*.
5. Release. Poll to `deployStatus:"ready"` **and** `productionConfirmed:true`.
6. `verify_article_images` comes back `deployReady:true`.
7. Open the live URL.

**Then check the ledger.** The object history should show `plugin:claude` on create, checkout,
patch, checkin and publish — that is W1.0 — and the publish record should carry
`producer.node_id = "plugin:claude"` with `prompt_version` equal to the `X-Plugin-Manifest-Version`
you installed.

If any step fails, the failure is the useful output — record which step and what the error code was.

## 6. Known-good expectations (do not "fix" these)

- First `release_to_production` returning `build_not_confirmed_live` — poll `deploy_status`, do not
  re-release.
- `verify_article_images` returning `inconclusive` before the deploy is live — retry; only
  `deployReady:true` is definitive.
- `build_ready_not_published` / `productionConfirmed:false` — Netlify auto-publishing is locked and a
  **human** must unlock it. Stop and report; do not trigger more builds.
- A `{idempotent:true}` 200 from `object_checkin` on a lock-less record is an acknowledgement.

## 7. Re-exporting

`GET /.netlify/functions/admin-plugin-manifest` reports `stale` with a reason whenever the voice
record version, the tool-surface digest or the approval posture has moved since the active bundle
was rendered. When it does: render → promote → re-download → re-upload the skill.

Installed exports do not update themselves. `manifest_version` is how you tell which revision a team
member is actually running.
