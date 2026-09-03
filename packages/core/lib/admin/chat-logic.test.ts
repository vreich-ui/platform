import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  brandImageryApplyPrompt,
  brandImageryApprovalPreview,
  brandImageryProposalPresentation,
  createdObjectsFromEvents,
  groupChatEvents,
  publishedObjectFromEvents,
  requestProgressCopy,
  toolLabel,
  toolLabelForName,
} from './chat-logic.js';
import { receiptLine } from './chat-liveness.js';
import type { ChatEventView } from './chat-client.js';

const event = (seq: number, type: ChatEventView['type'], detail: Record<string, unknown> = {}): ChatEventView => ({
  seq,
  type,
  detail,
  at: `2026-08-07T00:00:0${seq}.000Z`,
});

describe('quiet chat activity', () => {
  it('collapses consecutive successful tool calls and results into one timeline item', () => {
    const items = groupChatEvents([
      event(1, 'assistant_text', { text: 'I will check.' }),
      event(2, 'tool_call', { tool: 'object_get' }),
      event(3, 'tool_result', { tool: 'object_get' }),
      event(4, 'tool_call', { tool: 'object_validate' }),
      event(5, 'tool_result', { tool: 'object_validate' }),
      event(6, 'assistant_text', { text: 'Done.' }),
    ]);
    assert.equal(items.length, 3);
    assert.equal(items[1]?.kind, 'activity');
    if (items[1]?.kind === 'activity') assert.equal(items[1].events.length, 4);
  });

  it('keeps failed tools visible instead of hiding them in quiet activity', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'patch' }),
      event(2, 'tool_result', { tool: 'patch', is_error: true }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity', 'event']
    );
  });

  it('uses human labels for known tools', () => {
    assert.equal(toolLabel(event(1, 'tool_call', { tool: 'object_validate' })), 'Check readiness');
  });

  it('B8: keeps a held gate quiet even though is_error is true — classified severity decides prominence, not raw is_error', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'publish' }),
      event(2, 'tool_result', {
        tool: 'publish',
        is_error: true,
        output: JSON.stringify({ code: 'no_go' }),
      }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity']
    );
    if (items[0]?.kind === 'activity') assert.equal(items[0].events.length, 2);
  });

  it('B8: a human declining a proposed write also stays quiet (the same category error, one layer up)', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'publish' }),
      event(2, 'tool_result', {
        tool: 'publish',
        is_error: true,
        output: JSON.stringify({ error: 'requires explicit approval' }),
      }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity']
    );
  });

  it('A4: folds 5 consecutive request_progress events into the latest one', () => {
    const items = groupChatEvents([
      event(1, 'request_progress', { status: 'running', done: 1, total: 5 }),
      event(2, 'request_progress', { status: 'running', done: 2, total: 5 }),
      event(3, 'request_progress', { status: 'running', done: 3, total: 5 }),
      event(4, 'request_progress', { status: 'running', done: 4, total: 5 }),
      event(5, 'request_progress', { status: 'failed', done: 5, total: 5 }),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, 'event');
    if (items[0]?.kind === 'event') assert.equal(items[0].event.seq, 5, 'keeps the LATEST event, not the first');
  });

  it('A4: does not fold request_progress events separated by other activity', () => {
    const items = groupChatEvents([
      event(1, 'request_progress', { status: 'running' }),
      event(2, 'tool_call', { tool: 'patch' }),
      event(3, 'request_progress', { status: 'running' }),
    ]);
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['event', 'activity', 'event']
    );
  });

  it('has a shared human label for every guardrails tool', () => {
    for (const tool of [
      'get_object',
      'get_contract',
      'list_objects',
      'inventory',
      'validate',
      'search_artifacts',
      'checkout',
      'patch',
      'checkin',
      'refresh_lock',
      'create_object',
      'create_variant',
      'instantiate_template',
      'instantiate_section_template',
      'submit_review',
      'publish',
      'discard',
      'apply_theme',
      'apply_brand_imagery',
      'brand_imagery_propose',
    ]) {
      assert.doesNotMatch(toolLabelForName(tool), /_/);
    }
  });

  it('U3: a successful brand_imagery_propose result breaks out of the quiet activity group', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'brand_imagery_propose' }),
      event(2, 'tool_result', {
        tool: 'brand_imagery_propose',
        output: JSON.stringify({ artifact: 'brand_imagery_proposal.v1' }),
      }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity', 'event']
    );
  });

  it('U3: a held-gate error on brand_imagery_propose still defers to the normal classifier, not the new special-case', () => {
    // The special-case only fires for a SUCCESSFUL result — an error result
    // (even a mere held gate, never expected from a toolClass:'read' proxy in
    // practice, but the boundary this test pins) falls through to the same
    // classifier every other tool_result uses, and a gate stays quiet there.
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'brand_imagery_propose' }),
      event(2, 'tool_result', { tool: 'brand_imagery_propose', is_error: true, output: '{"code":"not_permitted"}' }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity']
    );
  });

  it('U3: a genuinely failed brand_imagery_propose still breaks out, same as any other tool failure', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'brand_imagery_propose' }),
      event(2, 'tool_result', { tool: 'brand_imagery_propose', is_error: true, output: '{"error":"cms_agent_unreachable"}' }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity', 'event']
    );
  });
});

