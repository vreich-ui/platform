# pdf-tool agent artifact orchestration

`pdf-tool` is the artifact generation and storage utility for agent-created images, PDFs, and related binary outputs. Dr. Lurie remains the owner of workflow JSON and publication state; agents own orchestration between the two systems.

## Storage grants (stateless pdf-tool)

`pdf-tool` is stateless and holds no blob credentials: it writes artifacts, templates, image-search state, and its job records directly into Dr. Lurie's Netlify Blob stores using a short-lived storage grant. Platform now mints and forwards that grant server-side through its artifact bridge; grants and storage tokens never enter agent context. Full contract, store list, provisioning, and rotation runbook: [`pdf-tool-storage-grant.md`](pdf-tool-storage-grant.md).

Rules for every agent driving `pdf-tool`:

1. Call Dr. Lurie's `create_agent_artifact_job` Platform tool with `site_id` + the existing content-item `request_id`. Do not call pdf-tool directly, guess `projectId`, or request/pass a grant.
2. Store returned `ArtifactReference` objects in workflow JSON as usual. **NEVER** write the grant or its token into workflow JSON, drafts, or any persisted blob.
3. Poll Dr. Lurie's `get_agent_artifact_job_status` with the returned job id; do not recreate jobs while they are pending/running.
4. Platform refreshes grants per call and verifies completed artifacts server-side. Use only the returned `artifactReference` and `public_path`; proofs stay internal.
5. Honor the grant's `limits` (per-site media policy). When you create or store an image, target `preferredImageFormat` (web-optimized) and keep it within `maxImageBytes` (~150 KB) — pass a matching `requirements.maxBytes` on the `pdf-tool` job. `maxImageBytes` is the site's hard cap; `requirements.maxBytes` may only lower it, never raise it. If an image ends up over budget, `overBudget: "block"` means it is rejected and `overBudget: "warn"` means it may be stored but is flagged — only exceed the budget on an explicit human/admin request. To fix an already-stored oversize image, ask `pdf-tool` to shrink it (re-encode under `maxImageBytes`) rather than leaving it oversize.

There is no raw grant RPC. The three visible bridge tools are the supported
agent contract, so storage credentials cannot enter agent context even if a
legacy tool name is guessed.

## Rendering a PDF FOR AN ARTICLE (W2): use `render_article_pdf`, not the raw job flow

