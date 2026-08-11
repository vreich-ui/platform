# CMS-Agent-Backed Admin Conversations — Done Criteria & Rollout Gates

**Status:** IN PROGRESS (revised 2026-08-10). Every item is testable; each names its proof (unit/integration test, browser evidence, or deploy check). An item without recorded evidence is not done — the "no record = not converted" rule applies.

**Section state at 2026-08-10.** A-, B-, C- and F2/F3-class items are substantially satisfied CMS-Agent-side by the shipped CA track (tests exist for pass-through, replay, no-email, project isolation, schema-bound regression) — but the coverage is thinner than these criteria demand, and that is now a known debt rather than a passing grade. Specifically still missing on the CMS-Agent side: no test asserts the JSON-RPC wire shape of a typed `agent_converse` error (`error.data.error.code`); the context/tools/message overflow bounds are untested; the concurrent-duplicate test runs against the in-memory repository, so the blob CAS claim path has no concurrency coverage; and `schemaBoundRegression.test.ts` asserts a conductor fixture rather than anything about the conversation contract, so F2 is not actually evidenced by the test bearing its name. Everything D-, E-, G- and the rest of F-class remains untested because the Platform side does not exist yet. Add the four gaps above to the CA backlog and re-verify at G2.

## A. Contract & conversation

- [ ] **A1 — Two-turn memory.** A second `agent_converse` turn whose transcript contains the first demonstrably references it (CMS-Agent unit test with mock provider asserting prompt content; Platform integration test; browser evidence in every cutover walkthrough).
- [ ] **A2 — Conversation persistence.** A chat survives page reload and a fresh `get_chat` with identical events/transcript under the CMS-Agent engine (existing Platform tests re-run against `cmsAgentEngine` with mock).
- [ ] **A3 — Pass-through tools.** Tool definitions sent in a turn surface as unexecuted `tool_calls`; CMS-Agent performed no tool execution (mock provider asserts; code path has no tool executor).
- [ ] **A4 — Contract frozen & versioned.** `CLIENT-MANAGER-CONTRACT.md` committed; request schema `.strict()`; unknown fields rejected with a named error (test).
- [ ] **A5 — Transcript bound.** Over-bound message lists rejected with `transcript_too_large`; Platform trims and retries successfully (test).

## B. Attribution & isolation

- [ ] **B1 — Actor attribution.** Every turn record carries `{kind:'human', id}` (stable id only — **no email**, per Wolf 2026-08-09) from the run principal; a turn without an actor is rejected; a test asserts no email-shaped string lands in a turn record. The attribution-not-authorization caveat is documented in the new types (review).
- [ ] **B2 — Tenant isolation by auth.** A site's scoped token cannot converse as another `project_id` (401/403 test) nor call tools outside its allowlist.
- [ ] **B3 — Object/tenant context isolation.** A dr-lurie conversation never receives platform/fernwell project knowledge (prompt-assembly unit test per project).
- [ ] **B4 — Chat visibility unchanged.** Non-owner sees only own chats; owner include-all works (existing tests green).

## C. Idempotency & concurrency

- [ ] **C1 — Duplicate turn replay.** Same `(conversation_id, turn_id)` twice → one model call, identical response (mock provider call-count test).
- [ ] **C2 — Duplicate approval resume.** Replayed approve/deny after stale-takeover neither double-executes the tool nor double-appends (existing `forged_resume`/409 suite green under the new engine).
- [ ] **C3 — Stale-run takeover.** A lost background hop recovers exactly as today with the CMS-Agent engine (test).

## D. Approvals & risk

- [ ] **D1 — Tenant tool approvals unchanged.** `ask` tool → approval card with summary/args/dry-run; approve (plain and edited), deny with reason, cancel — all byte-compatible event streams (golden tests + browser evidence).
- [ ] **D2 — Risk floors.** `run_workspace_workflow` can never run under `auto` or client-side safe-run when the target is publish/admin risk, regardless of governance settings (server-side test).
- [ ] **D3 — Second wall intact.** A Platform-approved workflow publish still refuses without CMS-Agent's own gates (`toolPolicies`, `*_PUBLISH_ENABLED`) — kill-switch test in CMS-Agent suite.

