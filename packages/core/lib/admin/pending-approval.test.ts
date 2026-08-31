/**
 * A7 — the chat's pending tool-call approval, now rendered by the kit
 * `<ApprovalCard>`. Everything the deleted `chat.tsx` card decided in JSX
 * (which severity, which title, which one-line cause, whether there are
 * buttons at all, and what Modify does with an edited args draft) is asserted
 * here, against the pure module the adapter consumes — `.tsx` under
 * `packages/core/admin` is excluded from `tsconfig.test.json` (BRIEF.md).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPROVAL_CONSUMED_CAUSE,
  APPROVAL_IN_STAGE_CAUSE,
  APPROVAL_NEEDED_CAUSE,
  DRY_RUN_BLOCKED_CAUSE,
  DRY_RUN_CLEAN_CAUSE,
  EDITED_ARGS_INVALID,
  EDITED_ARGS_NOT_OBJECT,
  dryRunCause,
  editedArgsDraft,
  editedArgsError,
  parseEditedArgs,
  pendingApprovalTitle,
  presentPendingApproval,
} from './pending-approval.js';

describe('pendingApprovalTitle', () => {
  it('prefers the server\'s human summary', () => {
    assert.equal(pendingApprovalTitle({ tool: 'patch', summary: 'Rewrite the intro section' }), 'Rewrite the intro section');
  });

  it('falls back to the tool name when there is no summary, or only blanks', () => {
    assert.equal(pendingApprovalTitle({ tool: 'create_object' }), 'Run create_object');
    assert.equal(pendingApprovalTitle({ tool: 'create_object', summary: '   ' }), 'Run create_object');
  });
});

describe('dryRunCause', () => {
  it('is absent when no dry run was attached', () => {
    assert.equal(dryRunCause(undefined), undefined);
  });

  it('surfaces the preview error verbatim', () => {
    assert.equal(dryRunCause({ error: 'contract mismatch' }), 'Preview failed: contract mismatch');
  });

  it('reads ineligibility from the body OR its nested summary', () => {
    assert.equal(dryRunCause({ eligible: false }), DRY_RUN_BLOCKED_CAUSE);
    assert.equal(dryRunCause({ summary: { eligible: false } }), DRY_RUN_BLOCKED_CAUSE);
  });

  it('is clean otherwise — including when summary is a string, not an object', () => {
    assert.equal(dryRunCause({ eligible: true }), DRY_RUN_CLEAN_CAUSE);
    assert.equal(dryRunCause({ summary: 'looks fine' }), DRY_RUN_CLEAN_CAUSE);
    assert.equal(dryRunCause({}), DRY_RUN_CLEAN_CAUSE);
  });
});

describe('presentPendingApproval', () => {
  it('is a needs_you gate with the three decisions when a human must act', () => {
    const view = presentPendingApproval({ tool: 'patch', summary: 'Rewrite the intro' });
    assert.equal(view.severity, 'needs_you');
    assert.equal(view.title, 'Rewrite the intro');
    assert.equal(view.cause, APPROVAL_NEEDED_CAUSE);
    assert.equal(view.showActions, true);
  });

  it('carries the dry run\'s verdict as the cause line', () => {
    assert.equal(presentPendingApproval({ tool: 'patch', dryRun: {} }).cause, DRY_RUN_CLEAN_CAUSE);
    assert.equal(presentPendingApproval({ tool: 'patch', dryRun: { eligible: false } }).cause, DRY_RUN_BLOCKED_CAUSE);
  });

  it('W19 severity law: a dry run that failed is still an amber HELD GATE, never red', () => {
    // The run paused waiting for a human and there is a forward path (reject
    // it, or modify the arguments) — `error`/`blocked` would claim otherwise.
    const view = presentPendingApproval({ tool: 'publish', dryRun: { error: 'boom' } });
    assert.equal(view.severity, 'needs_you');
    assert.equal(view.cause, 'Preview failed: boom');
    assert.equal(view.showActions, true);
  });

  it('an already-submitted call is a receipt, not a decision', () => {
    const view = presentPendingApproval({ tool: 'patch', consumed: true, dryRun: { eligible: false } });
    assert.equal(view.severity, 'info');
    assert.equal(view.cause, APPROVAL_CONSUMED_CAUSE);
    assert.equal(view.showActions, false);
  });

  it('ux-inventory A9: a proposal owned by the Object Stage names it and offers no buttons here', () => {
    const view = presentPendingApproval({ tool: 'patch', decidedElsewhere: true });
    assert.equal(view.severity, 'info');
    assert.equal(view.cause, APPROVAL_IN_STAGE_CAUSE);
    assert.equal(view.showActions, false);
  });

  it('consumed wins over the Object Stage hand-off — the call is gone either way', () => {
    const view = presentPendingApproval({ tool: 'patch', consumed: true, decidedElsewhere: true });
    assert.equal(view.cause, APPROVAL_CONSUMED_CAUSE);
  });
});

describe('the Modify capture (edited arguments)', () => {
  it('opens on the call\'s current arguments, pretty-printed', () => {
    assert.equal(editedArgsDraft({ path: '/x', value: 1 }), '{\n  "path": "/x",\n  "value": 1\n}');
    assert.equal(editedArgsDraft(undefined), '{}');
  });

  it('round-trips an edited object', () => {
    const parsed = parseEditedArgs('{ "path": "/x" }');
    assert.deepEqual(parsed, { args: { path: '/x' } });
    assert.equal(editedArgsError('{ "path": "/x" }'), undefined);
  });

  it('refuses a draft that does not parse, with the message the textarea shows', () => {
    assert.deepEqual(parseEditedArgs('{ oops'), { error: EDITED_ARGS_INVALID });
    assert.equal(editedArgsError('{ oops'), EDITED_ARGS_INVALID);
  });

  it('refuses valid JSON that is not an argument object', () => {
    // `approve_tool` spreads `edited_args` as named arguments — a scalar or an
    // array would reach the server as something no tool has a signature for.
    for (const draft of ['3', '"text"', 'null', '[1, 2]']) {
      assert.deepEqual(parseEditedArgs(draft), { error: EDITED_ARGS_NOT_OBJECT }, draft);
    }
  });
});
