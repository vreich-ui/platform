# Backlog triage — the pre-W15 queue rows (2026-08-10)

**Read-only triage.** No task in this document was executed. Every verdict below
was reached by finding (or failing to find) the concrete artifact each brief says
it will produce — a file, a script, a doc section, a schema, a tool. **No row was
closed on the strength of a commit message.** Where a commit is cited it is a
pointer to the change that created an artifact this triage opened and read, not
the evidence itself.

**Scope.** The 28 uncommented rows in `queue.tsv` that predate the W15/W16
numbering: `T12.1`–`T12.6`, `T13.1`–`T13.13`, `T14.2`–`T14.10`.

**Counts.** 28 examined · **21 CLOSED** · **7 OPEN** · **0 UNCLEAR**.

Closed rows are commented out in `queue.tsv` following the `#W15.S3` /
`#W15.S4x` / `#W15.LEAK` / `#W15.FOLD` pattern — a prose block naming the
evidence, then the row itself prefixed with `#`, left in place for the audit
trail. Open rows were not touched.

Paths below are given in the current (post-W11) tree. Several briefs name
pre-relocation paths (`src/schema/…`, `netlify/lib/…`, `scripts/lib/…`); the
artifact was matched to its `packages/core/…` or `sites/<client>/…` counterpart,
which is the relocation the W11 rows performed and CLAUDE.md's framing note
sanctions.

---

## Verdicts

