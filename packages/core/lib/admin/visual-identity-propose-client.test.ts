import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAcceptProposalOp, referencesReachedWriterLabel } from './visual-identity-propose-client.js';

/**
 * W5 F2 — accepting a proposal. `admin-visual-identity-propose` RETURNS a
 * contract and writes nothing (CMS-Agent's `visual_identity_propose` is
 * read-only by contract), so before this op existed the proposal was rendered
 * on a card and lost on the next reload, and "Make this the site's imagery"
 * went on applying the standard's previous contract.
 */
const PROPOSAL = {
  artifact: 'brand_imagery_proposal.v1',
  mode: 'template',
  brandImagery: { version: 1, medium: 'photograph', styleSentence: 'Soft studio light on matte skin.' },
  rationale: 'The board is photographic, not illustrated.',
  sampleSubjects: ['a jar of moisturizer on marble'],
  confidence: 'high',
  label: 'Clinical clean',
  whenToUse: 'Editorial features about routines.',
};

describe('buildAcceptProposalOp', () => {
  it('writes brandImagery, label, sampleSubjects and whenToUse through the ordinary mood-board op', () => {
    assert.deepEqual(buildAcceptProposalOp(PROPOSAL), {
      op: 'set_visual_standard_fields',
      fields: {
        brandImagery: PROPOSAL.brandImagery,
        label: 'Clinical clean',
        sampleSubjects: ['a jar of moisturizer on marble'],
        whenToUse: 'Editorial features about routines.',
      },
    });
  });

  it('never writes an empty sampleSubjects[] over subjects a standard already has', () => {
    const op = buildAcceptProposalOp({ ...PROPOSAL, sampleSubjects: [] });
    assert.equal('sampleSubjects' in (op?.fields ?? {}), false);
  });

  it('refuses a payload that is not a contract rather than writing half of one', () => {
    assert.equal(buildAcceptProposalOp(undefined), undefined);
    assert.equal(buildAcceptProposalOp({}), undefined);
    assert.equal(buildAcceptProposalOp({ ...PROPOSAL, brandImagery: undefined }), undefined);
    assert.equal(buildAcceptProposalOp({ ...PROPOSAL, label: '   ' }), undefined);
    assert.equal(buildAcceptProposalOp([PROPOSAL]), undefined);
  });
});

describe('referencesReachedWriterLabel', () => {
  it('counts against the WHOLE board, truncation included', () => {
    assert.equal(
      referencesReachedWriterLabel({ referencesTotal: 12, referencesResolved: 8 }),
      '8 of 12 references reached the writer'
    );
    assert.equal(
      referencesReachedWriterLabel({ referencesTotal: 1, referencesResolved: 1 }),
      '1 of 1 reference reached the writer'
    );
  });
});
