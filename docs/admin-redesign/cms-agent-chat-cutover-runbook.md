# PF5 — Permanent Client Manager cutover

**Decision (2026-08-18):** Platform admin chat talks to CMS-Agent's canonical
`client_manager` exclusively. The transitional `off → fallback → required`
ladder is retired. `CMS_AGENT_CHAT_MODE` and the governance mode override do
not select a chat engine.

## Runtime contract

- `CMS_AGENT_MCP_ENDPOINT` and the site's scoped `CMS_AGENT_MCP_TOKEN` are
  mandatory server-side configuration.
- `send` fails with `cms_agent_not_configured` before a run is created when
  either value is missing.
- Every background hop constructs `cmsAgentEngine`, resolves
  `client_manager` for the site's committed `cmsAgentProjectId`, and calls
  `agent_converse`.
- A CMS-Agent transport, authentication, contract, timeout, or model failure
  becomes a coded `run_error`. Platform never calls its provider adapters as
  a fallback.
- Existing governance documents may still contain `cms_agent_chat_mode` so
  the rest of the document remains readable. That field is ignored; new mode
  writes are rejected and the compatibility `revert` may clear it.

## Pre-deploy verification

For each site — `platform`, `fernwell`, and `drlurie`:

1. Confirm endpoint and the correct per-site scoped token are configured.
2. Confirm the token permits at least `agent_resolve` and `agent_converse` for
   exactly that site's CMS-Agent project id.
3. Call governance `get`; require `cms_agent.configured === true`,
   `cms_agent.mode === "required"`, and `cms_agent.health.ok === true`.
4. Deploy the Platform revision containing this cutover.
5. Perform an authenticated walkthrough of Object Room, Templates, and
   AgentsHub chat: two-turn memory, approval, denial, cancel, and a controlled
   failure followed by a healthy retry.
6. Review latency, cost per conversation, and per-site CMS-Agent usage
   attribution before declaring the release verified.

## Rollback

There is no runtime provider-mode rollback. Roll back the Platform deploy to a
known-good revision while correcting the CMS-Agent service/configuration, then
repeat the health probe and walkthrough. A rollback is release evidence and
must not be described as a successful Client Manager cutover.

## Scope boundary

This cutover removes Platform provider adapters only from admin-chat routing.
Other AI surfaces may still use `provider.ts` until separately migrated.