| Row        | Brief                                    | Verdict | Evidence                                                                                                                                                                                       | Note                                                                                                                                             |
| ---------- | ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **T12.1**  | `T12.1-capture-spike.md`                 | OPEN    | No `packages/core/cli/capture/` and no `scripts/capture/`; `docs/cms-architecture/capture-spike-findings.md` absent; the only `snapshot.v1` strings in the repo are inside the T12.1–T12.3 briefs. | Nothing of W12 was ever built.                                                                                                                    |
| **T12.2**  | `T12.2-decomposition-mapper.md`          | OPEN    | No `capture/map.mjs`; no mapping artifact or gap-report format anywhere.                                                                                                                          | Gated on T12.1 regardless.                                                                                                                        |
| **T12.3**  | `T12.3-theme-extraction.md`              | OPEN    | No `capture/theme.mjs`; no fixture swatch report.                                                                                                                                                | Its other dependency, T10.2, IS built (`tests/netlify/theme-axes-apply.test.ts`), so only T12.1 blocks it.                                         |
| **T12.4**  | `T12.4-emission-pipeline.md`             | OPEN    | No `capture/emit.mjs`; no run-report format.                                                                                                                                                     | **Stale `depends_on`** — it names T11.11, which W14 superseded. The landing zone now has to be re-stated as "the target tenant's own store."       |
| **T12.5**  | `T12.5-fidelity-loop.md`                 | OPEN    | No `capture/score.mjs`; `design-vocabulary-gaps.md` carries no capture-fed entries.                                                                                                              | —                                                                                                                                                 |
| **T12.6**  | `T12.6-capture-acceptance-run.md`        | OPEN    | No acceptance run recorded in `state-of-play.md`; `11-platformization-plan.md` §3 status never flipped.                                                                                          | **Stale `depends_on`** — names "T11.11 staging site live"; the staging tenant is now the platform site (or Fernwell).                              |
| **T13.1**  | `T13.1-tracking-attribute.md`            | CLOSED  | `packages/core/schema/bodies/tracking-attribute-v1.ts`; `...trackingAttributeShape` spread on all ten body schemas; `set_tracking` + the seven `forbidKeys` refusals in `schema/object-patch-ops.ts`; `tests/netlify/tracking-attribute.test.ts`. Commit `6bb7446a`. | —                                                                                                                                                 |
| **T13.2**  | `T13.2-tracking-config-type.md`          | CLOSED  | `packages/core/schema/bodies/tracking-config-v1.ts`; `server/lib/materializers/tracking-config.ts`; `tests/netlify/tracking-config.test.ts`. Commit `82c7baa3`.                                   | The eleventh governed type exists in schema. Note CLAUDE.md still says "TEN governed types" — pre-W13 text, not a triage finding.                  |
| **T13.3**  | `T13.3-tracking-event-ingest.md`         | CLOSED  | `packages/core/schema/tracking-event-v1.ts`; `server/lib/tracking-events.ts`; `server/functions/track-ingest.ts`; `tests/netlify/tracking-ingest.test.ts`. Commit `3da00f7b`.                     | `/api/t` was probed live in T14.6 (`track-ingest` → 400 schema), so the relay is deployed, not merely committed.                                   |
| **T13.4**  | `T13.4-own-tracker-loader.md`            | CLOSED  | `packages/core/lib/tracking/loader/{index,core,dom,bridge,persistent-id}.ts`; `tests/netlify/tracking-loader.test.ts`. Commit `a69184ac`.                                                         | —                                                                                                                                                 |
| **T13.5**  | `T13.5-tracking-scripts-component.md`    | CLOSED  | `packages/core/app/components/tracking/TrackingScripts.astro`, imported and mounted in `app/layouts/Layout.astro`; adapters `own.ts` + `plausible.ts`; `Analytics.astro`/`SplitbeeAnalytics.astro` verified GONE from the tree; `tests/netlify/tracking-scripts.test.ts`. Commit `8860496a`. | —                                                                                                                                                 |
| **T13.6**  | `T13.6-consent-banner-geo.md`            | CLOSED  | `app/components/tracking/ConsentBanner.astro`; `lib/tracking/consent/runtime.ts` + `banner-html.ts`. Commit `91e13cbe`.                                                                           | —                                                                                                                                                 |
| **T13.7**  | `T13.7-google-ads-adapter-bridge.md`     | CLOSED  | `lib/tracking/adapters/google-ads.ts` + `ga4.ts`; the goal bridge at `lib/tracking/loader/bridge.ts`. Commit `750ddbb9`.                                                                          | —                                                                                                                                                 |
| **T13.8**  | `T13.8-native-adapters-csp.md`           | CLOSED  | `lib/tracking/adapters/{meta-pixel,taboola,outbrain,mgid}.ts`; `Content-Security-Policy-Report-Only` header present in root `netlify.toml` and in `sites/platform/` + `sites/fernwell/` `netlify.toml`. Commit `d82ce433`. | The header's promotion to enforcing is still T13.11's step 6 — it rides the open row, not this one.                                                |
| **T13.9**  | `T13.9-owner-db-reference-kit.md`        | CLOSED  | `docs/cms-architecture/tracking-sink-reference/README.md` + `schema.sql`; `scripts/tracking-mirror-replay.mjs` + `scripts/lib/tracking-replay.mjs`; `tests/scripts/tracking-replay.test.mjs`. Commit `8fb3a64e`. | —                                                                                                                                                 |
| **T13.10** | `T13.10-tracking-seeds-roundtrip.md`     | CLOSED  | `sites/{drlurie,platform,fernwell}/seeds/tracking-config-seed-data.mjs`; the `set_tracking` and `set_tracking_config_fields` drills in `scripts/lib/roundtrip-drill.mjs` + `roundtrip-reconcile.mjs`; the ten-type drill in `tests/netlify/tracking-roundtrip-drill.test.ts`, which derives its targets from `objectTypes`. Commit `6fb910c2`. | Seed module relocated from `scripts/lib/` to the per-site seed packs by T11.6 — same artifact, current path.                                       |
| **T13.11** | `T13.11-tracking-production-drive.md`    | OPEN    | `sites/drlurie/data/site/tracking.json` does NOT exist — `trk_drlurie` was never published to Dr-Lurie's production store. No drive entry in `state-of-play.md`.                                  | See the note below — this is the only W13 row left, and its scope has drifted since it was written.                                                |
| **T13.12** | `T13.12-admin-governance-toggle.md`      | CLOSED  | `packages/core/admin/GovernancePage.tsx`, routed at `app/routes/admin/settings/guardrails.astro`; `tests/netlify/tracking-governance.test.ts`; `packages/core/lib/admin/tracking-governance.ts`. Commit `5414d701`. | —                                                                                                                                                 |
| **T13.13** | `T13.13-scores-feedback-design.md`       | CLOSED  | `12-object-tracking-and-analytics.md` §15 "Scores-feedback design" exists as the brief specifies (design only). Commit `a9fe2740`.                                                                | The go/no-go it recommends is still Wolf's to rule — that is the doc's content, not an unfinished task.                                            |
| **T14.2**  | `T14.2-platform-genesis.md`              | CLOSED  | `sites/platform/` with its own `netlify.toml`, `astro.config.ts`, `site.config.ts`, `config/`, `seeds/`, `data/`, `netlify/` shims. Commit `5713fd8b`.                                            | —                                                                                                                                                 |
| **T14.3**  | `T14.3-platform-provisioning-repo-rename.md` | CLOSED | Platform Netlify project provisioned (commit `466295ea`); repo renamed to `platform` — CLAUDE.md's repo note and `T14.3-checklist.md`'s later annotations both describe the completed rename.     | Human gate, executed. T14.9 later superseded this brief's "the API cannot do repo-link/Identity" claim.                                            |
| **T14.4**  | `T14.4-fleet-propagation-proof.md`       | CLOSED  | `state-of-play.md`: "**T14.4 is closed.** Wolf confirmed all checks GREEN"; two live `/mcp` endpoints recorded with refs; `scripts/ci/discover-fleet-matrix.mjs` present and later observed reporting three sites. Commits `a13b14c5`, `b25aa131`, `65c70bf1`. | —                                                                                                                                                 |
| **T14.5**  | `T14.5-instruction-manual.md`            | CLOSED  | 15 manual pages under `sites/platform/data/site/pages/page_manual_*.json` (one per governed type plus lifecycle/roles/genesis/tracking); `scripts/platform-manual-drive.mjs` with a `--check` drift-guard mode. Commit `3b825cc0`. | **Deviation worth knowing:** the drift guard is a driver flag run against a live `/mcp`, not a suite test — it cannot catch drift in CI, only when someone runs it. Recorded as passing 15/15 in `w14-findings.md`. |
| **T14.6**  | `T14.6-test-plan-execution.md`           | CLOSED  | `docs/cms-architecture/cms-pipeline/w14-findings.md` — authorization matrix, per-site probes, MCP parity counts, and an explicit "gated / not completed here" section. Commit `b35ca323`.         | —                                                                                                                                                 |
| **T14.7**  | `T14.7-fix-wave.md`                      | CLOSED  | The disposition table at the top of `w14-findings.md`: F1–F13 each fixed-and-verified, routed to a named task, or `wontfix-v1` with a reason. Commit `6afa172f`; F11–F13 tail in PR #499.        | The brief's "fully dispositioned" bar is met literally — every row has a disposition.                                                              |
| **T14.8**  | `T14.8-agent-connection-hygiene.md`      | CLOSED  | The fail-closed `/mcp` gate is in `packages/core/server/functions/mcp.ts` (the "W14 F1" branch: an unset shared token opens only outside a lambda runtime); `server/lib/agent-keys.ts` exists. Commits `5c76e3a1`, `ed3a1d28`. | **Read the caveat.** Only the F1 code half shipped. Per-agent key rollout was deferred post-V1 and the PUBLISH_SECRET rotation was ruled "ignore it" — both Wolf, 2026-07-26 — and both sit on the V1 deferred list in `state-of-play.md`. Closing the row does not drop them; reinstating either wants a NEW row, not a re-run of this brief (whose step 4 Wolf has explicitly cancelled). |
| **T14.9**  | `T14.9-synthetic-third-site.md`          | CLOSED  | `sites/fernwell/` exists as a full site tree; `scripts/site-genesis-drive.mjs` is the committed genesis driver the run produced; the "T14.9 CLOSED — Fernwell is LIVE" entry records the timing table, the live round-trip (export commit `b7c8792`), and fleet CI discovering three sites. Commit `bf84be25`. | This entry supersedes the earlier, more cautious "live runtime proof pending" line inside the T14.10 summary — the T14.9 close-out is the later record. The optional retirement half is Wolf's to trigger; Fernwell stays up. |
| **T14.10** | `T14.10-v1-closeout.md`                  | CLOSED  | `docs/cms-architecture/13-separation-plan.md` (design-only, as specified); the V1 declaration entry in `state-of-play.md` with the honest deferred list; CLAUDE.md's platform framing + R8 verbatim. Commit `ed3a1d28`. | —                                                                                                                                                 |

