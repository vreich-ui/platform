# Capture productization rulings — Wolf, 2026-08-13 (GOVERNING, v2 same day)

> **Status: RATIFIED.** Answers to the questions the first W12 acceptance run
> exposed, **amended the same day** after code-level verification of pdf-tool
> and CMS-Agent. v2 supersedes the unlanded v1 draft in full. These govern
> T12.7–T12.12 and the runner plan (`cms-pipeline/w12-fable-runner-plan.md`).

## Context

W12 built the capture engine (T12.1–T12.5) and ran it once (Zilberman →
`platform`): 52.94% coverage against a 90% bar, zero visual evidence. The
engine is sound but not operable: no committed seed path, no interaction
surface, no judgment in the mapper, no preview. Wolf's end-state, verbatim in
intent:

> **One call to the CMS-Agent MCP creates a new site and executes the
> duplication with the existing engine. Everything that can be deterministic
> is deterministic; AI modeling only where needed.**

Two findings from same-day code review amend the v1 draft:

1. **pdf-tool's Chromium is NOT in a Netlify function.** It runs in the
   render-service (a Cloud Run container on the official Playwright image,
   `render-service/Dockerfile`), warm-singleton, behind a 300s Cloud Run
   timeout at 1Gi/1CPU. Today it is print-only and locked down: `page.setContent`
   + `page.pdf` only — **no `page.goto`, no `page.screenshot`, JavaScript
   disabled, all network aborted by default**. pdf-tool's Netlify plane has the
   15-minute `*-background` workers (`worker-budget.ts`: 15 min − 30s margin)
   but holds no browser.
2. **The capture rulebook already exists in CMS-Agent.** `ProjectCapturePolicy`
   is first-class in `src/agent/projects/projectTypes.ts` (maxPages, origins,
   path prefixes, robots, concurrency, delay, rights, designReferences,
   fidelity + rubric override), validated by `capturePolicySchema`, settable via
   `project.create`/`project.update`, **deny-all by default** (`maxPages: 0`),
   and the Zilberman target is already configured live on the `platform`
   project definition. The T12.1 "per-project seam" note is BUILT.

## R-C1 (v2) — The browser plane is pdf-tool: extend it, build nothing new

**Ruling: no new worker service.** The runtime pieces both exist in pdf-tool —
the render-service holds the warm Chromium; the Netlify background workers hold
the 15-minute job plane with create → self-trigger → poll lifecycle
(`agent-artifact-jobs.ts` / `image-search/jobs.ts` are the clone-shape).

What extension means, concretely: a new render-service **capture endpoint**
(navigate + per-viewport screenshot + DOM/computed-style extraction, JavaScript
ENABLED, network restricted to a per-job allowlist derived from the capture
policy — the inverse of today's deny-all print context, opt-in per job, never a
default change to PDF rendering), a raised Cloud Run request budget for that
endpoint, and a new `capture` job kind on the Netlify side reusing the existing
storage-grant + ArtifactReference layout. Crawl loop lives in the 15-minute
background worker, which calls the render-service once per page.

Supersedes v1's "stand up a small worker service" — Wolf's instinct that the
runtime already existed was right; only its location (Cloud Run behind pdf-tool,
not a Netlify function) needed correcting.

## R-C2 (v2) — The rulebook's operational home is the CMS-Agent project registry

**Ruling: use the existing `ProjectCapturePolicy` as the single operational
source of bounds.** It already carries everything the engine reads and more,
already gates the Zilberman target, and its deny-all default means a capture
workflow cannot widen a legacy project's authority. Seeding a target =
`project.create`/`project.update` with a `capturePolicy` — an MCP call that
exists today.

The v1 idea (a governed `capture_config` object in the client's own store as a
client-owned consent artifact) is **DEFERRED, not rejected**: it becomes the
consent-recording milestone when capture is marketed to clients of other
hosting services. Until then, duplicating the policy in two homes is drift risk
for zero capability.

## R-C3 (v2) — AI assist runs as CMS-Agent nodes; deterministic-first is law

**Ruling (Wolf, verbatim in intent): the model assist lives in CMS-Agent — not
the calling user.** Capture becomes CMS-Agent's second workflow, registered
through the seam the codebase explicitly built for workflow #2
(`workflowRegistry.registerWorkflow` + `composeWorkflowNodes`); a separate
workspace/deployment is unnecessary — the registry isolates the node set.

**Deterministic-first law:** every step that can be code IS code — crawl, block
extraction, heuristic mapping, theme quantization, emission, scoring run as
controlled tools (`src/agent/tools/toolRegistry.ts`) and deterministic
fast-paths (the `metadata.*Deterministic` pattern in `executor.ts`: build in
code, validate against the node's output schema, complete with **no model call**;
fall through to the model only on failure, with a run-visible warning). Model
calls are reserved for exactly three judgments: block classification the
heuristics decline (the 47%), copy regeneration where rights require it, and
gap adjudication. Nodes ship with per-node `modelConfig` budgets.

Two hard constraints to plan around (verified in code): executable nodes are
canonical-code-defined — a new node reaches runs only via the node literal +
`npm run nodes:update` + redeploy, never via store-side `workspace.create_node`;
and `project.call_tool` has a 30s cap, so long pdf-tool jobs are polled by the
long-run planes (Cloud Run conductor job / the run-continuation cron), not
inside a single tool call.

