# PF5 — Staged cutover runbook (prepared 2026-08-11; no site flipped yet)

**State when this was written:** PF0 done (Wolf); PF1–PF4 committed on
`codex/cms-agent-chat`; G2 passed live (see cms-agent-chat-G2-evidence.md);
CA6 live at agent rev 2, so required mode is unblocked. Every site's env
default is `CMS_AGENT_CHAT_MODE=off` — nothing changes until an Owner flips
a mode.

## The lever

Runtime, per site, no deploy: `POST /.netlify/functions/admin-governance`
(Owner) with `{"verb":"set","cms_agent_chat_mode":"fallback"}` — or
`"required"`, or `{"verb":"revert","target":"cms_agent_chat_mode"}` to fall
back to the env default. Every write lands in the governance history with
the actor. The same endpoint's `get` now returns a `cms_agent` block:
configured (env NAMES only), effective mode + source, and a memoized 60s
`agent_resolve` health probe — check it before and after every flip.

## Pre-flip, once (ops, Wolf, ~5 min)

PF4's orchestration tools call four more CMS-Agent tools through each
site's scoped bearer. Extend `mcp-scoped-tokens-json` (Secret Manager) so
every site's `toolAllowlist` reads exactly:

```json
["agent_resolve","agent_converse","workspace_get_nodes","workflow_start_dry_run","workflow_run_all","workflow_get_run"]
```

Redeploy CMS-Agent with merge-style flags only. Until this lands, chat
conversation works fully; only the three workspace orchestration tools
answer 401 (mapped to a clean tool error, not a crash).

## Per site, in order: platform → fernwell → drlurie

1. Governance `get` → `cms_agent.health.ok === true`.
2. Flip `cms_agent_chat_mode` to `fallback`. Soak (defaults 3d / 2d / 5d):
   evidence required — `engine_fallback` events = 0 across the soak (they
   are loud in the chat feed and in the event log), turn latency sampled,
   per-conversation cost from CMS-Agent usage records
   (`metadata.conversationId`).
3. Flip to `required`. Authenticated browser walkthrough of EVERY chat
   entry point (Object Room rail, Templates workspace rail, AgentsHub free
   chat): two-turn memory, one approval cycle, one denial, one cancel, one
   injected failure (revert the token env on a branch → expect the coded
   run_error copy, then a clean retry).
4. ⛔ **G3** — Wolf reviews the evidence and gives an explicit go before
   the next site. ⛔ **G4** — before drlurie additionally review
   cost-per-conversation and per-site usage attribution.

Rollback at any moment: `revert` the override (instant, per hop — a run
paused behind an approval card resumes on the provider path) or set `off`.
Rehearse once at G3-platform.

## Deliberately not done

PF6 legacy retirement (⛔ G5 — Wolf must approve the removal commit
explicitly). The fallback mode's `invalidEnvValue` surfacing beyond the
governance block, and CA7 (turn-GC scheduling), remain open per the
roadmap.
