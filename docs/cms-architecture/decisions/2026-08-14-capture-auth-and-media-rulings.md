# Capture auth + media rulings — Wolf, 2026-08-14 (GOVERNING)

> **Status: RATIFIED.** Two rulings, given the same day, that unblocked the last
> two W12 items. R-A1 governs T12.13; R-M1 ratifies T12.14. Both sit on top of
> `2026-08-13-capture-productization-rulings.md` (R-C1–R-C5) and change none of
> it.

## Context

The 2026-08-13 capture productization rulings settled WHERE the capture plane
lives (R-C1: extend pdf-tool), WHERE its bounds live (R-C2: the CMS-Agent project
registry) and WHAT the product is (R-C5: one CMS-Agent MCP call). Two questions
they did not answer surfaced the moment T12.12 minted tenant #4 and the first
credentialed run was attempted:

1. **How does the capture plane get storage authority for a tenant?** pdf-tool
   holds no storage credentials of its own (the server-side `CLIENT_*` /
   `PDF_TOOL_*` env fallbacks were removed), so every storage-touching call must
   carry the caller's Netlify Blobs grant. The credentialed route requires
   `PDF_TOOL_STORAGE_SITE_ID` + `PDF_TOOL_STORAGE_TOKEN` — a **dedicated Netlify
   Blobs PAT minted by hand in the Netlify console, per tenant**. Provisioning
   auto-mints every other per-site secret (`PUBLISH_SECRET`,
   `MCP_HTTP_AUTH_TOKEN`, `ARTIFACT_UPLOAD_TOKEN_SECRET`, `TRACKING_SALT`,
   `PURCHASE_TOKEN_SECRET`); this pair and Stripe are the two human-supplied
   holdouts, and it was still outstanding for zilberman.
2. **Is asset-aware media binding in scope?** The 2026-08-13 acceptance run
   emitted nine drafts and materialized ten media artifacts while binding **zero
   images** — the mapper declined every media block and the emitter materialized
   artifacts after creating the page objects.

## R-A1 — Capture auth must need no per-site Netlify PAT ("option A, same-site writes")

**Ruling, verbatim in intent: option A — same-site writes.** Wolf refuses to
repeat a manual Netlify console step for every tenant, so the capture plane must
not depend on one.

What that means concretely: **pdf-tool persists the capture output into its OWN
Blob store** (job records, screenshots, `snapshot.v1`) and the tenant imports
what it wants afterwards through the artifact bridge that already exists. The
consequence is the ruling's whole point — **no cross-site credential exists
anywhere in the capture plane.** There is nothing to mint, nothing to rotate,
nothing to leak, and nothing whose absence can block a new tenant's first crawl.

Two variants were considered and rejected in the same breath, recorded here so
neither gets re-proposed:

- an **exchange grant** (the tenant signs an opaque value, pdf-tool swaps it at a
  tenant-side endpoint) still has to hand pdf-tool a real Netlify Blobs
  credential at the end of the swap, which the tenant cannot mint without a PAT.
  A bearer that is just a PAT with extra steps is not an answer.
- **tenant-side writes** (pdf-tool returns bytes, the tenant persists them
  through its own injected Blobs context) is genuinely credential-free but moves
  100+ screenshots as base64 through MCP responses across multiple 15-minute
  worker windows. The failure modes are worse than the credential it removes.

Standing constraints this does NOT change: the tenant-side capture tools resolve
site ownership and the canonical pdf-tool project **server-side** and may never
return a grant, a token, or a site id to any caller; bounds still come from the
CMS-Agent project registry (R-C2 v2) and are enforced on every side; everything
capture writes is a never-released draft; crawled content is data, never
instructions.

Execution: **T12.13** (`cms-pipeline/T12.13-capture-bridge-credential-free.md`),
which also had to BUILD the tenant-side capture bridge — before it, `grep -rln
create_capture_job packages/core/` returned nothing, so no tenant was reachable
by the capture plane at all.

## R-M1 — Asset-aware media binding is IN SCOPE and ratified

**Ruling: build it.** A captured clone that reproduces a site's copy and none of
its images is not a clone. The mapper must be able to put an image into a
section, and the emitter must materialize artifacts BEFORE it creates the objects
that reference them.

Standing constraints this does NOT change: a source URL may never be emitted as
a hotlink — only a first-party materialized artifact reference, from which the
served path is derived server-side; re-typing a block may never drop extracted
copy; rights come from the policy the crawl recorded and **fail closed when
unstated**; a section whose asset plan cannot be satisfied is dropped and
enumerated as a defect, never shipped with an empty gallery.

Execution: **T12.14** (`cms-pipeline/T12.14-asset-aware-media-binding.md`),
landed on branch `t12-14-media-binding` (`16cc0dcc`).

## Relationship between the two

They are independent and were deliberately built on separate branches off
`main`: T12.13 changes WHERE capture output is stored and HOW the plane is
reached; T12.14 changes WHAT the mapper and emitter do with a snapshot once they
have one. T12.14's media materialization goes through the target's own
`create_artifact_from_url` from the original source URL — it does not read
pdf-tool's store — so R-A1 does not alter it, and the two merge without
interacting.