// ─── U3: apply_brand_imagery approval preview ──────────────────────────────

describe('brandImageryApprovalPreview', () => {
  const AFTER = { styleSentence: 'Clinical-clean skincare editorial photography.', palette: ['#2E5C42', '#C2A878'] };
  const BEFORE = { styleSentence: 'Warm lifestyle photography with natural light.', palette: ['#E8B4B8'] };

  it('reads the style sentence and palette from a real apply_brand_imagery dry run', () => {
    const preview = brandImageryApprovalPreview('apply_brand_imagery', { before: BEFORE, after: AFTER });
    assert.deepEqual(preview, {
      afterSentence: AFTER.styleSentence,
      beforeSentence: BEFORE.styleSentence,
      beforePalette: BEFORE.palette,
      afterPalette: AFTER.palette,
    });
  });

  it('omits beforeSentence when there was no prior contract (first-ever apply)', () => {
    const preview = brandImageryApprovalPreview('apply_brand_imagery', { before: null, after: AFTER });
    assert.equal(preview?.beforeSentence, undefined);
    assert.deepEqual(preview?.beforePalette, []);
    assert.equal(preview?.afterSentence, AFTER.styleSentence);
  });

  it('omits beforeSentence when the apply leaves the sentence unchanged (only the palette/other fields moved)', () => {
    const preview = brandImageryApprovalPreview('apply_brand_imagery', {
      before: { ...AFTER, palette: BEFORE.palette },
      after: AFTER,
    });
    assert.equal(preview?.beforeSentence, undefined);
  });

  it('is undefined for any other tool — never invents a diff for a dry run it does not recognise', () => {
    assert.equal(brandImageryApprovalPreview('apply_theme', { before: BEFORE, after: AFTER }), undefined);
    assert.equal(brandImageryApprovalPreview('apply_brand_imagery', undefined), undefined);
    assert.equal(brandImageryApprovalPreview('apply_brand_imagery', { before: BEFORE, after: {} }), undefined);
  });
});

// ─── U3: brand_imagery_propose result card ─────────────────────────────────

