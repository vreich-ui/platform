import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUOTE_MAX_CHARS,
  capWithEllipsis,
  collapseWhitespace,
  formatQuoteBlock,
  insertQuoteIntoDraft,
  normalizeQuoteText,
  selectionWithinContainer,
} from './chat-quote.js';

describe('collapseWhitespace', () => {
  it('collapses multiline / multi-space selections to single spaces and trims', () => {
    assert.equal(collapseWhitespace('  Hello\n\n  world  \t again  '), 'Hello world again');
  });

  it('leaves already-clean text alone', () => {
    assert.equal(collapseWhitespace('one line'), 'one line');
  });
});

describe('capWithEllipsis', () => {
  it('passes short text through untouched', () => {
    assert.equal(capWithEllipsis('short'), 'short');
  });

  it('hard-caps at ~500 chars by default and appends an ellipsis', () => {
    const long = 'a'.repeat(600);
    const capped = capWithEllipsis(long);
    assert.equal(capped.length, QUOTE_MAX_CHARS + 1); // +1 for the ellipsis char
    assert.ok(capped.endsWith('…'));
    assert.equal(capped.slice(0, QUOTE_MAX_CHARS), 'a'.repeat(QUOTE_MAX_CHARS));
  });

  it('respects a custom max', () => {
    assert.equal(capWithEllipsis('abcdef', 3), 'abc…');
  });
});

describe('normalizeQuoteText', () => {
  it('trims, collapses whitespace, then caps', () => {
    const raw = `  This spans\n  multiple lines   and has   extra spaces.  `;
    assert.equal(normalizeQuoteText(raw), 'This spans multiple lines and has extra spaces.');
  });
});

describe('formatQuoteBlock', () => {
  it('produces a single-line markdown blockquote from a multiline selection', () => {
    assert.equal(formatQuoteBlock('Line one\nLine two\n\nLine three'), '> Line one Line two Line three');
  });

  it('caps very long selections before quoting', () => {
    const block = formatQuoteBlock('x'.repeat(1000));
    assert.equal(block, `> ${'x'.repeat(QUOTE_MAX_CHARS)}…`);
  });
});

describe('insertQuoteIntoDraft', () => {
  it('inserts a blockquote with a trailing blank line into an empty composer', () => {
    const { text, cursor } = insertQuoteIntoDraft('', 'quoted text');
    assert.equal(text, '> quoted text\n\n');
    assert.equal(cursor, text.length);
  });

  it('appends below existing composer content, separated by a blank line', () => {
    const { text, cursor } = insertQuoteIntoDraft('My existing draft', 'quoted text');
    assert.equal(text, 'My existing draft\n\n> quoted text\n\n');
    assert.equal(cursor, text.length);
  });

  it('trims trailing whitespace off existing content before appending', () => {
    const { text } = insertQuoteIntoDraft('My existing draft   \n\n', 'quoted text');
    assert.equal(text, 'My existing draft\n\n> quoted text\n\n');
  });

  it('collapses a multiline selection into the single quoted line', () => {
    const { text } = insertQuoteIntoDraft('', 'multi\nline\nselection');
    assert.equal(text, '> multi line selection\n\n');
  });
});

describe('selectionWithinContainer', () => {
  class FakeNode {
    children: FakeNode[] = [];
    contains(node: Node | null): boolean {
      if (!node) return false;
      if ((node as unknown) === (this as unknown)) return true;
      return this.children.some((child) => child.contains(node));
    }
  }

  it('is false for a null or collapsed selection', () => {
    const container = new FakeNode();
    assert.equal(selectionWithinContainer(null, container as unknown as Node), false);
    assert.equal(
      selectionWithinContainer(
        { isCollapsed: true, anchorNode: container as unknown as Node, focusNode: container as unknown as Node },
        container as unknown as Node
      ),
      false
    );
  });

  it('is true when both anchor and focus nodes are inside the container', () => {
    const container = new FakeNode();
    const child = new FakeNode();
    container.children.push(child);
    assert.equal(
      selectionWithinContainer(
        { isCollapsed: false, anchorNode: child as unknown as Node, focusNode: child as unknown as Node },
        container as unknown as Node
      ),
      true
    );
  });

  it('is false when the selection escapes the container', () => {
    const container = new FakeNode();
    const outside = new FakeNode();
    assert.equal(
      selectionWithinContainer(
        { isCollapsed: false, anchorNode: outside as unknown as Node, focusNode: outside as unknown as Node },
        container as unknown as Node
      ),
      false
    );
  });

  it('is false when there is no container to check against', () => {
    const node = new FakeNode();
    assert.equal(
      selectionWithinContainer(
        { isCollapsed: false, anchorNode: node as unknown as Node, focusNode: node as unknown as Node },
        null
      ),
      false
    );
  });
});
