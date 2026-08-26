# One approval truth on the platform — T15.8 (vreich-ui/platform#615)

> **Status: RATIFIED.** Implements CMS-Agent's
> `ADR-2026-08-25-publish-autonomy.md` §2.4/§2.5 and
> `ADR-2026-08-25-structure-studio.md` §4.2 on the platform side. Where this
> doc and the GitHub issue that spawned it differ, the ADRs win — this doc
> records what was actually built and why.

## The two things platform#615 found disagreeing

The issue named one live contradiction; building the fix surfaced a second,
larger one hiding behind identical-looking config. Both are now resolved by
making the derived layer *read* the deciding layer instead of carrying an
independent copy of the same fact.

### 1. Page-type `reviewPolicy` vs. `approval-policy.ts` (the issue's own finding)

`packages/core/lib/registry/page-types.ts` hardcoded every `PageTypeDefinition`
(including `clone`) to the same static `PAGE_REVIEW_POLICY` constant
(`required: true`), exposed read-only over MCP via `registry_get('page_type')`.
Meanwhile `packages/core/server/lib/publish-gate.ts` — the code that actually
enforces whether a publish needs a human approval — resolves that question
from the SITE's committed `approval-policy.ts` (`master`/`overrides`), and
every fleet site sets `master: 'all-autonomous'`. So `registry_get` told a
caller "this page type requires approval" while the object store would let an
autonomous publish straight through for the same object — dormant, contradictory
metadata, exactly the "surprise gate resurfaces later" risk the issue named.

**Deciding layer:** `approval-policy.ts`, because `publish-gate.ts` is what
actually enforces it (the issue's own recommendation, and unchanged by
either ADR).

**Fix:** `page-types.ts` gained `resolvePageTypeReviewPolicy(policy)`, which
derives `reviewPolicy.required` from `publishRequiresApproval('page', policy)`
— the exact function `publish-gate.ts` itself calls. `listPageTypeDefinitions`
/ `getPageTypeDefinition` now accept an optional `ApprovalPolicy` argument;
`registry_get`'s handler (`mcp-tool-handlers.ts`) passes the site's
`activeApprovalPolicy()`. Called with no policy (a client-safe context with no
server binding), the definitions keep the old static, conservative default
(`required: true`) — never a silent flip toward "no approval needed" for want
of an argument. `minApprovals`/`publishRoles` are untouched; they only matter
once `required` is true, and were never independently wrong.

**Result:** `registry_get('page_type')` and `publish-gate.ts` can no longer
disagree about the `page` object type, on any site, including Zilberman's
`clone` page type. One config layer (`approval-policy.ts`) decides; the
registry reflects it instead of shadowing it.

### 2. The chat `"ask"` floor vs. `approval-policy.ts` — the larger, more dangerous version of the same mistake

