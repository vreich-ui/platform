# Pipeline handoff — 2026-08-10

**For a fresh chat session picking this up.** Read this file first — it replaces
re-deriving status from `state-of-play.md`, `FLEET-STATUS.md`, and `queue.tsv`
individually, which are each accurate for what they cover but none is complete
or current alone (see the "why this file exists" note at the bottom).

**Repo state at time of writing:** `main` @ `986094b0` ("FLEET-STATUS: platform
git-committer fixed — expired GITHUB_CONTENT_TOKEN rotated; templates published
+ released"). W16 (T16.0–T16.10) landed same day. Nothing else committed on top.

---

## 1. Marginalia's canvas UX doesn't match the approved design — bigger gap than the item list suggested

**Confirmed live** (2026-08-10, driven directly on `drluriescience.netlify.app`,
signed in, network-traced) against **`docs/design/marginalia-concept-b-final.pdf`**
(committed alongside this handoff — Wolf's own "Marginalia — final" concept mockup,
the actual agreed design, previously not in the repo at all):

**What the concept spec calls for:** comments live **in the margin**, spatially
anchored next to the block they're about, revealed on hover as a bubble. A
**badge shows which items need Wolf's attention** without opening anything — a
global "Attention N" counter is always visible in the toolbar. **Selecting text
anchors a comment to that exact span** (not just a whole block). **Double-click
edits the block directly**, no separate panel required. The composer routes
through **"Dr. Lurié Article Agent · via CMS Agent"** — a comment can be a plain
note, a change request, or a question put to the agent, not just a human-to-human
thread. On narrow screens the page slides over to make room for the margin,
rather than covering content.

**What's actually live** (PR #521, verified 2026-08-10 by driving the real page):
a generic docked panel opened via a pencil icon, with a flat, un-anchored comment
list (whole-object or whole-block only — no text-selection anchoring), a plain
textarea composer with no agent routing, and **no attention indicator anywhere**
in the UI outside that panel. This is PR #521's own documented MVP scope (items
1–8 of 16) — accurate to what it says it built, just far short of the concept.

