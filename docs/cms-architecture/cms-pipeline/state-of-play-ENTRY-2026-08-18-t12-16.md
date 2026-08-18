<!-- SIDECAR ENTRY — fold into state-of-play.md at the top (newest entry first).
     Landed as a sidecar because state-of-play.md is ~507KB and the session that
     wrote this could not push over git (the proxy withheld credentials); the
     GitHub API requires whole-file content inline. Same convention as
     state-of-play-ENTRY-2026-08-13-w12-briefs-refresh.md and
     state-of-play-ENTRY-2026-08-04-w15-s3.md. -->

## 2026-08-18 — T12.16: captured images bind for real (the extensionless blobKey and the `media` kind that was never fetched)

T12.14 built the binding path; the first live run through it bound **nothing**.
`capture_conductor` run **`run_1787054978582_2o5xu5`** into the `zilberman`
tenant ingested 30 image artifacts successfully — real JPEGs, correct sha256 —
and produced `assetBindings: 0` with 58 quarantines (30 ×
`artifact_reference_not_bindable`, 20 × `unsupported_media_kind`). Every page
draft came out with empty or near-empty `sections`. Two independent causes, both
in the CALLER, neither in the trust regexes.

**Cause 1 — the ingest call sent no `filename`, so the blobKey had no
extension.** `materializeMedia` (`packages/core/cli/capture/emit.mjs:712-770`
at `a8ca67b9`) called `create_artifact_from_url` at `emit.mjs:746` with
requestId/artifactKind/contentType/sourceUrl/size/sha256 and nothing else.
Server-side `createArtifactBlobKey`
(`packages/core/server/lib/artifacts.ts:447`) derives the extension with
`getArtifactExtension(input.filename)`, which returns `''` for an undefined
filename, so every key came out as
`image/req_capture_zilberman_20260818_01/<64-hex>` — no extension. The
bindability gate at `emit.mjs:759` is `MAJOR_KEY_ARTIFACT_REF_RE`
(`packages/core/server/lib/artifact-trust.ts:5`, mirrored at
`packages/core/cli/capture/map.mjs:56`), whose trailing `\.[a-z]+` is
mandatory, so the test could never pass: 30 artifacts ingested, 30 declared
unbindable, 0 hotlinked (the quarantine did its job). **The regex is correct and
was NOT loosened.** An extensionless key is genuinely unservable — the public
path is `/img/<requestId>/<sha>.<ext>` (`PUBLIC_ARTIFACT_PATH_RE`,
`artifact-trust.ts:23`) — so the fix belongs at the caller. `materializeMedia`
now sends `filename: <sha256><ext>`: deterministic, collision-free (it IS the
content hash), path-free, inside `artifactReferenceLimits.originalFilename`.
The extension comes from the **probed/declared contentType**, never the URL
path, because the sources are Wix transform URLs
(`…~mv2.jpg/v1/fill/w_146,h_194,q_75,enc_avif,quality_auto/…`) whose last path
segment is a transform recipe — `extname()` returns `''` or garbage there. Map:
jpeg→`.jpg`, png→`.png`, webp→`.webp`, gif→`.gif`, avif→`.avif`,
svg+xml→`.svg`, pdf→`.pdf`. A contentType with no mapped extension quarantines
(`unmappable_artifact_content_type`, observed contentType recorded) rather than
having one invented for it.

**Cause 2 — `kind: "media"` was rejected before any byte was fetched.**
`artifactKindForCapture` (`emit.mjs:484` at `a8ca67b9`) mapped `image`→`image`,
`document`→`doc`, everything else→`null`, and null quarantined the asset
immediately. The emission plan carried 69 `image`, 60 `media`, 1 `document`; the
60 `media` entries were ordinary Wix gallery **JPEGs** that reached the mapper
through a `<picture>`/`<source>` variant rather than a bare `<img>`
(`packages/core/cli/capture/browser.mjs:271-273` assigns `media` for exactly
that) — real images, dropped unfetched. The mapper's `kind` is now treated as
what it is, a HINT about WHERE the asset was found, and the artifactKind is
derived from the probed contentType: `image/*`→`image`, `application/pdf`→`pdf`,
anything else behind a file link (`document` hint)→`doc`, anything else→
quarantine `unsupported_media_kind` **with the observed contentType recorded**.
The probe now runs BEFORE the kind decision (the rate-limit delay
`capturePolicy.delayMs` moved with it, since the probe is the fetch); the `seen`
dedupe and the `image ⇒ image/*` guard are unchanged. A DOCX still ingests as
`doc` and still cannot bind — `doc/…` fails the Major-Key regex by construction,
which is the correct outcome, not a gap.

**Test evidence.** `node --test packages/core/cli/capture/emit.test.mjs` — 20/20
pass (16 pre-existing + 4 new). The mock transport now mints its blobKey the way
the server does (`<kind>/<requestId>/<sha256><extname(filename)>`, empty
extension when no filename is sent), so the tests exercise the real
relationship rather than a stub. New coverage: a `kind: "media"` JPEG
materializes as an `image` artifact and binds; every ingest call carries a
`<sha256><ext>` filename and every resulting image/pdf key satisfies
`MAJOR_KEY_ARTIFACT_REF_RE` and its `/img|/pdf` public form; an unmappable
contentType (`video/mp4`, `application/octet-stream`, `image/tiff`,
`image/x-icon`) quarantines with the contentType recorded, binds nothing, and
puts no source URL on the wire; a Wix transform URL ending `/v1/fill/w_146`
still yields `.jpg` from the contentType (the test asserts `extname()` on that
path is `''`, so the point cannot rot). Negative control: deleting the one
`filename` line fails 4 tests (13, 17, 18, 20) and passes the other 16. Full
platform suite `npm test`: 2399 + 149 + 54 pass, 0 fail, exit 0.
`npm run fleet:parity`: PASS.

**Fleet parity (P1): no per-site follow-up.** The change is entirely in a core
CLI that is an MCP *client*; `sites/<client>` carry no vendored capture code and
no reference to the capture path (`grep -rln 'artifactKindForCapture|
create_artifact_from_url|capture/emit' sites/` is empty), the ingest tool's
`filename` argument already existed in the tool schema
(`mcp-tool-definitions.ts:885`) and is served identically on every tenant.
The engine was re-vendored into CMS-Agent in the same change, with
`src/agent/capture/provenance.ts` re-pinned.

---