---

## UNCLEAR

**None.** Every row in scope resolved cleanly in one direction. Two rows carry
caveats rather than ambiguity, and both are stated inline above and in
`queue.tsv`'s comment blocks: T14.8 (closed on a Wolf ruling that deferred half
its scope) and T14.5 (closed with a drift guard that is a driver flag, not a CI
test).

---

## Other findings

1. **T13.11's scope has drifted since it was written, and someone should re-read
   it before it runs.** The brief targets `trk_drlurie` on a two-site world. Since
   then `tracking_config` has been folded into genesis: all three sites carry a
   `seeds/tracking-config-seed-data.mjs`, and `sites/platform/data/site/tracking.json`
   is a real published export — so the type already has a live export on one
   tenant, while Dr-Lurie, the brief's actual subject, has none. The row is
   correctly still OPEN (no live beacons, no CSP-soak decision, no five-criteria
   record), but its checklist should be restated fleet-wide rather than
   Dr-Lurie-only when it is picked up.

2. **Two W12 briefs depend on a superseded row.** T12.4 and T12.6 both name
   `T11.11` (the second-site acceptance) as a dependency and its staging client as
   the landing zone. T11.11 was superseded by W14 and is commented out. Whoever
   schedules W12 has to re-point the landing zone at a real tenant first;
   `depends_on` as written can never be satisfied.

3. **All 91 `briefPath` values in `queue.tsv` resolve to files that exist** —
   including the rows outside this triage's scope. No missing briefs.

4. **`run-next-task.sh` does not skip `#` lines.** Its `next_task()` reads every
   line of the queue file and returns the first whose id is not marked done in
   `state.tsv`; a `#`-prefixed row parses as an id of `#T13.1`. Commenting rows
   out is therefore an audit-trail convention for humans (and the convention the
   W15 rows already set), not a mechanism the runner enforces. The runner also
   reads `.cms-pipeline/queue.tsv`, not this file. Nothing to fix as part of this
   triage — recorded so nobody assumes the comment markers are load-bearing.

5. **Out of scope but worth one sweep later:** `T0.*`, `T9.*`, `T10.*`, `T11.0`–
   `T11.10`, `T14.0` and `T14.1` are also still uncommented in `queue.tsv` despite
   being historically complete. This triage was scoped to the T12/T13/T14.2+
   block and deliberately left them alone.