describe('brandImageryProposalPresentation', () => {
  const PROPOSAL_OUTPUT = {
    artifact: 'brand_imagery_proposal.v1',
    mode: 'house',
    rationale: 'The mood board leans clinical-clean with a sage/gold palette.',
    sampleSubjects: ['a woman applying serum', 'a dermatologist consultation'],
    confidence: 'high',
    label: 'Clinical-clean house look',
  };

  it('reads a successful proposal result into a display-ready shape', () => {
    const presentation = brandImageryProposalPresentation(
      event(1, 'tool_result', { tool: 'brand_imagery_propose', output: JSON.stringify(PROPOSAL_OUTPUT) })
    );
    assert.deepEqual(presentation, {
      mode: 'house',
      label: 'Clinical-clean house look',
      rationale: PROPOSAL_OUTPUT.rationale,
      confidence: 'high',
      sampleSubjects: PROPOSAL_OUTPUT.sampleSubjects,
    });
  });

  it('defaults an unreadable confidence to medium rather than dropping the card', () => {
    const presentation = brandImageryProposalPresentation(
      event(1, 'tool_result', {
        tool: 'brand_imagery_propose',
        output: JSON.stringify({ ...PROPOSAL_OUTPUT, confidence: 'unknown' }),
      })
    );
    assert.equal(presentation?.confidence, 'medium');
  });

  it('is undefined for a failed call, a different tool, or a payload that is not the proposal artifact', () => {
    assert.equal(
      brandImageryProposalPresentation(
        event(1, 'tool_result', { tool: 'brand_imagery_propose', is_error: true, output: '{"error":"bad"}' })
      ),
      undefined
    );
    assert.equal(
      brandImageryProposalPresentation(event(1, 'tool_result', { tool: 'patch', output: JSON.stringify(PROPOSAL_OUTPUT) })),
      undefined
    );
    assert.equal(
      brandImageryProposalPresentation(
        event(1, 'tool_result', { tool: 'brand_imagery_propose', output: JSON.stringify({ artifact: 'other.v1' }) })
      ),
      undefined
    );
    assert.equal(brandImageryProposalPresentation(event(1, 'tool_call', { tool: 'brand_imagery_propose' })), undefined);
  });

  it('the Apply prompt names the exact tools, in order, and never invents style words', () => {
    const prompt = brandImageryApplyPrompt({ mode: 'house', label: 'Clinical-clean house look' });
    assert.match(prompt, /visual_standard_materializer/);
    assert.match(prompt, /site_apply_brand_imagery/);
    assert.match(prompt, /dry run/);
    assert.ok(prompt.indexOf('visual_standard_materializer') < prompt.indexOf('site_apply_brand_imagery'));
  });

  // REVIEW (brand-imagery wave): `visual_standard_materializer` is a CMS-Agent
  // NODE. No platform chat registry (generated or legacy) wires a tool that can
  // execute it — `brand_imagery_propose` proxies only the WRITER node — so a
  // prompt naming it alone left the agent with a dead end. And asking for
  // `apply: true` while also asking for a dry run and approval contradicted
  // itself: the materializer would have applied before the human ever saw the
  // diff.
  it('the Apply prompt gives a reachable fallback and never pre-applies', () => {
    const house = brandImageryApplyPrompt({ mode: 'house', label: 'Clinical-clean house look' });
    assert.match(house, /apply: false/);
    assert.doesNotMatch(house, /apply: true/);
    assert.match(house, /object_create/);
    assert.match(house, /set_visual_standard_fields/);
    assert.match(house, /vis_<site>/);

    const template = brandImageryApplyPrompt({ mode: 'template', label: 'Summer campaign' });
    assert.match(template, /vis_<site>_<slug>/);
  });
});

describe('createdObjectsFromEvents', () => {
  it('collects creation results, skipping errors and events without an object_id', () => {
    const created = createdObjectsFromEvents([
      event(1, 'tool_result', { tool: 'create_object', object_id: 'obj_1', object_type: 'page' }),
      event(2, 'tool_result', { tool: 'create_object', is_error: true, object_id: 'obj_2' }),
      event(3, 'tool_result', { tool: 'patch' }),
      event(4, 'tool_result', { tool: 'instantiate_template', object_id: 'obj_3' }),
    ]);
    assert.deepEqual(created, [{ id: 'obj_1', type: 'page' }, { id: 'obj_3' }]);
  });

  it('scopes to one run when runId is given', () => {
    const events = [
      event(1, 'tool_result', { run_id: 'run_1', tool: 'create_object', object_id: 'obj_1' }),
      event(2, 'tool_result', { run_id: 'run_2', tool: 'create_object', object_id: 'obj_2' }),
    ];
    assert.deepEqual(createdObjectsFromEvents(events, 'run_1'), [{ id: 'obj_1' }]);
    assert.deepEqual(createdObjectsFromEvents(events), [{ id: 'obj_1' }, { id: 'obj_2' }]);
  });
});

/**
 * E2b — the publish result reaches the receipt. `loop.ts`'s
 * `publishedObjectRef` stamps `published_object_id`/`published_object_type`
 * on a SUCCESSFUL publish's own `tool_result`; this is the reader, and these
 * are the three cases the receipt has to get right: a proven publish links
 * the object, a failed one claims nothing, and a run that never published
 * leaves today's line untouched.
 */
