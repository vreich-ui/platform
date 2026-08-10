import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import { decideReview, discardProposal, effectiveApproval, submitReview } from '../../packages/core/server/lib/review-state.js';
import { applyPatchOps } from '../../packages/core/lib/object-patch-apply.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

const AT = '2026-07-04T12:00:00.000Z';
const LATER = '2026-07-04T12:05:00.000Z';

const agentActor: Principal = { kind: 'agent', agent_name: 'codex', auth: 'publish_key' };
const reviewer: Principal = { kind: 'human', id: 'u1', email: 'wolf@example.com' };

const pageRecord = (): ObjectRecord => ({
  object_id: 'page_home',
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: AT,
  updated_at: AT,
  status: 'active',
  body: {
    route: '/',
    pageType: 'home',
    title: 'Home',
    seo: {},
    sections: [{ id: 's_hero1', type: 'hero', data: { heading: 'Original', actions: [] } }],
  },
  publication: { published_time: null },
  history: [{ at: AT, action: 'object_create', actor: reviewer }],
  version: 3,
  content_revision: 1,
});

const siteRecord = (): ObjectRecord => ({
  object_id: 'site_drlurie',
  object_type: 'site',
  schema_version: 'site.v1',
  site: 'site_drlurie',
  created_at: AT,
  updated_at: AT,
  status: 'active',
  body: {
    name: 'Dr. Lurié',
    brandTokens: { colors: { primary: '#112233' }, fonts: { sans: 'Inter', serif: 'Lora', heading: 'Inter' } },
  },
  publication: { published_time: null },
  history: [{ at: AT, action: 'object_create', actor: reviewer }],
  version: 3,
  content_revision: 1,
});

// ─── submit / decide state machine ───────────────────────────────────────────

