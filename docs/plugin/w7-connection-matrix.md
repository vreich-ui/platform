# W7.5 — the connection matrix

Every row is a way the connection can fail. Before this wave they all presented
as the same thing to an installer — "the tools stopped working" — and all of
them reached Wolf as the same message. The point of W7.5 is that each one now
answers differently, in a way the person or the model in front of it can act on.

## What each surface should see

`✓` = mechanically covered by `tests/netlify/mcp-connection-fortification.test.ts`.
`probe` = to be confirmed against the live tenant on the next install run and
recorded below.

| Condition | Claude connector | Agent Studio | Custom GPT (façade) | Covered |
|---|---|---|---|---|
| Reachability | `ping` → `{ok, server, instance_age_ms}` | same | `POST /api/plugin/ping` | ✓ (pre-existing) |
| Identity + charter | `whoami` → member, role, surface `plugin:claude` | surface `plugin:openai-agent` | surface `plugin:openai-gpt` | ✓ |
| Cached schema | `initialize.serverInfo.tools_digest` ≠ `whoami.manifest_tools_digest` | same | `X-Plugin-Manifest-Version` on the schema | ✓ |
| Which tool moved | `tools/list` → `_meta.schema_version` per tool | same | n/a (schema re-imported wholesale) | ✓ |
| Operator diagnosis, no credential | `GET /mcp?health=auth` → audiences, store reachable, `surface.tools_digest`, `surface.manifest_version` | same | same | ✓ |
| Expired / unknown token | `401` + `re_authenticate: true` + `WWW-Authenticate: …error="invalid_token"` | same | passed through as `401` | ✓ |
| Audience mismatch | `401` + `oauth_failure: audience_mismatch` + `accepted_audiences` | same | same | ✓ |
| Refreshed token | works on `/mcp` | works | works through the façade | ✓ |
| Oversized read | tool error `too_large` + `use_instead` | same | `422` carrying the same body | ✓ |
| Write loop | tool error `write_rate_limited` + `retry_after_seconds` | same | `422` carrying the same body | ✓ |
| Surface cut off by the operator | every tool but `ping`/`whoami` → `surface_blocked` | same | same | ✓ |
| Out-of-charter tool | answered (the charter is advisory on `/mcp`) | answered | `403 tool_not_in_plugin_charter` | ✓ (pre-existing) |

## The two numbers to compare, and where to read them

An install is stale when these disagree:

```
curl -s 'https://<tenant>/mcp?health=auth' | jq '.surface'
# { "tools_digest": "sha_xxxxxxxx_49", "manifest_version": "dr-lurie-openai-20260904-xxxxxxxx" }
```

against what the client holds — `whoami.manifest_tools_digest`, or the
`X-Plugin-Manifest-Version` header on a downloaded bundle. `whoami` does the
comparison for you and reports `tools_digest_matches`.

## Decisions worth knowing before you debug

**The 401 never says whether a token exists.** `expired` and `no_record` stay in
the function log. Naming them would make an unauthenticated endpoint a free
oracle about which tokens are real. `re_authenticate: true` is set for any
refused bearer, which is the actionable half and leaks nothing.

**`audience_mismatch` and `store_error` DO travel in the body.** Those two are
the tenant's fault, not the caller's, and they are the two an operator cannot
otherwise distinguish from a bad credential.

**The write limit fails open.** 60 writes / 10 minutes / member, fixed window.
A store outage returns "allowed" every time — a courtesy that can take down
publishing is a defect, not a safeguard.

**The surface kill switch cuts an APP, not a person.** `member_suspend` already
cuts a person. Set `surfaces: { "plugin:openai-gpt": "block" }` on the
governance doc to stop one chat app without touching the editors who use the
others; `ping` and `whoami` stay open so the installer can find out that is what
happened.

## Live probe

_Run against drlurie on the next install day and fill in. A table of `✓`s from
the test suite is not the same claim as a table from the live tenant._

| Condition | Claude | Agent | GPT | Notes |
|---|---|---|---|---|
| health=auth | — | — | — | |
| whoami | — | — | — | |
| expired token | — | — | — | |
| oversize read | — | — | — | |
| rate limit | — | — | — | |
| surface blocked | — | — | — | |
