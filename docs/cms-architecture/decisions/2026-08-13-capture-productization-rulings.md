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
