import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTONOMY_LABELS,
  autonomyEffect,
  governanceProvenanceLabel,
  toolGroupLabel,
} from './governance-presentation.js';

describe('governance presentation', () => {
  it('uses human labels for every autonomy setting', () => {
    assert.deepEqual(AUTONOMY_LABELS, {
      auto: 'Run automatically',
      ask: 'Ask me first',
      off: 'Not allowed',
    });
    assert.match(autonomyEffect('ask'), /approval/i);
  });

  it('uses human headings and provenance labels', () => {
    assert.equal(governanceProvenanceLabel('override'), 'Changed here');
    assert.equal(governanceProvenanceLabel('committed'), 'Site default');
    assert.equal(toolGroupLabel('read'), 'Looking things up');
    assert.equal(toolGroupLabel('privileged'), 'Site-wide changes');
  });
});
