/**
 * A5 — repo-wide acceptance: after converting Render sample, Preview sample
 * (first page only) and Regenerate examples to direct endpoints, no
 * `onIntent` call should remain in `ImageryBoard.tsx` or
 * `PdfTemplatesPanel.tsx` except the two genuinely conversational ones —
 * Retheme (which lives one level up, in `VisualIdentityWorkspace.tsx`, and
 * never reaches either of these two files) and "Write the house standard"
 * (ImageryBoard's empty-state propose, `buildProposeContractIntent({
 * standard: undefined, ... })` — there is no standard id yet to propose
 * against, and no mood board, only a brief: free-form advice, not a
 * mechanical action).
 *
 * A targeted text scan, not a parity/behavior test — `.tsx` files are
 * excluded from `tsconfig.test.json` (see either component's own header),
 * so this is the one place a regression here (someone routing a NEW button
 * back through the chat rail) gets caught at all.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGERY_BOARD = join(ROOT, 'packages', 'core', 'admin', 'ImageryBoard.tsx');
const PDF_TEMPLATES_PANEL = join(ROOT, 'packages', 'core', 'admin', 'PdfTemplatesPanel.tsx');

const onIntentCallCount = (source) => (source.match(/\bonIntent\(/g) ?? []).length;

test('PdfTemplatesPanel.tsx no longer calls onIntent anywhere — Render sample and the first-page-only chip are both direct endpoints', () => {
  const source = readFileSync(PDF_TEMPLATES_PANEL, 'utf8');
  assert.equal(onIntentCallCount(source), 0, 'PdfTemplatesPanel.tsx must not call onIntent (A5 converted both its actions)');
  // The PROP itself should be gone too, not just unused — dead wiring is not
  // "converted". Scoped to the prop's own declaration/destructure/type sites
  // (not a blanket ban on the word, which this file's own doc comments use
  // to explain what changed).
  assert.doesNotMatch(source, /onIntent\s*:/, 'the onIntent prop must be removed from PdfTemplatesPanelProps');
  assert.doesNotMatch(source, /\bonIntent,/, 'the onIntent prop must be removed from the destructured props');
  assert.doesNotMatch(source, /VisualIdentityChatIntent/, 'the chat-intent type import is no longer needed here');
  assert.doesNotMatch(source, /buildRenderSampleIntent|buildPreviewSampleIntent/, 'the retired chat-intent builders must not be imported');
  assert.match(source, /renderPdfTemplateSample/, 'Render sample must call the A5 client');
  assert.match(source, /previewPdfTemplateSample/, 'the first-page-only chip must call the A5 client');
});

test('ImageryBoard.tsx keeps exactly one onIntent call — the "no standard yet" free-form propose', () => {
  const source = readFileSync(IMAGERY_BOARD, 'utf8');
  const calls = onIntentCallCount(source);
  assert.equal(calls, 1, `expected exactly one onIntent( call in ImageryBoard.tsx (the free-form empty-state propose), found ${calls}`);
  assert.match(
    source,
    /onIntent\(\s*buildProposeContractIntent\(\{\s*standard:\s*undefined,\s*mode:\s*'house'\s*\}\)\s*\)/,
    'the one remaining onIntent call must be the empty-state "Write the house standard" propose — genuinely conversational, no standard id exists yet'
  );
  // Regenerate examples is the LAST mechanical action this file used to hand
  // to onIntent (A1 already converted import, A3 already converted the
  // mood-board propose) — its builder must be gone entirely.
  assert.doesNotMatch(source, /buildRegenerateExamplesIntent/, 'the retired regenerate-examples chat-intent builder must not be imported');
  assert.match(source, /regenerateVisualStandardExamples/, 'Regenerate examples must call the A5 client');
  // A1/A3 stay converted (a regression guard, not new A5 scope).
  assert.doesNotMatch(source, /buildImportReferencesIntent/, 'A1 already converted Import references — it must stay off onIntent');
  assert.doesNotMatch(source, /onIntent\(\s*buildApplyProposalIntent/, 'A3 already converted "Make this the site\'s imagery" — it must stay off onIntent');
});
