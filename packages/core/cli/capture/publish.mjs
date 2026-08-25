// T14.5 — THE PUBLISH TAIL. Capture's terminal act, and the one place in the capture engine where
// `object_publish` and `release_to_production` are reachable.
//
// WHY THIS IS A SEPARATE MODULE AND NOT A BRANCH INSIDE emit.mjs.
// The emitter's forbidden-verb set (`object_publish`, `release_to_production`,
// `trigger_netlify_build`, `deploy`) is NOT relaxed by this file and must never be. An emission
// walks crawled third-party content through creates, patches and asset ingestion; a bug or a hostile
// source anywhere in that walk must not be able to reach production mid-write. Publishing is
// therefore a DISTINCT stage that runs only after the emission has finished and reported, reading
// the emission's own record of what it wrote. Two verbs move from "unreachable" to "reachable by
// exactly one stage", and `trigger_netlify_build`/`deploy` stay unreachable everywhere — a build is
// something `release_to_production` decides to do, never something capture asks for directly.
//
// THE OPERATING ASSUMPTION (Wolf, 2026-08-25): "this is agentic CMS — human review and check and if
// needed edit published content, but it needs to be assumed that the human is not involved." So the
// default is PUBLISH, and review happens on live content afterwards. There is no human gate here.
//
// THERE IS STILL A GATE, AND IT IS NOT A HUMAN ONE.
// An object is published when the emission's OWN validation of it passed — `validationStates` with
// `valid: true`, minus anything the same run quarantined. That is the machine checking its own work,
// which is the thing that makes unattended operation safe rather than merely unattended: publishing
// output the engine has already flagged as broken would put a defect live and then ask a human to
// find it, which is worse than the human gate it replaces. Everything withheld is named, with its
// reason, so the report says what did not go live and why — silence about a withheld object would be
// the same defect wearing a different hat.
//
// NOTHING HERE THROWS PAST ITS LOOP. One object failing to publish must not withhold the rest, and a
// lease is released in a `finally` for the same reason emit.mjs does it: a stranded lock on a live
// page blocks the tenant's own admin chat, which is worse than the failed publish that caused it.

/** Never reachable, from this stage or any other. A build is `release_to_production`'s decision. */
export const PUBLISH_FORBIDDEN_VERBS = new Set(['trigger_netlify_build', 'deploy']);

/** The two verbs this stage — and only this stage — may use. */
export const PUBLISH_VERBS = new Set(['object_publish', 'release_to_production']);

export class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = (value) => (Array.isArray(value) ? value.filter(isRecord) : []);

/**
 * The object types capture may publish. A `theme` or `section_template` is a RECIPE — data the site
 * reads at build time, not a page — and the emitter reuses rather than rewrites them, so they carry
 * no postpatch validation of their own and are not candidates here. Publishing a recipe is a
 * deliberate studio act, not a side effect of cloning a page.
 */
const PUBLISHABLE_TYPES = new Set(['page', 'navigation']);

const objectTypeIndex = (report) => {
  const index = new Map();
  for (const entry of [...rows(report.createdObjects), ...rows(report.reusedObjects)]) {
    if (typeof entry.objectId === 'string' && typeof entry.objectType === 'string') index.set(entry.objectId, entry.objectType);
  }
  return index;
};

/**
 * Every objectId this run quarantined, for any reason. A quarantine is the emission saying "I did
 * not finish with this one" — publishing it would ship a half-write.
 */
const quarantinedIds = (report) => {
  const ids = new Set();
  for (const entry of rows(report.quarantines)) {
    if (typeof entry.objectId === 'string') ids.add(entry.objectId);
  }
  return ids;
};

/**
 * Decide what goes live, from the emission report alone. PURE — no transport, no clock, no I/O — so
 * the decision can be inspected in a dry run and asserted in a test without a site on the other end.
 *
 * Returns { schemaVersion, target, publish: [...], withheld: [...], release }.
 *   publish  — objects whose own postcreate/postpatch validation passed and which nothing quarantined
 *   withheld — everything else that was WRITTEN, each with the reason it is not going live
 *   release  — whether a production release should follow (false when nothing is publishable)
 */
export function buildPublishPlan({ report, target } = {}) {
  if (!isRecord(report)) throw new PublishError('A publish plan needs the emission report it is publishing.');
  const resolvedTarget = typeof target === 'string' && target.trim() ? target.trim() : typeof report.target === 'string' ? report.target : null;
  if (!resolvedTarget) throw new PublishError('A publish plan needs a target project.');

  const types = objectTypeIndex(report);
  const quarantined = quarantinedIds(report);
  const publish = [];
  const withheld = [];
  const decided = new Set();

  // Walk validationStates, not the object lists: a validation state is the emission's own verdict on
  // one object, and it is the only field that says whether what landed is coherent.
  for (const state of rows(report.validationStates)) {
    const objectId = typeof state.objectId === 'string' ? state.objectId : null;
    // A `precreate` state names a requestedId that was never written — there is no object to publish
    // and nothing was lost, so it is not withheld either. It simply is not a candidate.
    if (!objectId || decided.has(objectId)) continue;
    decided.add(objectId);
    const objectType = types.get(objectId) ?? null;
    const entry = { objectId, objectType, phase: typeof state.phase === 'string' ? state.phase : null };

    if (state.valid !== true) {
      withheld.push({ ...entry, reason: 'validation_failed', detail: typeof state.reason === 'string' ? state.reason : null });
      continue;
    }
    if (quarantined.has(objectId)) {
      withheld.push({ ...entry, reason: 'quarantined_by_emission' });
      continue;
    }
    if (!objectType || !PUBLISHABLE_TYPES.has(objectType)) {
      withheld.push({ ...entry, reason: objectType ? 'type_not_publishable_from_capture' : 'object_type_unknown' });
      continue;
    }
    publish.push(entry);
  }

  // An object the emission quarantined WITHOUT ever validating it never reaches the loop above, and a
  // silently-dropped object is the failure mode this whole file exists to avoid. Name it.
  for (const entry of rows(report.quarantines)) {
    const objectId = typeof entry.objectId === 'string' ? entry.objectId : null;
    if (!objectId || decided.has(objectId)) continue;
    decided.add(objectId);
    withheld.push({
      objectId,
      objectType: types.get(objectId) ?? null,
      phase: null,
      reason: 'quarantined_by_emission',
      detail: typeof entry.reason === 'string' ? entry.reason : null,
    });
  }

  return {
    schemaVersion: 'capture-publish-plan.v1',
    target: resolvedTarget,
    publish,
    withheld,
    release: publish.length > 0,
    forbiddenVerbs: [...PUBLISH_FORBIDDEN_VERBS].sort(),
  };
}

