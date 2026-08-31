# Enablement runbook — turning on CMS-Agent → Dr-Lurie artifact publishing

Ordered switch-flip checklist for enabling end-to-end orchestrated publishing
(currently OFF: the CMS-Agent `dr-lurie` project is a read-only allowlist with
`publishingPolicy.publishEnabled=false`, server-enforced). Items marked ★
require a human/Wolf action — none of them may be performed by an agent on its
own initiative. Work through in order; each step's check must pass before the
next.

## Prerequisites (★ all human)

1. ★ **Rotate `PUBLISH_SECRET`** (Netlify env). It back-ends every MCP
   publish/verify proxy AND the frozen direct-HTTP legacy publish door; it was
   exposed 2026-07-11 and rotation is the guard on that door. Check: old key
   401s, new key works, admin UI unaffected.
2. ★ **Verify pdf-tool storage credentials**: `PDF_TOOL_STORAGE_TOKEN`
   (machine-account PAT per `pdf-tool-storage-grant.md`) +
   `PDF_TOOL_STORAGE_SITE_ID`; run `node scripts/provision-pdf-tool-stores.mjs`.
   Check: the provisioning probe passes all six stores; the raw grant stays
   server-internal.
3. ★ **Provision PDF templates** (failure-class-4 closure): preflight
   `list_pdf_templates` under a fresh grant; if empty, `create_pdf_template` →
   `publish_pdf_template` for each needed template. Check: a dry-run
   `create_agent_artifact_job {artifactKind:'pdf'}` reaches pending without
   "PDF template not found".
4. ★ **Deploy keepalives** on the CMS-Agent and pdf-tool deployments (this
   repo's `mcp-keepalive` pattern; both showed >60 s cold starts 2026-07-19).
   Check: first-call latency after 30 idle minutes stays under the client
   timeout.
5. ★ **Approval posture (OQ-W7-4)**: either keep `content_item` autonomous
   (committed `src/config/approval-policy.ts` default — agent publishes
   directly), or flip it to require-approval and pin approvals via
   `object_review_decide {approval_pin: {request_id, artifact_set,
   release_build:'defer'}}` — M-6 exact-match rules live in
   `netlify/lib/publish-gate.ts`; `object_publish` accepts
   `artifact_set`/`release_build` to satisfy a pin. Record the choice in
   `state-of-play.md`.

## The switch (★ human, CMS-Agent registry)

6. ★ **Extend the dr-lurie allowlist** with the OBJECT-path tool set — writes:
   `object_create`, `object_create_variant`, `object_checkout`,
   `object_refresh_lock`, `object_patch`, `object_validate`, `object_checkin`,
   `object_discard`, `object_publish`; release/verify: `release_to_production`,
   `deploy_status`, `verify_article_images`; reads if absent: `object_get`,
   `object_list`. **Deliberately excluded** (do not add):
   `trigger_netlify_build` (release_to_production is the single release path),
   ALL `save_json_blob_*` (frozen legacy pipeline), `save_artifact` /
   `create_artifact_upload_intent` / `create_artifact_from_url` (grant-only
   artifact posture), `object_review_decide` (approval stays out of the
   publishing client's hands), `wipe_blob_stores` (stays needs_approval).
7. ★ **Flip `publishingPolicy.publishEnabled=true`** for the dr-lurie project
   behind CMS-Agent's explicit PUBLISH gate. A real `workflow_publish_run`
   still requires `approved:true` AND `live:true` AND a GO readiness — the
   flag alone publishes nothing.

## Operating discipline (agents, once enabled)

8. **Produce + verify media first** (contract-alignment doc §3): Platform
   bridge jobs (webp, ≤153,600 bytes) → server-side verification → public paths
   into the content_item body →
   `object_validate` (existence, media paths, budget, hero rules all report
   here). A media failure means publish is NOT attempted — never work around
   it with an unverified ref.
9. **Batch publishes, release ONCE**: every `object_publish` commits dark
   (`[skip netlify]`, `production.live:false`). When the batch is done, ONE
   `release_to_production` deploys everything accumulated. Expect
   `build_not_confirmed_live` on the first call — the in-call wait is capped
   to the serverless budget (~6 s); that is the normal flow, not an error.
10. **Poll to confirmed-live**: `deploy_status {commit: targetCommit}` every
    10–15 s (up to ~5 min) until `deployStatus:"ready"` AND
    `productionConfirmed:true`. `build_ready_not_published` / a ready receipt
    with `productionConfirmed:false` means Netlify Auto Publishing is locked —
    a ★ human unlocks or publishes the deploy in the Netlify UI. `failed` →
    read `errorMessage`, fix content, republish, re-release.
11. **Verify the page**: `verify_article_images {url: <site-origin> +
    production.article_path, expectedImages: [each node media /img/… path],
    expectedDocuments: [each document media /pdf/… path], commit}` — require
    `verified:true, deployReady:true`; each PDF must appear as an `<a href>` /
    `<object data>` on the page and fetch as 200 `application/pdf`.
12. **Rollback (honest)**: the build hook always builds branch HEAD —
    `release_to_production {commit: <older sha>}` can only VERIFY an old
    commit, never rebuild it. Content rollback = revert via object history /
    patch inverses → republish → release again. Deploy rollback = ★ human
    "publish an earlier deploy" in the Netlify UI. Unpublish does not exist
    (OQ-2): a released article stays live until edited — publish only
    go-live-acceptable content.

## Verification drill (before + after the flip)

Run the three-mode drill from the session plan: **A** dry-run (grant →
generate → verify → attach → `object_validate`, negative probes included),
**B** publish-dark (commit proven skipped via `deploy_status`), **C** ★ full
live proof (release → confirmed-live → `verify_article_images` + direct
`/img/`+`/pdf/` fetches). A before the allowlist flip; B+C at enablement and
after any release-path change.