Building the fix above surfaced the real reason for the ADRs' framing.
`mcp-tool-definitions.ts`'s `governance.autonomyFloor: 'ask'` (privileged
tools, `object_create`/`object_publish`/the two `instantiate_*`
verbs/`object_retire`/`object_review_decide`, every membership write —
`mcp-tool-definitions.test.ts:62`) is resolved for the admin chat surface by
`resolveAutonomy`/`autonomyForCall` (`agent/tools.ts`, `agent/registry.ts`).
Until this task, that floor was **absolute** — no governance override, no
policy, nothing could ever satisfy it without a human clicking approve on a
chat card, by design (the pre-existing comment on
`mcp-tool-definitions.test.ts` states this explicitly: *"the floor is a
CHAT-approval rule only [and] does not touch the publish gate"*).

The ADRs ask for that to be reconciled with project autonomy — but **reusing
`approval-policy.ts`'s `master: 'all-autonomous'` to satisfy the chat floor
would have been exactly the same class of bug as finding #1, at a much larger
blast radius.** Every fleet site already sets `master: 'all-autonomous'` —
for the narrow purpose of "does a routine object publish need an approval."
None of them ever configured, or considered, unattended chat-agent control
over `member_remove`, `ownership_transfer`, `wipe_blob_stores`,
`product_set_price`, or `delete_pdf_template` — verbs `approval-policy.ts`'s
`governedObjectTypes` list does not even cover. Silently wiring the floor to
`master` would have flipped every already-configured site into full
membership/privileged-tool autonomy the moment this task landed — precisely
the "quietly makes unconfigured tenants autonomous" defect the task brief
called out as the single most important line in it.

**Deciding layer (new): `publishing-policy.ts`'s `autonomyMode`.** A
deliberately SEPARATE, narrowly-scoped field
(`packages/core/lib/publishing-policy.ts`), named and shaped to match
CMS-Agent's own `ProjectPublishingPolicy.autonomyMode`
(`"autonomous" | "operator-gated"`, absent ⇒ `"operator-gated"` — ADR
publish-autonomy §2.1) so the two converge on one concept once CMS-Agent's own
live reader (T15.5, CMS-Agent#185) exists. **No fleet site registers a
provider for it today** — adopting it is a deliberate, separate opt-in a
site's Owner makes (mirroring `approval-policy.ts`'s own
`setActiveApprovalPolicyProvider` pattern), not a side effect of this task.
`activeAutonomyMode()` never throws; absence resolves `'operator-gated'`,
which reproduces today's behavior byte-for-byte for every existing site.

**Fix:** `autonomyForCall` (`agent/registry.ts`) — the one function that
already re-clamps every floored tool at call time — now resolves the floor as:

| Explicit governance/profile override on this tool | `autonomyMode` | Result |
|---|---|---|
| `'off'` (withheld) | any | `'off'` — always halts |
| `'ask'` (explicit human choice) | any | `'ask'` — respected, never promoted by policy |
| `'auto'` or absent | `'autonomous'` | `'auto'` — the floor is satisfied without a human |
| `'auto'` or absent | `'operator-gated'` / unconfigured / provider throws | `'ask'` — fail-closed, unchanged from today |

This mirrors ADR publish-autonomy §2.4's precedence exactly in spirit — an
explicit human decision always wins (rule 1's absoluteness, applied to the
strongest explicit human signal this surface has), and policy autonomy only
ever fills an *absent* decision, never overrides a present one. It does not
relax the object store's own per-type gate: a call that clears the chat floor
autonomously can still be denied at `publish-gate.ts` for a type pinned
`require-approval` (e.g. `product`) — the two checks stay independent, exactly
as ADR publish-autonomy §3 keeps the tail's machine self-check and its
authority check independent.

**`governance.autonomyFloor` itself never changes.** Every tool in
`mcp-tool-definitions.test.ts:62`'s list stays `'ask'`-floored — what changed
is only what *satisfies* the floor, never its classification. No tool may
lower its declared risk to buy autonomy, per both ADRs.

## Standing invariant this doc records

**Exactly one config layer determines approval for any given question; a
derived layer reads it, it never carries an independent copy.**

- Does an object PUBLISH need a human approval? → `approval-policy.ts`
  (`publish-gate.ts` enforces; `page-types.ts`'s `reviewPolicy` now derives).
- Does an admin-chat AGENT ACTION on an `'ask'`-floored tool need a human
  card? → `publishing-policy.ts`'s `autonomyMode` (`agent/registry.ts`'s
  `autonomyForCall` enforces).

These are deliberately two different fields answering two different
questions for two different surfaces (object-store write vs. chat-agent
action) — that is not the fork this task exists to delete. The fork would be
a THIRD field re-deciding either question independently; this task closed the
one that already existed (page-type `reviewPolicy`) and built the second
field defensively rather than reuse the first one out of scope.

## Release is not a human gate structurally

Per ADR publish-autonomy §4.2, `release_to_production` is a governed tail step
performed by CMS-Agent's `release_executor`; the platform remains the verb's
*provider* (the actual Netlify build-hook call and receipt), unchanged by this
task. `release_to_production` stays a privileged, `'ask'`-floored tool exactly
like every other privileged verb — reachable autonomously, on the chat
surface, only for a project that has deliberately opted into
`autonomyMode: 'autonomous'`. No `docs/cms-architecture/decisions/*.md` ruling
describes release as a structural human-only gate; the one prior document that
did (`2026-08-13-capture-productization-rulings.md` R-C5.2) was already
amended by T15.3 the same day this task's ADRs were ratified.