describe('publishedObjectFromEvents', () => {
  it('a successful publish → the object it published, id and type', () => {
    const published = publishedObjectFromEvents([
      event(1, 'tool_result', { tool: 'checkout' }),
      event(2, 'tool_result', { tool: 'publish', published_object_id: 'obj_1', published_object_type: 'content_item' }),
    ]);
    assert.deepEqual(published, { id: 'obj_1', type: 'content_item' });
  });

  it('a FAILED publish proves nothing — the stamp is absent and so is the fact', () => {
    const published = publishedObjectFromEvents([
      event(1, 'tool_result', { tool: 'publish', is_error: true, output: '{"code":"validation_failed"}' }),
    ]);
    assert.equal(published, undefined);
  });

  it('never reads a creation stamp as a publish — the two facts have their own keys', () => {
    const published = publishedObjectFromEvents([
      event(1, 'tool_result', { tool: 'create_object', object_id: 'obj_1', object_type: 'page' }),
    ]);
    assert.equal(published, undefined);
    // …and the reverse: a publish stamp is never counted as a creation.
    assert.deepEqual(
      createdObjectsFromEvents([event(2, 'tool_result', { tool: 'publish', published_object_id: 'obj_1' })]),
      []
    );
  });

  it('scopes to one run, and keeps the LAST publish when a run made several', () => {
    const events = [
      event(1, 'tool_result', { run_id: 'run_1', tool: 'publish', published_object_id: 'obj_1' }),
      event(2, 'tool_result', { run_id: 'run_1', tool: 'publish', published_object_id: 'obj_2' }),
      event(3, 'tool_result', { run_id: 'run_2', tool: 'publish', published_object_id: 'obj_3' }),
    ];
    assert.deepEqual(publishedObjectFromEvents(events, 'run_1'), { id: 'obj_2' });
    assert.deepEqual(publishedObjectFromEvents(events, 'run_2'), { id: 'obj_3' });
    assert.equal(publishedObjectFromEvents(events, 'run_none'), undefined);
  });

  it('the receipt chain end to end: proven publish → a real link; failed publish and no publish → no clause', () => {
    const receipt = (events: ChatEventView[]) => {
      const published = publishedObjectFromEvents(events, 'run_1');
      return receiptLine({
        outcome: 'completed',
        chips: [],
        hasRunCard: false,
        ...(published ? { published } : {}),
      }).actions;
    };
    assert.deepEqual(
      receipt([
        event(1, 'tool_result', {
          run_id: 'run_1',
          tool: 'publish',
          published_object_id: 'obj_1',
          published_object_type: 'content_item',
        }),
      ]),
      // FIX 4: the clause carries its own key — the href is not list identity.
      [{ key: 'published:obj_1', label: 'Published → open', href: '/admin/content/obj_1?type=content_item' }]
    );
    assert.deepEqual(receipt([event(1, 'tool_result', { run_id: 'run_1', tool: 'publish', is_error: true })]), []);
    assert.deepEqual(receipt([event(1, 'tool_result', { run_id: 'run_1', tool: 'patch' })]), []);
  });
});

// ─── request_progress (W19 bug fix) ────────────────────────────────────────

/**
 * Before `requestProgressCopy` existed, `chat.tsx` had no case for
 * `request_progress` and fell through to `<ToolCallCard>`, which reads
 * `event.detail.tool`/`is_error` — fields this event never carries — so it
 * always rendered `severity: 'ok'` regardless of what the sweeper had just
 * written. This is the exact `progressDetail()` shape (`sweep.ts`) for a run
 * that failed at `artifact_plan` with CMS-Agent's `budget_exceeded` guard —
 * a real production run read live on 2026-08-31 (`run_1788165644777_zuu2o1`).
 */
const REAL_BUDGET_EXCEEDED_DETAIL = {
  request_id: 'req_concern_skin_diary_20240608_01',
  status: 'failed',
  summary: 'The artifact plan step failed, so the job has stopped.',
  done: 17,
  total: 24,
  node: 'artifact_plan',
  blockers: [
    {
      node_id: 'artifact_plan',
      code: 'budget_exceeded',
      message:
        'Node "artifact_plan" stopped before the model turn that would cross the node budget: estimated spend $2.70755 plus ~$0.32781 for the upcoming turn exceeds the $3 ceiling. Caught inside the agent loop before the turn ran, not after.',
      operator_action: 'Run budget 3 USD reached (spent 2.70755). Raise the budget or stop.',
    },
  ],
};

