import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateDocumentContent,
  parseDocumentContentInspection,
  type DocumentContentInspection,
} from './document-content-check.js';

// The 2026-09-03 defect, reconstructed from BRIEF §0: a 5-page render, four pages with no
// body text (only the baked-in kicker survived), three images that never resolved, and the
// `[object Object]` leak twice.
const brokenMoisturizerInspection: DocumentContentInspection = {
  pageCount: 5,
  sizeBytes: 812_000,
  qualityGate: {
    passed: false,
    findings: [
      { code: 'BLANK_PAGE', page: 2, detail: 'Page 2 has 6 characters of extracted text.' },
      { code: 'BLANK_PAGE', page: 3, detail: 'Page 3 has 0 characters of extracted text.' },
      { code: 'BLANK_PAGE', page: 4, detail: 'Page 4 has 6 characters of extracted text.' },
      { code: 'BLANK_PAGE', page: 5, detail: 'Page 5 has 6 characters of extracted text.' },
      { code: 'UNRESOLVED_IMAGE', page: 2, detail: 'No asset named "heroShot".' },
      { code: 'UNRESOLVED_IMAGE', page: 3, detail: 'No asset named "ingredientDiagram".' },
      { code: 'UNRESOLVED_IMAGE', page: 4, detail: 'No asset named "afterPhoto".' },
      { code: 'UNRENDERED_TOKEN', page: 1, detail: 'Found "[object Object]".' },
      { code: 'UNRENDERED_TOKEN', page: 2, detail: 'Found "[object Object]".' },
    ],
  },
};

const healthyInspection: DocumentContentInspection = {
  pageCount: 6,
  sizeBytes: 430_000,
  qualityGate: { passed: true, findings: [] },
};

test('evaluateDocumentContent fails the broken 2026-09-03 shape and names what was wrong', () => {
  const verdict = evaluateDocumentContent(brokenMoisturizerInspection);

  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error('unreachable');
  assert.match(verdict.reason, /4 page.*no readable body text/i);
  assert.match(verdict.reason, /3 image.*failed to resolve/i);
  assert.match(verdict.reason, /2 unrendered template token/i);
  assert.equal(verdict.findings.length, brokenMoisturizerInspection.qualityGate.findings.length);
});

test('evaluateDocumentContent passes a healthy multi-page PDF with text on every page', () => {
  const verdict = evaluateDocumentContent(healthyInspection);

  assert.deepEqual(verdict, { ok: true, pageCount: 6, sizeBytes: 430_000 });
});

/**
 * W2 REVIEW: a one-page PDF with a clean gate PASSES by default now.
 *
 * This used to fail on a default `minPageCount: 2`, so any caller that simply
 * passed `expectedDocuments` failed a legitimately one-page document — a
 * checklist, a lead magnet, a one-page brochure — on a floor it never asked
 * for. A page-count floor belongs to the job that produced the document
 * (`requirements.pageCount`, enforced by pdf-tool at render), not to a
 * verifier's default. The findings that actually catch the 2026-09-03 defect
 * are unaffected: see the blank-page / unresolved-image / leaked-token tests
 * above and below.
 */
test('evaluateDocumentContent passes a clean single-page PDF — a page floor is the job\'s to set, not this check\'s', () => {
  const verdict = evaluateDocumentContent({
    pageCount: 1,
    sizeBytes: 100_000,
    qualityGate: { passed: true, findings: [] },
  });

  assert.equal(verdict.ok, true);
  if (!verdict.ok) throw new Error('unreachable');
  assert.equal(verdict.pageCount, 1);
});

test('evaluateDocumentContent still fails a ZERO-page PDF — the floor is 1, not absent', () => {
  const verdict = evaluateDocumentContent({
    pageCount: 0,
    sizeBytes: 100,
    qualityGate: { passed: true, findings: [] },
  });

  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error('unreachable');
  assert.match(verdict.reason, /Only 0 page\(s\); at least 1 required\./);
});

test('a one-page PDF with real content findings still fails — the gate is what this check is for', () => {
  const verdict = evaluateDocumentContent({
    pageCount: 1,
    sizeBytes: 100_000,
    qualityGate: {
      passed: false,
      findings: [{ code: 'UNRENDERED_TOKEN', page: 1, detail: 'a template token survived' }],
    },
  });

  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error('unreachable');
  assert.match(verdict.reason, /unrendered template token/);
  assert.equal(/page\(s\)/.test(verdict.reason), false, 'and never with an invented page-count complaint');
});

test('evaluateDocumentContent enforces an explicit maxBytes requirement', () => {
  const verdict = evaluateDocumentContent(healthyInspection, { maxBytes: 100_000 });

  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error('unreachable');
  assert.match(verdict.reason, /430000 bytes, exceeding the 100000-byte limit\./);
});

test('evaluateDocumentContent honors a custom minPageCount — a caller who asks for a floor gets it', () => {
  const verdict = evaluateDocumentContent(healthyInspection, { minPageCount: 10 });

  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error('unreachable');
  assert.match(verdict.reason, /Only 6 page\(s\); at least 10 required\./);

  // Including the floor the default used to impose, when it is asked for.
  const twoPageFloor = evaluateDocumentContent(
    { pageCount: 1, sizeBytes: 100, qualityGate: { passed: true, findings: [] } },
    { minPageCount: 2 }
  );
  assert.equal(twoPageFloor.ok, false);
  if (twoPageFloor.ok) throw new Error('unreachable');
  assert.match(twoPageFloor.reason, /Only 1 page\(s\); at least 2 required\./);
});

test('parseDocumentContentInspection accepts a well-formed pdf-tool inspection response', () => {
  const parsed = parseDocumentContentInspection(healthyInspection);
  assert.equal(parsed.ok, true);
});

test('parseDocumentContentInspection rejects an unexpected shape rather than guessing', () => {
  const parsed = parseDocumentContentInspection({ pageCount: 'five', qualityGate: null });
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error('unreachable');
  assert.match(parsed.reason, /unexpected shape/);
});

test('parseDocumentContentInspection rejects a missing qualityGate entirely', () => {
  const parsed = parseDocumentContentInspection({ pageCount: 3, sizeBytes: 1000 });
  assert.equal(parsed.ok, false);
});