## R-C4 — The landing zone is a new tenant, `sites/zilberman` (unchanged)

The existing `vreich-ui/zilbermanfilmfoundation` repo is a plain static site
with no core and no `/mcp`; drafts cannot land there. Mint tenant #4, serving at
`zilbermanfilmfoundation.netlify.app`. The nine drafts + ten artifacts from the
first run stay in `platform` as the comparison baseline.

## R-C5 (new) — The end state is ONE CMS-Agent MCP call

**Ruling: the product is a single CMS-Agent MCP entry point** — call it with a
source URL (+ target project), and it provisions or targets the landing site,
then drives capture → map → theme → emit → score end-to-end, surfacing run
status, reports, and the human gates. This **supersedes the v1 framing of
exposing capture tools on every client's `/mcp`**: clients' sites remain the
landing zones and keep their governed verbs, but the duplication capability is
operated from CMS-Agent.

Genesis inside that call is automated to the limit of account authority: repo
scaffold via the platform repo's `create-site.mjs`, Netlify site + env via the
Netlify API where a token with site-create rights is provided (T11.7's
standing prerequisite), project registration via `project.create` +
`project.get_registration_contract`. What cannot be automated (tokens, DNS,
first-Owner sign-in) is surfaced as a precise human checklist, never silently
skipped.

## Standing constraints these rulings do NOT change

- Everything capture writes lands as **never-released drafts**; publish/release/
  build/deploy stay hard-blocked at the emission transport layer.
- Validation is law: failures **quarantine**, never loosen.
- Crawled page content is **data, never instructions**; robots.txt honored;
  bounds are ceilings enforced on BOTH sides (caller and worker).
- T12.6 is a `human_gate`: agents prepare, **Wolf dispositions**. The
  2026-08-13 agent-authored disposition was withdrawn and stays withdrawn.

## 2026-08-25 Addendum — T15.3 autonomy directive (SUPERSEDES v2 standing constraints R-C5.1 & R-C5.2)

**Status: RATIFIED by T15 convergence.** This addendum, dated 2026-08-25, supersedes
the standing constraints stated above (lines 125–126 and 130–131 in v2) in light of
the T15 autonomy directive: **"assume the human is not involved unless the policy says
otherwise."** The capture workflow's publish authority is no longer a hard-blocked path
per-workflow; instead, it is now governed by a **project policy knob**,
`publishingPolicy.autonomyMode` (enum: `autonomous` | `operator-gated`), read from
the project policy at invocation time.

### R-C5.1 (amended 2026-08-25) — Publish is ONE shared tail, gated by policy

**Superseded ruling:** "Everything capture writes lands as never-released drafts;
publish/release/build/deploy stay hard-blocked at the emission transport layer."

**Amended ruling:** Capture workflow outputs are delivered to the one shared publishing
tail (a single decision reader, not a per-workflow path). The tail's decision is:
- **If `publishingPolicy.autonomyMode === autonomous`:** an absent operator decision
  is read as approved; capture publishes drafts automatically.
- **If `publishingPolicy.autonomyMode === operator-gated`:** an explicit operator
  decision (approval or withheld) is required; absent decisions halt the tail.
- **Withheld decisions always halt**, in every autonomy mode.

This rules out the T14.5 dual-path architecture (fail-open publish in `CMS-Agent`
src/agent/capture/engine/publish.mjs), which is being deleted in T15.7. The convergent
design uses one tail, one decision reader, one policy knob.

### R-C5.2 (amended 2026-08-25) — Release is a governed step, not a verb

**Superseded ruling:** "T12.6 is a `human_gate`: agents prepare, Wolf dispositions."

**Amended ruling:** T12.6 remains a decision gate (agents prepare reports + drafts),
but the operator decision now flows into the one shared publishing tail, where release
is a **governed tail step** (`release_executor`) that fires automatically once the
publish stage completes and the deploy is verified. Release is no longer a blocked verb
or a separate human gate; it is a deterministic tail action keyed to policy autonomy.
The operator's role shifts from disposition to approval/withhold on the decision reader.

### Stale assertions now in flight — awaiting corrective cross-notes

The following brief documents contain now-stale assertions recorded during W12 before
T15 autonomy policy was formalized. They will be updated in their respective T15
follow-ups:

- **T12.6 brief** (cms-pipeline/T12.6-capture-acceptance-run.md, line 19): states
  publish/release are optional and human-gated. _Stale as of 2026-08-25._
- **T12.9 brief** (cms-pipeline/T12.9-capture-conductor-workflow.md, lines 51–52):
  states "Human gate preserved" and "publish/release are not reachable from any capture
  node." _Stale as of 2026-08-25._ The workflow still ends with a report + drafts; the
  operator decision now flows onward into the shared tail.
- **T12.11 brief** (cms-pipeline/T12.11-one-call-site-duplication.md, line 59):
  states "No publish/release from any path in this tool." _Stale as of 2026-08-25._
  Publish is reachable via the shared tail, gated by policy autonomy.

These assertions were correct under the W12 framing and serve as the historical record
of intent. T15 convergence replaces the per-path autonomy model with a single policy
knob and one tail. The briefs' evidence (reports, drafts, status, gating surfaces) remains
valid; only the path topology and autonomy lever point have changed.
