import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { visibleChatDocs } from './chat-visibility.js';
import type { ChatDoc } from './chat-store.js';

const doc = (chat_id: string, created_by: string, kind: ChatDoc['kind'] = 'free') =>
  ({ chat_id, created_by, kind }) as ChatDoc;

describe('chat visibility', () => {
  const docs = [doc('mine', 'Editor@Example.com'), doc('other', 'owner@example.com')];

  it('shows administrators only chats they created', () => {
    assert.deepEqual(
      visibleChatDocs(docs, 'editor@example.com', false, false).map((item) => item.chat_id),
      ['mine']
    );
  });

  it('shows every chat only when an owner explicitly opts in', () => {
    assert.equal(visibleChatDocs(docs, 'editor@example.com', false, true).length, 1);
    assert.equal(visibleChatDocs(docs, 'editor@example.com', true, true).length, 2);
  });

  it("keeps an editor-created object conversation in that editor's sessions only", () => {
    const objectDocs = [
      doc('obj:page_about', 'editor@example.com', 'object'),
      doc('obj:page_home', 'other@example.com', 'object'),
    ];
    assert.deepEqual(
      visibleChatDocs(objectDocs, 'editor@example.com', false, false).map((item) => item.chat_id),
      ['obj:page_about']
    );
  });
});
