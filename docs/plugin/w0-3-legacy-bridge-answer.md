# W0.3 closed — legacy bridge answer + plan corrections (2026-09-01, rev 2)

Source: read-only capture of ChatGPT → Agents → "Dr. Lurie Skincare" (agt_6a6cb3e7ff8c8191af4cb69d1f682422). Full capture attached as `docs/plugin/legacy-gpt.md`.

## The answer
- The existing publisher is a **ChatGPT Agent (Agent Studio)**, not a classic Custom GPT.
- It attaches MCP servers **directly** as Apps: `https://drluriescience.netlify.app/mcp` (tenant, agent-owned OAuth account, "Allow low-risk actions") and PDF-Tool MCP 2.0. No Actions/OpenAPI, no third-party bridge.
- It carries 15 editorial skills, a Slack channel (Kugelbrands), memory, and operational instructions (bridge mode, effort levels, publish/release/verify separation).
- Sharing: "Only those invited."

## Ruling (Wolf, 2026-09-01): OpenAI ships in TWO shapes — both supported, neither optional

| | A — Custom GPT (classic) | B — Agent (Agent Studio) |
|---|---|---|
| Connection | **Actions façade** `/api/plugin/*` (W3, stays on the critical path) | tenant `/mcp` attached directly as an App |
| Tenant layer | instructions (≤8k) + knowledge files | operational instructions + **skill zip** (same SKILL.md as Claude) |
| Distribution | share link / workspace / GPT store; runs on the **installer's own plan and credits**; each installer OAuths to the tenant as themselves | invite-only inside the workspace; runs on the invitee's seat |
| Composability | **@-mentionable** in one chat next to public GPTs (e.g. a Kennedy consulting GPT drafts → `@Dr Lurie Publisher` publishes) | bridge mode: paste-in content from another chat |
| Enforcement | façade refuses tools outside the charter (403) | advisory only |
| Best for | distributed tenant-owner installs; mixing with public GPTs | Wolf/team power use; long multi-step runs |

Consequences:
1. `export-openai.ts` emits **both** bundles: `gpt/` (instructions.md, knowledge/*.md, actions card with OpenAPI URL + OAuth) and `agent/` (operational-instructions.md, skill.zip, MCP-app card with `/mcp` URL + `?health=auth` triage).
2. Tenant-specific content (voice, MM-within-ceiling, funnel dial, sources rule, publish sequence) is authored ONCE in the skill renderer; the GPT `instructions.md` is a rendered projection of it (≤8k), the Agent gets it as the skill. No hand-maintained duplicate.
3. W3.4 → "update the existing agent in place": swap instructions, attach the tenant skill, **remove the PDF-Tool MCP 2.0 app** (tenant `/mcp` already bridges pdf-tool with server-side grants; the direct app exposes `set_storage_grant` to the model for nothing). CFG, Wolf executes.
4. Tool safety: the agent shows "Read actions: none" — every tool is classed write. If `governance.toolClass` distinguishes reads, surface it (MCP `readOnlyHint` annotation) so ChatGPT stops confirming `object_get`/`object_contract`. Check, then small fix.
5. **Per-installer identity is the install unit.** Both shapes authenticate the human to the tenant via OAuth (Netlify Identity). "Install for a tenant owner" = `member_invite` with role `publisher`/`editor` + the GPT link (or agent invite). Put this on the admin plugins page as the install card's first step; W6 acceptance includes one publish by a second, non-owner member.
6. **Whole-publication edits** (every article re-voiced, batch refresh) are NOT a chat-plane job: 20+ lock/patch/publish cycles with per-tool confirmations in one chat is fragile. Document the split in `20-publishing-plugin.md`: chat plane = single article or a handful; CMS-Agent workflow = publication-wide batch. If a GPT is asked for a batch, its instructions say so and hand off.
7. W6 acceptance for OpenAI: one article end-to-end from BOTH shapes with `producer.node_id = "plugin:openai-gpt"` / `"plugin:openai-agent"` in publish history.

## Unchanged
- Claude path (W2) and the 4 W2 defects → still W6's first job.
- `genesis_conductor` → deferred; concept renamed `onboarding_conductor`; not a dependency.