test('submitReview opens review, records the M-6 requested action, bumps version only', () => {
  const record = pageRecord();
  const result = submitReview(record, {
    actor: agentActor,
    at: LATER,
    note: 'hero copy tightened',
    requested_publish_action: { published_time: 'immediate' },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.review?.state, 'open');
  assert.equal(result.record.version, record.version + 1);
  assert.equal(
    result.record.content_revision,
    record.content_revision,
    'review bookkeeping never bumps content_revision'
  );
  const entry = result.record.history[result.record.history.length - 1];
  assert.equal(entry.action, 'submit_review');
  assert.deepEqual(entry.details, {
    note: 'hero copy tightened',
    requested_publish_action: { published_time: 'immediate' },
  });
  assert.equal(result.record.publication.published_time, null, 'submit must not touch publication');
});

test('submitReview preserves the append-only decision log across resubmissions', () => {
  const record = pageRecord();
  const decided = decideReview(record, {
    actor: reviewer,
    actorRoles: ['editor'],
    at: AT,
    decision: 'request_changes',
    note: 'tone',
  });
  assert.equal(decided.ok, true);
  if (!decided.ok) return;

  const resubmitted = submitReview(decided.record, { actor: agentActor, at: LATER });
  assert.equal(resubmitted.ok, true);
  if (!resubmitted.ok) return;
  assert.equal(resubmitted.record.review?.state, 'open');
  assert.equal(resubmitted.record.review?.decisions.length, 1, 'prior decisions must survive resubmission');
});

test('decideReview(approve) pins {content_revision, publish_action} together in the decision', () => {
  const record = pageRecord();
  const result = decideReview(record, {
    actor: reviewer,
    actorRoles: ['publisher'],
    at: LATER,
    decision: 'approve',
    publish_action: { published_time: null },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.review?.state, 'approved');
  const decision = result.record.review?.decisions[result.record.review.decisions.length - 1];
  assert.deepEqual(decision, {
    at: LATER,
    by: reviewer,
    decision: 'approve',
    publish_action: { published_time: null },
    content_revision: record.content_revision,
  });
  assert.equal(result.record.version, record.version + 1);
  assert.equal(result.record.content_revision, record.content_revision);
  assert.deepEqual(effectiveApproval(result.record), { state: 'approved_current', approval: decision });
});

test('decideReview: agents may decide (no role); humans need a role; pins validate as instants', () => {
  const record = pageRecord();

  // Fully agentic: an agent principal decides without any configured role.
  const byAgent = decideReview(record, { actor: agentActor, actorRoles: [], at: AT, decision: 'approve' });
  assert.equal(byAgent.ok, true);
  assert.equal(byAgent.ok && byAgent.body.review_state, 'approved');

  // A human with no configured role still has no standing.
  const noRole = decideReview(record, { actor: reviewer, actorRoles: [], at: AT, decision: 'approve' });
  assert.equal(noRole.ok, false);
  assert.equal(!noRole.ok && noRole.body.code, 'review_role_required');

  const badPin = decideReview(record, {
    actor: reviewer,
    actorRoles: ['admin'],
    at: AT,
    decision: 'approve',
    publish_action: { published_time: 'tomorrow-ish' },
  });
  assert.equal(badPin.ok, false);
  assert.equal(!badPin.ok && badPin.body.code, 'invalid_publish_action');

  const badSubmit = submitReview(record, {
    actor: agentActor,
    at: AT,
    requested_publish_action: { published_time: 'soon' },
  });
  assert.equal(badSubmit.ok, false);
  assert.equal(!badSubmit.ok && badSubmit.body.code, 'invalid_publish_action');
});

test('effectiveApproval derives currency from the pin, not from review.state alone', () => {
  const record = pageRecord();
  assert.deepEqual(effectiveApproval(record), { state: 'none' });

  const open = submitReview(record, { actor: agentActor, at: AT });
  assert.equal(open.ok && effectiveApproval(open.record).state, 'open');

  const changes = decideReview(record, {
    actor: reviewer,
    actorRoles: ['editor'],
    at: AT,
    decision: 'request_changes',
  });
  assert.equal(changes.ok && effectiveApproval(changes.record).state, 'changes_requested');

  const approved = decideReview(record, { actor: reviewer, actorRoles: ['editor'], at: AT, decision: 'approve' });
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(effectiveApproval(approved.record).state, 'approved_current');

  // A body write after approval → stale, even though review.state still says 'approved'.
  const { record: edited } = applyPatchOps(
    approved.record,
    [{ op: 'update_section_data', section_id: 's_hero1', fields: { heading: 'Post-approval edit' } }],
    { actor: agentActor, at: LATER }
  );
  assert.equal(edited.review?.state, 'approved', 'nothing rewrites the stored state');
  assert.equal(effectiveApproval(edited).state, 'approved_stale', 'the pin comparison is the source of truth');
});

// ─── discard: T0.6 compensating inverses ─────────────────────────────────────

test('discard reverts a rejected op to the pre-proposal state via the recorded inverse', () => {
  const original = pageRecord();
  const forward = applyPatchOps(
    original,
    [{ op: 'update_section_data', section_id: 's_hero1', fields: { heading: 'Agent proposal' } }],
    { actor: agentActor, at: AT }
  );
  assert.equal(forward.record.content_revision, original.content_revision + 1);

  // The entries come from exactly what history stores (details: {op, capture}).
  const entry = forward.record.history[forward.record.history.length - 1].details as { op: unknown; capture: unknown };
  const result = discardProposal(forward.record, { entries: [entry], actor: reviewer, at: LATER });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.record.body, original.body, 'the body must return to its pre-proposal state');
  assert.equal(
    result.record.content_revision,
    original.content_revision + 2,
    'a discard is a body write and must bump content_revision (invalidating approvals over the old draft)'
  );
  const inverseEntry = result.record.history[result.record.history.length - 1];
  assert.deepEqual(inverseEntry.actor, reviewer, 'the inverse is authored and attributed to the reviewer');
  assert.equal(inverseEntry.action, 'update_section_data');
});

test('discarding a multi-op proposal unwinds newest-first and restores the original body', () => {
  const original = pageRecord();
  const forward = applyPatchOps(
    original,
    [
      { op: 'upsert_section', section: { id: 's_note1', type: 'prose', data: { body: 'Inserted by agent' } } },
      { op: 'update_section_data', section_id: 's_note1', fields: { body: 'Edited after insert' } },
    ],
    { actor: agentActor, at: AT }
  );
  assert.equal((forward.record.body as { sections: unknown[] }).sections.length, 2);

  const entries = forward.record.history
    .slice(-2)
    .map((historyEntry) => historyEntry.details as { op: unknown; capture: unknown });
  const result = discardProposal(forward.record, { entries, actor: reviewer, at: LATER });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.record.body, original.body);
});