const payload = (result) => {
  if (!isRecord(result)) return {};
  if (isRecord(result.structuredContent)) return result.structuredContent;
  return result;
};

const lockTokenOf = (value) => {
  const record = payload(value);
  const token = record.lockToken ?? record.lock_token;
  return typeof token === 'string' && token ? token : null;
};

const errorText = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Publish one object through checkout -> object_publish -> checkin. Never throws past the lease
 * release; the caller records the reason and moves to the next object.
 */
async function publishOne({ transport, objectType, objectId, trace }) {
  let lockToken = null;
  try {
    const checkout = await transport.call('object_checkout', { object_type: objectType, object_id: objectId });
    trace.push({ verb: 'object_checkout', objectType, objectId });
    lockToken = lockTokenOf(checkout);
    if (!lockToken) return { ok: false, reason: 'checkout_returned_no_lock' };

    const published = await transport.call('object_publish', {
      object_type: objectType,
      object_id: objectId,
      lock_token: lockToken,
    });
    trace.push({ verb: 'object_publish', objectType, objectId });
    const record = payload(published);
    if (record.published !== true) return { ok: false, reason: 'publish_not_confirmed' };
    return {
      ok: true,
      publishedTime: typeof record.published_time === 'string' ? record.published_time : null,
      commit: isRecord(record.receipt) && typeof record.receipt.commit_sha === 'string' ? record.receipt.commit_sha : null,
    };
  } catch (error) {
    return { ok: false, reason: 'publish_failed', detail: errorText(error) };
  } finally {
    if (lockToken) {
      try {
        await transport.call('object_checkin', { object_type: objectType, object_id: objectId, lock_token: lockToken });
        trace.push({ verb: 'object_checkin', objectType, objectId });
      } catch {
        // A stranded lease is worse than the failed publish that caused it, so it is RECORDED rather
        // than swallowed — the run report carries it and a human can break the lock knowingly.
        trace.push({ verb: 'object_checkin', objectType, objectId, failed: true });
      }
    }
  }
}

/**
 * Execute a publish plan through an injected MCP transport, then release once.
 *
 * ONE release for the whole plan, never one per object: each `object_publish` commits with the
 * Netlify skip marker and the exports accumulate on main, so a per-object release would queue N
 * builds to ship one change set. The release is skipped entirely when nothing published — asking
 * production to rebuild for zero commits is noise that looks like activity.
 */
export async function executePublish({ plan, transport }) {
  if (!transport?.call) throw new PublishError('An MCP transport is required to publish.');
  if (!isRecord(plan) || !Array.isArray(plan.publish)) throw new PublishError('A publish plan is required.');

  const trace = [];
  const published = [];
  const failed = [];

  for (const candidate of plan.publish) {
    const { objectId, objectType } = candidate;
    if (typeof objectId !== 'string' || typeof objectType !== 'string') {
      failed.push({ ...candidate, reason: 'incomplete_candidate' });
      continue;
    }
    const outcome = await publishOne({ transport, objectType, objectId, trace });
    if (outcome.ok) published.push({ objectId, objectType, publishedTime: outcome.publishedTime, commit: outcome.commit });
    else failed.push({ objectId, objectType, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  }

  let release = null;
  if (published.length > 0) {
    try {
      const released = await transport.call('release_to_production', {});
      trace.push({ verb: 'release_to_production' });
      const record = payload(released);
      release = {
        released: record.released === true,
        status: typeof record.status === 'string' ? record.status : null,
        deployId: isRecord(record.deploy) && typeof record.deploy.deployId === 'string' ? record.deploy.deployId : null,
        commit: typeof record.targetCommit === 'string' ? record.targetCommit : null,
        productionConfirmed: record.productionConfirmed === true,
        productionUrl: typeof record.productionUrl === 'string' ? record.productionUrl : null,
      };
    } catch (error) {
      // The objects ARE published — committed to main behind the skip marker. Only the deploy failed,
      // and that is recoverable by calling release again; saying so is the difference between a
      // retryable state and an apparent data loss.
      release = { released: false, status: 'release_failed', detail: errorText(error), recoverable: true };
    }
  } else {
    release = { released: false, status: 'nothing_to_release' };
  }

  return {
    schemaVersion: 'capture-publish-run.v1',
    target: plan.target,
    published,
    failed,
    withheld: Array.isArray(plan.withheld) ? plan.withheld : [],
    release,
    trace,
  };
}