**Why this matters for scoping:** `KNOWN_ISSUES.md`/`FLEET-STATUS.md`/PR #521's
body all describe the gap as an itemized feature list ("items 9–16: span
anchoring, reply-threading UI, gutter badges…"). That list is real but abstract.
The concept PDF is the concrete target — hover/bubble/badge/select-to-anchor/
double-click-edit/agent-routed-composer are one coherent interaction model, not
eight independent features to pick off separately. **Whoever scopes the S4
continuation should design against the PDF, not re-derive intent from the list.**

**Sharper than that, on a second pass:** four of the PDF's requirements are not
in items 9–16 *at all* — margin-rail layout, hover-reveal bubbles, the
agent-routed composer, and double-click-to-edit. Items 9–16 is the deferred
*feature* list, not a complete statement of the gap. Anyone told "9–16 is what's
left" will under-scope this by roughly a rewrite of the annotation surface.

**Action:** none of this is auto-executable — it's a real UI/UX build and needs
Wolf's scoping call. **The whole canvas task set is now planned separately in
[`docs/cms-architecture/17-canvas-ux-plan.md`](../17-canvas-ux-plan.md)** — 14
tasks with per-task mode/model/effort and the batching rules for which can share
a session. Its §2 carries the scope question that blocks the rest; its §4 flags
the two tasks (T17.1/T17.2, the danger-colour bug and the glass treatment) that
are ready to land now and depend on none of it.

## 2. Immediate: finish T16.9 (credentialed, needs live MCP connectors)

T16.9 ran twice on 2026-08-10 — once partial (blocked on an expired
`GITHUB_CONTENT_TOKEN`), once as a fix (token rotated, platform's 3 starter
templates published + released, deploy `6a79ca52` live 12:56Z). **Still not
done**, per `docs/cms-architecture/FLEET-STATUS.md`'s live capability matrix:

- [ ] Full `npm run fleet:capability -- --all --markdown` run against the
      **deployed** W16 code, with per-site `MCP_HTTP_AUTH_TOKEN__<SLUG>` values
      set — replace the `FLEET-STATUS.md` capability-matrix stub (currently
      mostly "not probed" / "not yet run") with real output. Needs a session
      with all three sites' MCP connectors, not just platform's.
- [ ] Fernwell backfill (no fernwell connector was available in the 2026-08-10
      session): template instantiation (`tpl_interior`/`tpl_landing`/
      `tpl_legal`, same as platform got), and a live check of whether
      fernwell's admin-nav-link gap is actually still open — **PR #520**
      ("Bake starter page-templates into genesis; correct the fernwell
      admin-nav record", merged 2026-08-05) looks like it already fixed this;
      `FLEET-STATUS.md`'s checklist just wasn't updated after. Verify with one
      `object_get` on fernwell's `nav_header` before doing any rework.
- [ ] `site:verify` × 3 tenants (T16.8's `site-genesis-drive --verify`) —
      confirm all three match the T16.0 genesis manifest post-deploy.
- [ ] Dr-Lurie `tracking_config` store is empty by design (onboarding-stage,
      not yet run) — **needs Wolf's call on timing**, not an agent decision.

## 3. Doc-only fixes flagged during W16 (cheap, no credentials needed)

- [ ] Add `PURCHASE_TOKEN_SECRET` to the T11.7 env table — flagged as a P2 gap
      (W16 law: every env var core reads must be in that table + `ENV_CHECKLIST`
      + every site's env). Table-only fix unless the var itself is also missing
      from a site's actual env, which the T16.9 completion above would surface.
- [ ] `FLEET-STATUS.md`'s header still says "Last verified: 2026-08-05" and its
      stage table / checklist predate S4 Marginalia's merge and the fernwell
      admin-nav fix. At minimum: mark S4 (PR #521) merged, mark the fernwell
      admin-nav item per whatever §2 above finds, and update the "last verified"
      line once the T16.9 completion above lands.

## 4. Documentation debt: `state-of-play.md` is missing ~2 weeks of entries

Three standalone sidecar files still sit unfolded next to `state-of-play.md`
(`state-of-play-2026-08-04-w15-s2.md`, `-s6.md`,
`state-of-play-ENTRY-2026-08-04-w15-s3.md`) — queued as `W15.FOLD` in
`queue.tsv`, still uncommented. **Fold order, confirmed via each sidecar's own
commit timestamp: S3 → S6 → S2**, inserted directly below the file header and
above the 2026-08-03 entry (worked out and verified earlier the same day — do
not re-derive it, the two sidecars' embedded instructions disagree with each
other and the timestamps are the tiebreaker). **Note:** an earlier attempt to do
this fold ran against a *different, separately-cloned* local checkout
(`~/Code/Dr-Lurie-Blog`, since superseded by this `~/Code/platform` folder) and
produced an uncommitted local branch there that never reached `main` or this
repo — treat that as lost/inaccessible and redo the fold here; do not assume
it's already done anywhere.

Beyond those three, the log also has **no entries at all** between
2026-08-03 and the 2026-08-10 W16 entry, despite substantial merged work in
that window:

- S4 Marginalia MVP (#521), S4x continuation (#510)
- The admin-nav-genesis / fernwell live-patch trio (#515, #517, #520)
- A canvas edit-mode preload fix (#523)
- A large QA-batch wave, ~19 PRs (#524 through #542)
- Three admin-redesign PRs: #543, #545, #546 (object-first editorial
  workspace, governed learning mode, release lifecycle)
- #547 (pdf-tool platform gap), merged 2026-08-10, same day as W16

This is pure relocation/composition work, zero risk to running code, but it's
a real amount of writing (reading ~19+ PR bodies to compose accurate entries).
**Do the mechanical fold first** (zero-judgment, sidecars already written), then
draft entries for the undocumented window in a batch and show Wolf before
inserting — don't invent detail past what each PR body actually says.

After folding: delete the three sidecar files, comment out `W15.FOLD` in
`queue.tsv` (same pattern as the already-resolved `#W15.S3` / `#W15.S4x` /
`#W15.LEAK` rows above it).

## 5. Decisions only Wolf can make (don't guess these, ask or wait)

- **Marginalia's real scope** (§1) — is the concept PDF still the target? If
  yes, this needs a proper design-to-build pass (likely its own multi-session
  effort), not a quick follow-up PR. **The question is written out with three
  concrete answers in `17-canvas-ux-plan.md` §2** (full concept / items 9–16
  only / interaction-model-first) — answer that and T17.0 can start; everything
  from T17.3 down is blocked until then.
- **KNOWN_ISSUES.md #2 (QA-W16-3):** four destructive admin tools
  (`soft_delete_artifact`, `restore_artifact`, `migrate_artifact_indexes`,
  `reconcile_artifact_indexes`) share a broken auth check. Two legitimate
  fixes, different security posture (Option A: widen MCP-caller access same as
  the read-only tools already fixed; Option B: fix the admin gate to fail
  correctly instead). Needs Wolf's call before either lands.
- **S5** (client publishing chat / LibreChat) — parked on cost since W15. No
  action unless Wolf wants to restart it.
- **Dr-Lurie tracking-config onboarding timing** — see §2 above.

## 6. Open engineering work, not credential-gated, no decision needed

From `docs/KNOWN_ISSUES.md` (read it in full before starting either — both
entries carry specific instrumentation/measurement instructions):

- [ ] **#1 QA-W16-1**: `object_create`/`object_publish`/`create_pdf_template`/
      `create_agent_artifact_job`/`release_to_production` hit client-facing
      502s/timeouts under load even though the underlying write always lands.
      An idempotency-key retry mitigation already shipped (#529); the actual
      timeout-budget root cause is still uninvestigated.
- [ ] **#3 admin-content perf**: `ObjectRecord.history[]` grows unbounded
      (`page_home` was at 117 entries / 5.5 KB body as of 2026-08-06) and every
      full store sweep pays for it. Deferred pending a **measurement script**
      — write that first, don't design the fix blind.
- [ ] **#4 admin-content perf**: maintained inventory-index blob instead of a
      live sweep — explicitly lower priority, only pursue if #3 (plus #527/
      #528/#530) isn't enough. Re-measure before starting.

## 7. Branch cleanup (needs real repo write access)

Seven dead W15 branches are safe to delete — the Claude sessions that found
this didn't have branch-delete permission: `w15/s1-admin-core-repairs`,
`w15/s2-fleet-admin-genesis`, `w15/s3-tenant-retrofit`, `w15/s3-resolved`,
`w15/s3-docs-completion`, `w15/s4x-ask-ai-context-enrichment`,
`w15/s6-verification-records`.

## 8. Stale backlog needing triage before trusting it — do not execute blindly

`queue.tsv` still carries ~30 uncommented rows predating the W15/W16
numbering: `T12.1`–`T12.6` (content-capture spike/decomposition/theme
extraction/emission/fidelity/acceptance run), `T13.1`–`T13.13` (tracking
attribute through scores-feedback design), `T14.2`–`T14.10` (platform genesis
through v1 closeout, minus what's covered above). Given the platform site,
Fernwell (T14.9's synthetic third site), and the W11 core relocation described
in `CLAUDE.md` are all clearly live and working, several of these T14 rows in
particular read as already done in substance but never marked resolved in
`queue.tsv`. **Don't run any of these headlessly.** First pass should be a
read-only triage: for each row, check whether its brief's stated goal is
already true on `main` (grep for the artifact it says it will produce), and
either comment it out with a pointer to what closed it, or confirm it's a real
gap and leave it queued. This alone is a full task, not a five-minute check.

---

## Suggested execution order (economical grouping)

1. **Surface §1 and §5 to Wolf first** — the Marginalia scoping decision
   (`17-canvas-ux-plan.md` §2) is the highest-value open question in this file
   and nothing about it is auto-executable; better to have his answer before
   other work claims the "S4 continuation" slot with the wrong target.
2. **Canvas Batch A — T17.1 + T17.2** (`17-canvas-ux-plan.md` §5): CSS-only, one
   file, sonnet, not blocked on the decision above. Cheapest visible improvement
   available; the danger-colour half is a genuine bug fix, not a style change.
3. **Doc-only, no credentials** (§3, §4's mechanical fold half, §8's triage
   read-pass): one session, no MCP connectors needed, low cost per item.
4. **Credentialed, all-three-tenant session** (§2): needs platform + fernwell
   + drlurie MCP connectors together — batch everything in §2 into one
   session so the connector setup cost is paid once.
5. **Engineering, no decision needed** (§6): two independent, well-scoped
   investigate-then-fix tasks — can run in parallel with each other, and with
   #3/#4 above.
6. **Branch cleanup** (§7) whenever someone has push/admin access — trivial
   once unblocked, not worth a dedicated session.
7. **The rest of W17** (`17-canvas-ux-plan.md` §5, Batches B–D) once T17.0 has
   produced briefs — the largest single body of work outstanding anywhere in
   this file, and the only one that is opus-weighted throughout.

---

*Why this file exists: `state-of-play.md` is a rolling session log (accurate
per-entry, but has a real gap and three unfolded sidecars right now — see §4).
`FLEET-STATUS.md` is a point-in-time snapshot last fully rewritten 2026-08-05,
with only its capability-matrix section current to 2026-08-10 — several of its
checklist items are already done and just not marked. `queue.tsv` is a task
queue where "resolved" rows get commented out, but a real backlog of T12–T14
rows was never triaged against what actually shipped. And until today, the
actual approved design for Marginalia's canvas UX (§1) existed only as a
picture on Wolf's computer, not in the repo at all — `KNOWN_ISSUES.md` and
`FLEET-STATUS.md` both describe the gap as an abstract feature list because
that's all anyone building from the repo had to go on. None of these sources
is wrong so much as none is a complete current picture alone — that's what
this file is for. Once §2–§4 are done and §1/§5 have Wolf's answers, it will
be safe to delete this file too.*