test('discard refuses a blind revert when intervening accepted ops moved the same field', () => {
  const original = pageRecord();
  const proposal = applyPatchOps(
    original,
    [{ op: 'update_section_data', section_id: 's_hero1', fields: { heading: 'Agent proposal' } }],
    { actor: agentActor, at: AT }
  );
  const proposalEntry = proposal.record.history[proposal.record.history.length - 1].details as {
    op: unknown;
    capture: unknown;
  };

  // A second, ACCEPTED edit lands on the same field before the discard.
  const accepted = applyPatchOps(
    proposal.record,
    [{ op: 'update_section_data', section_id: 's_hero1', fields: { heading: 'Accepted rewrite' } }],
    { actor: reviewer, at: LATER }
  );

  const result = discardProposal(accepted.record, { entries: [proposalEntry], actor: reviewer, at: LATER });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'discard_conflict');
});

test('discard REFUSES a fabricated privileged palette entry not in history (Codex P1 — no palette forgery)', () => {
  const record = siteRecord();
  // A caller with only a site checkout forges a set_site_brand_tokens entry
  // whose capture.before is an arbitrary palette and capture.after matches the
  // current one — its inverse would set the arbitrary palette with privilege.
  const fabricated = {
    op: { op: 'set_site_brand_tokens', fields: { brandTokens: { colors: { primary: '#deadbe' } } } },
    capture: {
      kind: 'fields',
      before: { brandTokens: { colors: { primary: '#deadbe' } } },
      after: { brandTokens: { colors: { primary: '#112233' } } },
    },
  };
  const result = discardProposal(record, { entries: [fabricated], actor: reviewer, at: LATER });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'discard_privileged_unverified');
});

test('discard ACCEPTS a real privileged palette entry from history and reverts the palette', () => {
  // A genuine privileged apply (what site_apply_theme does) records a real
  // set_site_brand_tokens history entry; discarding THAT entry is allowed.
  const original = siteRecord();
  const forward = applyPatchOps(
    original,
    [{ op: 'set_site_brand_tokens', fields: { brandTokens: { colors: { primary: '#ff0000' } } } }],
    { actor: agentActor, at: AT, privilegedOps: ['set_site_brand_tokens'] }
  );
  const entry = forward.record.history[forward.record.history.length - 1].details as { op: unknown; capture: unknown };
  const result = discardProposal(forward.record, { entries: [entry], actor: reviewer, at: LATER });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? '' : result.body));
  if (!result.ok) return;
  assert.deepEqual(result.record.body, original.body, 'the palette returns to its pre-apply state');
});

// brandImagery (W16 C1) rides the exact same privileged funnel as brandTokens
// — no verb constructs the forward op yet, but discard's forgery guard and
// real-history-entry acceptance must hold identically.
test('discard REFUSES a fabricated privileged brandImagery entry not in history', () => {
  const record = siteRecord();
  const fabricated = {
    op: { op: 'set_site_brand_imagery', fields: { brandImagery: { styleSentence: 'forged style' } } },
    capture: {
      kind: 'fields',
      before: { brandImagery: { styleSentence: 'forged style' } },
      after: {},
    },
  };
  const result = discardProposal(record, { entries: [fabricated], actor: reviewer, at: LATER });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'discard_privileged_unverified');
});

