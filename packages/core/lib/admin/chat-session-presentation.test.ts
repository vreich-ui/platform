import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presentChatSession } from './chat-session-presentation.js';

describe('presentChatSession', () => {
  it('keeps a persisted object display name and calls out its scope', () => {
    assert.deepEqual(
      presentChatSession({
        kind: 'object',
        title: 'About Dr. Lurié',
        object_type: 'page',
        object_id: 'page_about',
      }),
      { title: 'About Dr. Lurié', kindLabel: 'Object conversation' }
    );
  });

  it('replaces a legacy raw object id with a human type fallback', () => {
    assert.deepEqual(
      presentChatSession({
        kind: 'object',
        title: 'req_2026_08_09',
        object_type: 'content_item',
        object_id: 'req_2026_08_09',
      }),
      { title: 'Article conversation', kindLabel: 'Object conversation' }
    );
  });

  it('keeps free conversations distinct', () => {
    assert.deepEqual(presentChatSession({ kind: 'free', title: 'Plan the September editorial calendar' }), {
      title: 'Plan the September editorial calendar',
      kindLabel: 'General conversation',
    });
  });
});