## E. Failure, security, no-fallback

- [ ] **E1 — Missing/invalid credentials.** Unset endpoint/token in `required` mode → clear `cms_agent_not_configured` at send; wrong token → `cms_agent_auth_failed` run error; chat remains usable (tests).
- [ ] **E2 — Downtime/timeout/malformed.** Connection refused, 90s timeout, non-schema response → named `run_error` codes, no crash, retry succeeds when healthy (mock-server tests).
- [ ] **E3 — No generic fallback in required mode.** With CMS-Agent down and mode `required`, the provider adapters are provably never invoked (spy test); in `fallback` mode every fallback emits a visible `engine_fallback` event.
- [ ] **E4 — No browser credential leakage.** `CMS_AGENT_*` values absent from all client bundles (extended protected-env guard test); sanitizer strips bearer/token keys from every logged/returned payload (unit test); no secret in any chat event payload (assertion over event fixtures).
- [ ] **E5 — Legacy path removed (PF6).** Chat loop imports no provider adapter (guard test that fails on re-introduction).

## F. Migration & regression

- [ ] **F1 — Existing chats.** A pre-cutover `ChatDoc` (fixture from production shape) loads, renders, and accepts a new CMS-Agent-engine run; old runs display with their historical engine label (test).
- [ ] **F2 — Schema-bound node regression.** CMS-Agent's full node/executor/publisher suite passes byte-identically after CA1–CA4; a canonical conductor dry-run in mock mode produces pre-change-identical stage outputs (regression fixture).
- [ ] **F3 — Manifest integrity.** `npm run verify:deploy` green with the new tools; surfaceHash matches; existing 135 tools unchanged.
- [ ] **F4 — Builds.** `drlurie`, `fernwell`, `platform` production builds pass on every Platform milestone; `npm run check` + full test suites green in both repos.
- [ ] **F5 — Write-refresh & locking.** Accepted write refreshes the Object Stage (writeStamp); lock icon clears after agent check-in; checkout→patch→checkin with lock token threading works in a live CMS-Agent-engine conversation (browser evidence).

## G. Rollout gates (chronological)

| Gate | When | Pass condition |
|---|---|---|
| **G1 Contract freeze** | end of CA3 | Wolf reviews `CLIENT-MANAGER-CONTRACT.md`; A-section items green in CMS-Agent CI |
| **G2 Integration proof** | end of PF2 | Real conversation + real approval on a branch deploy of the `platform` site against deployed CMS-Agent; evidence: transcript, screenshots, turn records, usage rollup |
| **G3 Per-site go** | each PF5 stage | Soak with `engine_fallback = 0`; authenticated browser walkthrough of **all** chat entry points (Object Room rail, Templates rail, AgentsHub free chat): two-turn memory, approval, denial, cancel, injected failure; latency + cost sampled and reported |
| **G4 Revenue-tenant go** | before drlurie `required` | G3 evidence **plus** per-conversation cost review and CMS-Agent usage attribution correct per site |
| **G5 Retirement** | before PF6 merge | All sites ≥ agreed soak in `required` with zero fallback/error spikes; Wolf explicitly approves the removal commit |
| **Post-deploy health** | every deploy in the program | CMS-Agent `/healthz` + `verify:deploy`; Platform: send→reply smoke on each deployed site; rollback rehearsed once at G3-platform (governance override → `off`, verify legacy path, flip back) |

## H. Deployment ordering & rollback (checklist form)

- [ ] CMS-Agent changes always deploy before the Platform milestone that consumes them; each is dark until called.
- [ ] Cloud Run env changes use merge-style `--update-env-vars`/`--update-secrets` only (the `--set-env-vars` wipe is a known twice-hit trap); the six client-connection vars and `*_PUBLISH_ENABLED` survive every deploy (post-deploy `verify:deploy` asserts).
- [ ] Rollback path verified at each stage: governance mode override → `off` is instant and requires no deploy; Cloud Run previous-revision pin rehearsed once.
- [ ] Fernwell cutover blocked on CA5 (project registration + health green).