Everything below this point in the doc describes the general artifact-job flow (any
`artifact_kind`, any `template_id`). For the common case — "make a PDF of this content_item
article" — skip straight to **`render_article_pdf {site_id, content_item_id, template_id?,
filename?, attach?}`**. It runs build render data → resolve template → create job → poll to
completion → read the quality gate → attach as a `document` media node, as one call, and
returns a receipt (`status`, `jobId`, `rendered`, `attached`, `qualityGate`, `warnings[]`,
`unfilled[]`, `summary`). It never hand-authors `data` — that is exactly the mistake that
produced a `[object Object]`/blank-page PDF on 2026-09-03.

Five read-only tools support it, none of which cost a render:

| Tool | What it answers |
|---|---|
| `build_pdf_render_data` | What would this article map to as render data — `{data, assets, unfilled}` — without creating a job. |
| `validate_pdf_render_data` | Does this `data`/`assets` pair satisfy a template's `renderDataSchema` and asset list, without spending a render. |
| `get_pdf_render_brand` | What brand payload (object, string, or nothing) a template will actually receive — see the D-3 rule below. |
| `verify_pdf_content` | Inspect one already-rendered PDF's content quality standalone (page count, body text, image resolution, leaked tokens). |
| `validate_content_item` | The standalone form of `object_validate` for one article, including its `pdf_quality` warning when a prior PDF check exists. |

**Content quality WARNS, it never blocks (ruling D-A).** A render that completes with
quality-gate findings still attaches; only a typed pdf-tool failure (`RENDER_DATA_INVALID`,
`ASSET_MISSING`, `DATA_BINDING_ERROR`, …) is a real failure. Full ruling set (D-A–D-D) and the
bridge's D-1–D-4 defaults (template resolution via `site.pdf`, the mapper running by default,
brand-shape-aware injection, filename/requirements defaults):
[`../cms-architecture/decisions/2026-09-03-pdf-fortification-rulings.md`](../cms-architecture/decisions/2026-09-03-pdf-fortification-rulings.md).
The mapper itself lives at `packages/core/lib/pdf/render-data-mapper.ts` (ruling D-C — this
platform's own mapper, not cms-agent's workflow-plane one).

## Current architecture

1. The agent creates or updates the Dr. Lurie workflow JSON through the existing Dr. Lurie MCP checkout, patch, and checkin tools.
2. The agent calls Dr. Lurie's Platform bridge to create an artifact job; Platform resolves `site_drlurie → dr-lurie`, checks that the request is an owned `content_item`, and calls pdf-tool with the grant server-side, as a `create_agent_artifact_job` `tools/call` against pdf-tool's single `/mcp` endpoint:

   ```http
   POST {PDF_TOOL_BASE_URL}/.netlify/functions/mcp
   ```

3. The agent polls the Platform bridge until the job completes; Platform itself calls pdf-tool's `get_agent_artifact_job_status` tool the same way, through the same `/mcp` endpoint:

   ```http
   POST {PDF_TOOL_BASE_URL}/.netlify/functions/mcp
   ```

   (L1: Platform used to call eleven separate standalone Netlify Functions, one per pdf-tool operation -- each is its own function container, so calls kept landing on cold, unwarmed instances even when pdf-tool's `mcp` function itself was warm. Every call now routes through that one already-warm `/mcp` endpoint instead, as a `tools/call` naming the equivalent tool.)

4. Platform verifies pdf-tool's materialization response and returns a Dr. Lurie-native `ArtifactReference` plus `/img/...` or `/pdf/...` public path, with no grant or proof.
5. The agent uses the existing Dr. Lurie MCP checkout, patch, and checkin tools to insert that `ArtifactReference` into the authoritative workflow JSON.
6. A later trusted publisher reads the stored `ArtifactReference` from workflow state and resolves it through the existing publication path.

The bridge is deliberately narrow: create, poll, and lookup-by-slot. Object patch/validation remains on the ordinary governed object verbs.

## Runtime configuration

The Platform server deployment that bridges to `pdf-tool` must be configured
with:

- `PDF_TOOL_BASE_URL=https://pdf-x.netlify.app`
- `PDF_TOOL_AGENT_RUN_TOKEN`

Keep `PDF_TOOL_AGENT_RUN_TOKEN` in the server-side secret store. Do not put it
in agent context, browser code, workflow JSON, checked-in configuration,
prompts, or tool schemas.

## ArtifactReference contract

Store only the returned immutable `ArtifactReference` object in workflow JSON. Do not store binary bytes, base64 payloads, generated URLs, guessed blob keys, or partial references in workflow JSON.

The returned reference has this shape:

```json
{
  "blobKey": "...",
  "sizeBytes": 0,
  "sha256": "...",
  "contentType": "image/webp",
  "createdAtISO": "2026-06-20T00:00:00.000Z",
  "artifactKind": "image",
  "originalFilename": "hero.webp",
  "label": "Hero image",
  "tags": ["hero"],
  "metadata": {}
}
```

Treat every `ArtifactReference` as immutable. If an artifact must be regenerated, create a new `pdf-tool` job and store the newly returned reference.

## Example agent flow: hero image slot

1. Check out the Dr. Lurie workflow JSON with the existing MCP checkout tool.
2. Patch or confirm the workflow contains a planned hero image slot, for example `slot: "hero"` in the relevant stage metadata.
3. Call Platform `create_agent_artifact_job` with `site_id`, the workflow
   `request_id`, and `slot: "hero"`; Platform supplies the service URL, run
   token, canonical project, and storage grant server-side.
4. Poll Platform `get_agent_artifact_job_status` until the job is complete.
5. Read the completed job response and copy the returned `ArtifactReference` exactly as returned.
6. Check out the latest Dr. Lurie workflow JSON again, patch the hero slot with the returned `ArtifactReference`, and check in the workflow lock through the existing Dr. Lurie MCP tools.
7. Leave publication unchanged. The publisher later reads the stored `ArtifactReference` from workflow JSON and resolves it through the current server-side publishing path.