test('discard ACCEPTS a real privileged brandImagery entry from history and reverts it', () => {
  const original = siteRecord();
  const forward = applyPatchOps(
    original,
    [{ op: 'set_site_brand_imagery', fields: { brandImagery: { styleSentence: 'Clinical-clean.' } } }],
    { actor: agentActor, at: AT, privilegedOps: ['set_site_brand_imagery'] }
  );
  const entry = forward.record.history[forward.record.history.length - 1].details as { op: unknown; capture: unknown };
  const result = discardProposal(forward.record, { entries: [entry], actor: reviewer, at: LATER });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? '' : result.body));
  if (!result.ok) return;
  assert.deepEqual(result.record.body, original.body, 'brandImagery returns to its pre-apply state');
});

test('discard restores a LEGACY palette entry (pre-rollout set_site_fields{brandTokens}) via the privileged op', () => {
  // A history entry from before the theme-only ban: a set_site_fields whose
  // fields carried brandTokens. It no longer parses under the grammar, but its
  // real, history-verified capture must still revert (not 400).
  const original = siteRecord();
  const legacyForwardOp = { op: 'set_site_fields', fields: { brandTokens: { colors: { primary: '#00ff00' } } } };
  const legacyCapture = {
    kind: 'fields',
    before: {
      brandTokens: { colors: { primary: '#112233' }, fonts: { sans: 'Inter', serif: 'Lora', heading: 'Inter' } },
    },
    after: { brandTokens: { colors: { primary: '#00ff00' } } },
  };
  // Splice the legacy entry into history exactly as the old engine would have.
  const withLegacy: ObjectRecord = {
    ...original,
    body: { ...(original.body as object), brandTokens: { colors: { primary: '#00ff00' } } },
    history: [
      ...original.history,
      {
        at: AT,
        action: 'set_site_fields',
        actor: agentActor,
        details: { op: legacyForwardOp, capture: legacyCapture },
      },
    ],
  };
  const result = discardProposal(withLegacy, {
    entries: [{ op: legacyForwardOp, capture: legacyCapture }],
    actor: reviewer,
    at: LATER,
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? '' : result.body));
  if (!result.ok) return;
  assert.deepEqual(
    (result.record.body as { brandTokens: unknown }).brandTokens,
    legacyCapture.before.brandTokens,
    'the pre-edit palette is restored'
  );

  // …but a FORGED legacy palette entry (not in history) is still refused.
  const forged = discardProposal(original, {
    entries: [{ op: legacyForwardOp, capture: legacyCapture }],
    actor: reviewer,
    at: LATER,
  });
  assert.equal(!forged.ok && forged.status, 403);
  assert.equal(!forged.ok && forged.body.code, 'discard_privileged_unverified');

  // …and blind-revert is preserved: if the palette moved since the legacy edit
  // (the body no longer matches capture.after), discard refuses with a conflict.
  const moved: ObjectRecord = {
    ...withLegacy,
    body: { ...(withLegacy.body as object), brandTokens: { colors: { primary: '#abcabc' } } },
  };
  const conflict = discardProposal(moved, {
    entries: [{ op: legacyForwardOp, capture: legacyCapture }],
    actor: reviewer,
    at: LATER,
  });
  assert.equal(!conflict.ok && conflict.status, 409);
  assert.equal(!conflict.ok && conflict.body.code, 'discard_conflict');
});

test('discard rejects malformed entries and empty batches loudly', () => {
  const record = pageRecord();
  const empty = discardProposal(record, { entries: [], actor: reviewer, at: AT });
  assert.equal(!empty.ok && empty.body.code, 'nothing_to_discard');

  const malformed = discardProposal(record, {
    entries: [{ op: { op: 'not_a_real_op' }, capture: { kind: 'fields', before: {}, after: {} } }],
    actor: reviewer,
    at: AT,
  });
  assert.equal(!malformed.ok && malformed.body.code, 'discard_invalid_entry');
});
