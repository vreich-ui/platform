# G2 — Live integration proof (2026-08-11)

**Verdict: PASS.** Wolf authorized proceeding without a paused review
(2026-08-11: "if all clear, don't stop at the gate"). Evidence below; the
Platform-side loop behavior (approval cycle, event/transcript byte-parity,
turn_id discipline) is covered by the PF2 test suite against a scripted
client — this proof covers the live deployed service with exactly the
request shapes `cmsAgentEngine` emits.

Deployed service: the Cloud Run MCP endpoint, project `platform`,
conversation `g2:proof-20260811`, actor `identity-wolf-g2` (stable id, no
email on the wire).

1. **Resolution.** `agent_resolve {role: client_manager, project_id:
   platform}` → `agt_client_manager@2`, rev **2**, model gpt-4.1, status
   active. Rev 2 means **CA6 prompt parity is live** — the required-mode
   blocker in the roadmap is cleared on the service side.
2. **Turn 1 — pass-through tools.** `client_manager.turn.v1` with two
   WireTools (`get_object`, `checkout`) and default constraints
   (16000/90000). Response: one unexecuted `tool_calls` entry
   (`get_object {page, page_home}`), no execution server-side. Usage
   1200/21 tokens, $0.002568. (Done-criteria A3.)
3. **Turn 2 — two-turn memory.** Transcript carried turn 1's assistant
   tool_call + tool result (adjacency per contract). The reply quoted the
   hero heading from the tool result verbatim and suggested a checkout —
   editor-safe language, no raw ids, no model name. (A1.)
4. **Idempotent replay.** Turn 2 re-sent byte-identically under the same
   `(conversation_id, turn_id)`: identical stored response returned, and
   `usage_list_records` shows exactly TWO records for the conversation
   (`t_g2run_1`, `t_g2run_2`) — the replay performed **zero** model calls.
   (C1, observed on the live store rather than a mock.)
5. **Usage attribution.** Both records carry
   `metadata: {conversationId, turnId, siteId: site_platform}` and pricing
   catalog 2026-07-31.1. Total proof cost: $0.005456. (G2's usage-rollup
   requirement.)

Not covered here, deliberately: the per-site scoped-token 401 behavior
(CA4 test suite + PF2's `cms_agent_auth_failed` mapping cover it) and a
browser walkthrough on a deployed site — that is the G3 walkthrough, per
site, at PF5 time.
