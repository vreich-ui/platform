import { describe, it } from 'node:test';
import assert from 'node:assert';

import { reconcileRequestKind, requestFlowSegment, requestKindFromId } from './request-kind.js';

describe('requestFlowSegment', () => {
  it('reads only the flow segment of req_<flow>_<topic>_<yyyymmdd>_<nn>', () => {
    assert.strictEqual(requestFlowSegment('req_capture_zilberman_20260910_01'), 'capture');
    assert.strictEqual(requestFlowSegment('req_agent_julia_zilberman_20260909_01'), 'agent');
  });

  it('is undefined for anything that is not a request id', () => {
    assert.strictEqual(requestFlowSegment('capture_9f2a'), undefined);
    assert.strictEqual(requestFlowSegment('req_capture'), undefined);
    assert.strictEqual(requestFlowSegment(''), undefined);
  });
});

describe('requestKindFromId', () => {
  it('proves capture and media from their own minters', () => {
    assert.strictEqual(requestKindFromId('req_capture_zilberman_20260910_01'), 'capture');
    assert.strictEqual(requestKindFromId('req_visref_zilberman_20260911_03'), 'media');
  });

  it('proves nothing from the generic agent minter, whatever the topic says', () => {
    assert.strictEqual(requestKindFromId('req_agent_capture_notes_20260910_01'), undefined);
    assert.strictEqual(requestKindFromId('req_agent_julia_zilberman_20260909_01'), undefined);
  });

  it('proves nothing from a flow it does not know', () => {
    assert.strictEqual(requestKindFromId('req_newthing_topic_20260910_01'), undefined);
  });
});

describe('reconcileRequestKind', () => {
  it('corrects the pre-#734 unconditional article stamp on a capture run', () => {
    assert.strictEqual(
      reconcileRequestKind({ kind: 'article', request_id: 'req_capture_zilberman_20260910_01' }),
      'capture'
    );
  });

  it('leaves a genuine article alone', () => {
    assert.strictEqual(
      reconcileRequestKind({ kind: 'article', request_id: 'req_agent_julia_zilberman_20260909_01' }),
      'article'
    );
  });

  it('never overrides a kind a resolver chose deliberately', () => {
    // #734's resolver is the authority for everything except the bare
    // `'article'` default — a `pdf` job whose id happens to start `req_capture`
    // keeps the kind its operation resolved.
    assert.strictEqual(reconcileRequestKind({ kind: 'pdf', request_id: 'req_capture_x_20260910_01' }), 'pdf');
    assert.strictEqual(reconcileRequestKind({ kind: 'other', request_id: 'req_visref_x_20260910_01' }), 'other');
  });
});
