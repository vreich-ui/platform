# Actionable blockages — acceptance record

**Tenant:** drlurie (`drluriescience.netlify.app`)
**Shipped:** cms-agent #276 · platform #708, #716, #721
**Plan:** `actionableblockagesplan.md` §5.2

Acceptance was run live in the admin, not as a scripted pass, and that is why this
record is worth keeping: **it found two defects that the whole unit suite, an
adversarial review of both diffs, and a clean `tsc` had all missed.** Both were of
the same kind — a surface offering an action it had no way to perform — and
neither was reachable from a test, because both needed the deployed pair.

---

## What the plan asked for, and what actually happened

### (a) Imagery button at $0.25 → card → raise for this attempt → proposal

**Partially verified, and it failed first.**

The card appeared, correctly, with the engine's own measured suggestion
(**$4.50**, not the $1.50 the plan estimated — see "the number was wrong" below).
Pressing **Raise to $4.50 for this attempt** *in the Publishing Agent panel* did
nothing, and **Dismiss** did not dismiss.

Root cause: an `attempt`-scoped raise is a re-call of the synchronous tool that
hit the wall (D3). There is no run to override and no node to retry, so only the
page that owns that tool can perform it. The chat card offered it anyway; the
server correctly answered "nothing to re-run from here", the endpoint returned
400, the browser threw, and the card stayed. Both halves were right and the pair
was wrong.

Compounding it: `ImageryBoard` held its wall in React state, so a page reload
left the durable copy only in the transcript — the one surface whose useful
button was greyed out. That is what turned an awkward moment into an
unrecoverable one.

Fixed in **#716**: the remedy table takes a surface; a transcript renders the
attempt raise disabled with the reason and where to press it; Dismiss is handled
before the resolver (dismissing *is* a state change, just not a remedy); a
default raise from chat says what is still needed; and the page renders the
chat's durable copy through the rail seam, where the raise is live.

**Re-verification after #716 has not been recorded here.** Worth one pass.

### (b) The same, via chat text ("raise to $1")

**Not exercised live.** Unit-covered (`blockage-answer-matcher.test.ts`, 17
cases, English + Hebrew), and the review of that matcher tightened it twice —
bare option numbers removed (nothing numbers the buttons), and an amount now has
to be *offered* rather than merely mentioned ("keep it under $2" no longer fires
a raise). The remaining live risk is interception, which the fix gated on the
chat actually being in `awaiting_blockage_resolution`.

### (c) Chat-driven publishing run blocked at a gate → approve from the card

**Not exercisable at the time of the run.** Review found that nothing ever wrote
a chat-origin blockage: `setPendingBlockage` had exactly one caller, the Imagery
propose endpoint. So only a page button could produce a card, and every remedy
except budget was unreachable in practice. Added in **#716**
(`blockage-turn.ts`), still unverified live.

### (d) Header Needs-you count increments and decrements

**Not verified.** The header showed `Needs you · 2` / `Blocked · 4` during the
session, but nothing tied those numbers to the blockage's lifecycle. Review
separately found `awaiting_blockage_resolution` missing from six consumers —
including `work-summary` (the header count itself) and `chat-liveness` (the chat
chip rendered *nothing* while a wall was up). Fixed in #716; the count behaviour
is worth one deliberate check.

---

## Two things the live run taught that no test could

### The number was wrong

The plan estimated `brand_imagery_writer` needed ~$1.50. The engine, measuring
real spend on a real mood board, suggested **$4.50** — and the node's stored
default was still `$0.25`, which cannot cover one vision turn. Every propose
tripped the guard before producing anything.

The default was raised to `$4.50` on 2026-09-09 via
`workspace.update_node_model_config` (workspace version 1066). Had it stayed at
$0.25, the card would have been correct, actionable, and permanently necessary.

### A good error one turn too late is still a failure

After the wall cleared, the agent tried `create_pdf_template` with a declarative
`{label, kind, schemaVersion, layout, sections}`. pdf-tool refused it and named
every offending key — a precise, teaching error, arriving *after* a creation-tool
approval had been spent, at which point the agent reported failure rather than
retrying.

`template_json` had been documented as "the template definition for the chosen
renderer" and nothing else. Each renderer takes one shape and rejects every other
key. Fixed in **#721**: all four shapes are on the contract, and the tenant
plugin skill — the doc that sends an agent down the chromium path — carries the
chromium shape too.

This is the same lesson as `admin-plan.md`'s own note ("an agent's only feedback
loop is the error string"), one layer earlier: **the contract has to teach before
the call, not only the error after it.**

---

## Still open

| | |
|---|---|
| Re-verify (a) end to end on the deployed #716 | one pass, five minutes |
| (b), (c), (d) never verified live | (c) is the one with no live evidence at all |
| `raise_run_budget` ships **disabled** | CMS-Agent has no `workflow.set_run_budget`; the card explains rather than showing a dead button |
| The model has no `resolve_blockage` tool | deliberate — every remedy spends money or changes stored config; a spending tool would carry `autonomyFloor: 'ask'`, i.e. an approval card, i.e. the blockage card one step later |

## Verdict

The contract holds: the engine's remedy reaches a human as a button, on three
surfaces, resolved once through one ledger. The two live defects were both in the
*last inch* — a surface promising an action it could not perform — which is
precisely the class of defect that unit tests, written per module, cannot see.
