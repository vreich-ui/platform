/**
 * The rule under test (Wolf, 2026-08-22): red is for a step that actually
 * died. A gate that held is the system working; a handled warning is quiet.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyNode,
  classifyToolCall,
  classifyToolResult,
  classifyWarning,
  isFatalNodeError,
  severityTone,
  toolTitle,
  worstSeverity,
} from './activity-severity.js';

describe('the screenshot defect: publish_workspace_run', () => {
  it('reads a readiness no_go as waiting on you, not as a failure', () => {
    const result = classifyToolResult({
      tool: 'publish_workspace_run',
      isError: true,
      output: JSON.stringify({
        error: 'Run is not ready to publish (readiness is not "go").',
        status: 'no_go',
        blockers: ['sourcing incomplete'],
      }),
    });
    assert.equal(result.severity, 'attention');
    assert.equal(result.label, 'Publishing is waiting on you');
    assert.match(String(result.detail), /not ready to publish/);
    assert.notEqual(severityTone(result.severity), 'danger');
  });

  it('reads a missing human approver as a gate, not a break', () => {
    const result = classifyToolResult({
      tool: 'publish_workspace_run',
      isError: true,
      output: { error: 'publish_workspace_run requires a signed-in human approver.' },
    });
    assert.equal(result.severity, 'attention');
  });

  it('still calls a real breakage a failure, in red', () => {
    const result = classifyToolResult({
      tool: 'run_workspace_workflow',
      isError: true,
      output: { error: 'OpenAI output did not match node.outputSchema.', code: 'output_validation_failed' },
    });
    assert.equal(result.severity, 'failure');
    assert.equal(severityTone(result.severity), 'danger');
  });

  it('says nothing alarming about a tool that simply finished', () => {
    assert.deepEqual(classifyToolResult({ tool: 'get_workspace_run', isError: false }), {
      severity: 'ok',
      label: 'Progress check finished',
    });
  });

  it('never shows an editor a snake_case tool name', () => {
    assert.equal(toolTitle('publish_workspace_run'), 'Publishing');
    assert.equal(toolTitle('some_new_tool'), 'some new tool');
  });

  it('survives an unparseable body without deciding it is fine', () => {
    const result = classifyToolResult({ tool: 'patch', isError: true, output: 'not json at all' });
    assert.equal(result.severity, 'failure');
  });
});

describe('warnings that fire on every production run', () => {
  it('keeps the handled ones quiet', () => {
    for (const warning of [
      'voice_prefetch_fallback:voice_prefetch_unreachable',
      'contract_prefetch_failed:unknown',
      'resolved_vector_unclamped:no_ceiling',
      'article_body_validation_unavailable:MCP request failed with HTTP 401.',
      'capture_crawl_pending:f1a702f6',
    ]) {
      assert.equal(classifyWarning(warning).severity, 'notice', warning);
    }
  });

  it('gives a skip no severity at all, and says why in words', () => {
    const skipped = classifyWarning('node_skipped:no_media_slots');
    assert.equal(skipped.severity, 'ok');
    assert.equal(skipped.label, 'Skipped — not needed for this article');
  });

  it('reserves amber for the two that really need a human', () => {
    assert.equal(classifyWarning('approval_required').severity, 'attention');
    assert.equal(classifyWarning('content_item_shell_failed:create_failed').severity, 'attention');
  });

  it('defaults an unrecognised warning to quiet, and never hides its raw text', () => {
    const unknown = classifyWarning('some_future_warning:with_detail');
    assert.equal(unknown.severity, 'notice');
    assert.equal(unknown.label, 'some_future_warning:with_detail');
    assert.equal(unknown.raw, 'some_future_warning:with_detail');
  });
});

describe('nodes', () => {
  it('is red only when the node actually died', () => {
    assert.equal(classifyNode({ status: 'failed', errors: ['model_error'] }), 'failure');
    assert.equal(classifyNode({ status: 'completed' }), 'ok');
    assert.equal(classifyNode({ status: 'running' }), 'ok');
    assert.equal(classifyNode({ status: 'blocked' }), 'attention');
    assert.equal(classifyNode({ status: 'skipped', skip: { reason: 'no media slots' } }), 'ok');
  });

  it('cannot be talked into red by a warning on a node that completed', () => {
    assert.equal(
      classifyNode({ status: 'completed', warnings: ['voice_prefetch_fallback:voice_prefetch_unreachable'] }),
      'notice'
    );
    assert.equal(classifyNode({ status: 'completed', warnings: ['approval_required'] }), 'attention');
  });

  it('recognises the error codes that mean a step is genuinely dead', () => {
    assert.equal(isFatalNodeError('reader_simulation:model_error'), true);
    assert.equal(isFatalNodeError('output_validation_failed'), true);
    assert.equal(isFatalNodeError('voice_prefetch_fallback'), false);
  });
});

describe('tool calls inside a node', () => {
  it('treats a capped web.fetch as routine — it happens on every research node', () => {
    assert.equal(classifyToolCall({ status: 'denied', errorCode: 'tool_call_limit_exceeded' }), 'notice');
    assert.equal(classifyToolCall({ status: 'success' }), 'ok');
  });
});

describe('reducing a set of signals', () => {
  it('surfaces the worst one, and nothing at all when there is nothing to say', () => {
    assert.equal(worstSeverity(['ok', 'notice', 'attention']), 'attention');
    assert.equal(worstSeverity(['notice', 'failure', 'attention']), 'failure');
    assert.equal(worstSeverity([]), 'ok');
    assert.equal(worstSeverity(['ok', 'ok']), 'ok');
  });

  it('maps levels to tones with amber reserved for attention', () => {
    assert.equal(severityTone('failure'), 'danger');
    assert.equal(severityTone('attention'), 'warning');
    assert.equal(severityTone('notice'), 'neutral');
    assert.equal(severityTone('ok'), 'success');
  });
});

// ─── regressions from the W19 adversarial review ─────────────────────────────

describe('a fatal code outranks every gate word (the missed-failure direction)', () => {
  it('does not tell an editor to wait for a gate that will never open', () => {
    // Real shape: CMS-Agent's failure copy names the node that broke, and this
    // system's nodes are called things like `publication_controller`.
    const result = classifyToolResult({
      tool: 'run_workspace_workflow',
      isError: true,
      output: {
        code: 'model_error',
        error:
          'Run failed at publication_controller (model_error): the model crashed while awaiting the provider; approval summary was never produced.',
      },
    });
    assert.equal(result.severity, 'failure', 'a dead step must stay red however much its prose sounds like a gate');
  });

  it('does not read a bridge crash during a readiness call as a gate', () => {
    const result = classifyToolResult({
      tool: 'publish_workspace_run',
      isError: true,
      output: {
        code: 'cms_agent_error',
        error: 'CMS-Agent request failed (HTTP 500) calling workflow_publish_readiness.',
      },
    });
    assert.equal(result.severity, 'failure');
  });

  it('still reads an explicit gate code as a gate', () => {
    assert.equal(
      classifyToolResult({ tool: 'publish_workspace_run', isError: true, output: { status: 'no_go' } }).severity,
      'attention'
    );
    assert.equal(
      classifyToolResult({ tool: 'member_invite', isError: true, output: { code: 'membership_requires_human' } })
        .severity,
      'attention'
    );
  });
});

describe('error bodies that are not a flat object', () => {
  it('reads an MCP content envelope', () => {
    const result = classifyToolResult({
      tool: 'publish_workspace_run',
      isError: true,
      output: [{ type: 'text', text: JSON.stringify({ status: 'no_go', error: 'Run is not ready to publish.' }) }],
    });
    assert.equal(result.severity, 'attention');
    assert.match(String(result.detail), /not ready to publish/);
  });

  it('reads a nested error envelope', () => {
    const result = classifyToolResult({
      tool: 'publish_workspace_run',
      isError: true,
      output: { error: { code: 'approval_required', message: 'This requires explicit approval.' } },
    });
    assert.equal(result.severity, 'attention');
    assert.equal(result.detail, 'This requires explicit approval.');
  });

  it('treats a bare sentence as the message rather than losing it', () => {
    const result = classifyToolResult({
      tool: 'publish_workspace_run',
      isError: true,
      output: 'publish_workspace_run requires a signed-in human approver.',
    });
    assert.equal(result.severity, 'attention');
    assert.match(String(result.detail), /signed-in human/);
  });

  it('does not recurse forever on a self-referential shape', () => {
    const loop: Record<string, unknown> = {};
    loop.error = loop;
    assert.doesNotThrow(() => classifyToolResult({ tool: 'patch', isError: true, output: loop }));
  });
});

describe('a node carrying a fatal error under an unexpected status', () => {
  it('is red, because the contract tolerates unknown status values', () => {
    assert.equal(classifyNode({ status: 'running', errors: ['model_error'] }), 'failure');
    assert.equal(classifyNode({ status: 'retrying', errors: ['output_validation_failed'] }), 'failure');
    assert.equal(classifyNode({ status: 'running', errors: ['a transient note'] }), 'ok');
  });
});
