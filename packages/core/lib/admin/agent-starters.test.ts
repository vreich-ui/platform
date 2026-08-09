import assert from 'node:assert/strict';
import test from 'node:test';

import { agentStarterByKey, agentStarterHref } from './agent-starters.js';

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
