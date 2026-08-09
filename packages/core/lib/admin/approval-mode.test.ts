import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRunSafeApproval, shouldAutoApproveRunTool } from './approval-mode.js';

describe('isRunSafeApproval', () => {
  it('allows ordinary content work for the current run', () => {
    assert.equal(isRunSafeApproval('patch'), true);
    assert.equal(isRunSafeApproval('instantiate_section_template'), true);
    assert.equal(isRunSafeApproval('submit_review'), true);
  });

  it('keeps consequential actions behind an explicit decision', () => {
    for (const tool of [
      'publish',
      'discard',
      'apply_theme',
      'delete_pdf_template',
      'publish_pdf_template',
      'create_agent_artifact_job',
      'release',
    ]) {
      assert.equal(isRunSafeApproval(tool), false);
    }
  });

  it('fails closed for an unknown tool', () => {
    assert.equal(isRunSafeApproval('future_unclassified_tool'), false);
  });

  it('only auto-approves allow-listed actions in the editor-selected run mode', () => {
    assert.equal(shouldAutoApproveRunTool('ask', 'patch'), false);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'patch'), true);
    assert.equal(shouldAutoApproveRunTool('safe-run', 'patch', true), false);

    for (const tool of ['publish', 'release', 'apply_theme', 'delete_pdf_template', 'unknown_tool']) {
      assert.equal(shouldAutoApproveRunTool('safe-run', tool), false);
    }
  });
});
