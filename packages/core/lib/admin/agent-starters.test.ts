import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_STARTERS, agentStarterByKey, agentStarterHref } from './agent-starters.js';

test('contextual media entry uses the governed agent flow, not a direct upload claim', () => {
  const media = agentStarterByKey('media');
  assert.ok(media);
  assert.match(media.prompt, /wait for approval/i);
  assert.match(media.prompt, /Do not claim there is a direct browser upload/i);
  assert.equal(agentStarterHref('media'), '/admin/agents?starter=media');
});

test('unknown contextual starter keys are ignored', () => {
  assert.equal(agentStarterByKey('arbitrary-upload'), undefined);
});

// A6: the "Start something" rows collapse to icon + title, with the longer
// copy moved into a hover Popover instead of sitting inline. That only works
// because every starter already carries its own `description` distinct from
// its one-line `label` — assert it stays that way so the row never regresses
// back to needing inline text.
test('every starter carries a description meant for the row popover, not the inline label', () => {
  for (const starter of AGENT_STARTERS) {
    assert.ok(starter.description.length > 0, `${starter.key} needs a non-empty description`);
    assert.notEqual(starter.description, starter.label, `${starter.key}'s description should say more than its label`);
  }
});