describe('requestProgressCopy', () => {
  it('reads a failed transition as blocked severity, never the ToolCallCard default ok', () => {
    const copy = requestProgressCopy(REAL_BUDGET_EXCEEDED_DETAIL, false);
    assert.equal(copy.status, 'failed');
    assert.equal(copy.level, 'blocked');
    assert.equal(copy.label, 'Failed');
    assert.equal(copy.progress, '17/24');
    // E1: a `failed` transition states its OUTCOME, not the step it died on
    // — `artifact_plan` is a known node (`NODE_LABELS`), but `stepLine` only
    // narrates the live `running` line, so it stays undefined here.
    assert.equal(copy.stepLine, undefined);
  });

  it('renders the structured blocker as code: message — operatorAction, same as run_error/RequestActivity', () => {
    const copy = requestProgressCopy(REAL_BUDGET_EXCEEDED_DETAIL, false);
    assert.ok(copy.failure);
    assert.equal(
      copy.failure?.text,
      'budget_exceeded: Node "artifact_plan" stopped before the model turn that would cross the node budget: estimated spend $2.70755 plus ~$0.32781 for the upcoming turn exceeds the $3 ceiling. Caught inside the agent loop before the turn ran, not after. — Run budget 3 USD reached (spent 2.70755). Raise the budget or stop.'
    );
    // `summary` is still carried (the sweeper's plain sentence), but the
    // renderer prefers `failure` over it so the structured text is never
    // duplicated underneath itself — see `RequestProgressLine` in chat.tsx.
    assert.equal(copy.summary, 'The artifact plan step failed, so the job has stopped.');
  });

  it('a non-failed transition (e.g. running/needs_you) shows the plain summary, never a failure line', () => {
    const copy = requestProgressCopy(
      { status: 'needs_you', summary: 'The draft is ready and waiting for your publish decision.', done: 20, total: 24 },
      false
    );
    assert.equal(copy.level, 'needs_you');
    assert.equal(copy.failure, undefined);
    assert.equal(copy.summary, 'The draft is ready and waiting for your publish decision.');
  });

  it('a failed transition with no structured blocker (older shape) falls back to the plain summary', () => {
    const copy = requestProgressCopy(
      { status: 'failed', summary: 'The job failed before it could finish.', blockers: [{ code: 'model_error', message: '' }] },
      false
    );
    assert.equal(copy.level, 'blocked');
    // Empty message never parses as structured detail — no half-built failure copy.
    assert.equal(copy.failure, undefined);
    assert.equal(copy.summary, 'The job failed before it could finish.');
  });

  it('defaults an unreadable/missing status to running, never a fabricated failed', () => {
    const copy = requestProgressCopy(undefined, false);
    assert.equal(copy.status, 'running');
    assert.equal(copy.level, 'info');
    assert.equal(copy.failure, undefined);
  });
});

// ─── E1: narrate the current step in words ─────────────────────────────────

describe('requestProgressCopy — E1 step narration', () => {
  it('a running transition with a node NODE_LABELS knows becomes "{label} — step {done} of {total}"', () => {
    const copy = requestProgressCopy({ status: 'running', node: 'draft_writer', done: 14, total: 23 }, false);
    assert.equal(copy.stepLine, 'Drafting — step 14 of 23');
    // The old fields are still populated underneath — only the RENDERER
    // (chat.tsx's `RequestProgressLine`) prefers `stepLine` when it exists.
    assert.equal(copy.label, 'Working');
    assert.equal(copy.progress, '14/23');
  });

  it('an unrecognised node falls back to the plain wording — never a prettified raw node id (guardrail 5)', () => {
    const copy = requestProgressCopy({ status: 'running', node: 'some_future_node', done: 3, total: 10 }, false);
    assert.equal(copy.stepLine, undefined);
    assert.equal(copy.label, 'Working');
    assert.equal(copy.progress, '3/10');
  });

  it('a missing node falls back the same way', () => {
    const copy = requestProgressCopy({ status: 'running', done: 3, total: 10 }, false);
    assert.equal(copy.stepLine, undefined);
    assert.equal(copy.label, 'Working');
  });

  it('a known node with no done/total yet has nothing to build "step X of Y" from — falls back rather than half-rendering', () => {
    const copy = requestProgressCopy({ status: 'running', node: 'draft_writer' }, false);
    assert.equal(copy.stepLine, undefined);
    assert.equal(copy.progress, undefined);
  });
});
