/**
 * Regression guard for the 2026-08-11 publish-gate incident.
 *
 * pdf-tool began persisting a `filename` field on every stored ArtifactReference on
 * 2026-08-06 (pdf-tool c066798, PR #58 "normalize-artifact-filenames") to carry the
 * collision-resolved display name. Platform's `allowedArtifactReferenceKeys` did not
 * include it, so `isArtifactReference` rejected every reference written from the
 * following deploy onward, `readArtifactReference` returned `undefined`, and the publish
 * gate could not tell that apart from a missing blob — reporting `article_media:
 * "<path> has no artifact behind it … it will 404 on the live page"` over artifacts whose
 * bytes served HTTP 200. 17 of 17 references on kugel-platform and 6 on drluriescience
 * were affected; every one of them carried `filename` and nothing else out of contract.
 *
 * Two things must stay true:
 *   1. `filename` is accepted (and bounded like any other display string).
 *   2. A stored-but-rejected index entry is never reported as an absent one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readArtifactReferenceResult,
  requestArtifactReferenceKey,
} from '../../packages/core/server/lib/artifact-index.js';
import { getArtifactReferenceIssue, isArtifactReference } from '../../packages/core/server/lib/artifacts.js';

const REQUEST_ID = 'req_agent_pdf_tool_image_runbook_20260811_01';
const SHA256 = 'e8a6d6887528441683f5b1c49a63de6c9b52036f33914090f3ccba79a857f3ef';

/** Verbatim shape of the reference pdf-tool stored, as read back from production Blobs. */
const productionReference = () => ({
  blobKey: `image/${REQUEST_ID}/${SHA256}.webp`,
  sizeBytes: 64094,
  sha256: SHA256,
  contentType: 'image/webp',
  createdAtISO: '2026-08-11T12:17:37.860Z',
  artifactKind: 'image',
  originalFilename: 'runbook-hero.webp',
  filename: 'runbook-hero.webp',
  tags: [] as string[],
  metadata: { imageRole: 'featured', usageContext: 'article_header' },
});

const stubStore = (entries: Record<string, string>) => ({
  get: async (key: string) => entries[key] ?? null,
  setJSON: async () => undefined,
  list: async () => ({ blobs: [], directories: [] }),
});

test("a stored reference carrying pdf-tool's collision-resolved filename is valid", () => {
  assert.equal(getArtifactReferenceIssue(productionReference()), undefined);
  assert.equal(isArtifactReference(productionReference()), true);
});

test('filename is still held to the display-name safety envelope', () => {
  assert.match(
    getArtifactReferenceIssue({ ...productionReference(), filename: '../../etc/passwd' }) ?? '',
    /filename must be a filename, not a path/
  );
  assert.match(getArtifactReferenceIssue({ ...productionReference(), filename: 'a'.repeat(161) }) ?? '', /filename/);
  assert.match(getArtifactReferenceIssue({ ...productionReference(), filename: 42 }) ?? '', /filename/);
});

test('the allowlist has not simply been opened up — unknown keys are still rejected', () => {
  assert.match(
    getArtifactReferenceIssue({ ...productionReference(), somethingNew: 'x' }) ?? '',
    /unexpected top-level keys: somethingNew/
  );
});

test('readArtifactReferenceResult tells absent, rejected and ok apart', async () => {
  const key = requestArtifactReferenceKey(REQUEST_ID, SHA256);

  assert.deepEqual(await readArtifactReferenceResult(stubStore({}) as never, REQUEST_ID, SHA256), {
    status: 'absent',
  });

  const ok = await readArtifactReferenceResult(
    stubStore({ [key]: JSON.stringify(productionReference()) }) as never,
    REQUEST_ID,
    SHA256
  );
  assert.equal(ok.status, 'ok');

  // The incident's signature: an entry that IS present must never read as absent.
  const rejected = await readArtifactReferenceResult(
    stubStore({ [key]: JSON.stringify({ ...productionReference(), somethingNew: 'x' }) }) as never,
    REQUEST_ID,
    SHA256
  );
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.status === 'rejected' ? rejected.issue : '', /unexpected top-level keys/);

  const unparseable = await readArtifactReferenceResult(stubStore({ [key]: '{not json' }) as never, REQUEST_ID, SHA256);
  assert.equal(unparseable.status, 'rejected');
});
