/**
 * OBJECT RETIRE (W14 F6) — the governed way to remove an object.
 *
 * Until this existed there was no front-door removal at all: an agent's
 * mistaken `object_create` was permanent, and the only cleanup path was the
 * Netlify Blobs API back door (delete the record key AND its status-index key
 * by hand). The store already knew about `status: 'archived'` — the schema
 * carried it and `object_publish` already refused archived records — but
 * nothing ever wrote it.
 *
 * WOLF'S RULINGS (2026-07-27), which shape this file:
 *
 *   1. "anything can be recreated again … deleting them after they were in
 *      archive for over thirty days make sense" → retire ARCHIVES (reversible,
 *      history intact); a separate purge hard-deletes after the grace period.
 *      See `object-purge.ts` for the second half.
 *   2. "retired means gone after a release" → retire REMOVES THE EXPORT in the
 *      same commit. Pages render from committed exports, not from the store, so
 *      archiving the record alone would leave the page serving traffic. The
 *      site stops serving it on the next release.
 *   3. "this is dtc sales and publishing … we can't lose readers. readers
 *      should always be redirected" → retire WRITES A REDIRECT for the route it
 *      just removed, in the same commit. A retired page never becomes a bare
 *      404; it forwards (301) to a successor route.
 *
 * Agent-facing decisions taken here and recorded (R8):
 *
 *   - RETIRING IS REFUSED WHILE SOMETHING STILL POINTS AT THE OBJECT. Creation
 *     already enforces reference integrity (the genesis order law: navigation
 *     before the site singleton); removal is the symmetric edge. Retiring a
 *     referenced `nav_footer` would break `structure_home_footer` on every page
 *     at once, so the caller gets a 409 naming the referrers instead.
 *   - THE SITE SINGLETON IS NOT RETIRABLE. A site without its singleton cannot
 *     render at all; there is no meaningful redirect target for it.
 *   - THE LOCK IS REQUIRED, exactly as for patch and publish (verbs parity).
 *     Retiring something another agent is mid-edit on is the race this prevents.
 *   - AN OPEN REVIEW BLOCKS RETIREMENT. A pending human decision is not
 *     something an agent may discard as a side effect; resolve it first.
 */
import { objectRecordKey } from './object-store-keys.js';
import { retireObjectRecord, type ObjectRecordWriteStore } from './objects/record-writer.js';
import { commitMaterializedFiles, ObjectGitCommitError } from './object-git-committer.js';
import { materialize } from './materialize.js';
import { isObjectLockActive, sanitizeObjectLock } from './object-lock.js';
import type { ObjectRecord, ObjectType, Principal } from '../../schema/object-record-v1.js';
import {
  siteRedirectsExportPath,
  upsertRedirect,
  SITE_REDIRECTS_DOC_KEY,
  type SiteRedirect,
} from './site-redirects.js';

export type RetireObjectInput = {
  object_type: ObjectType;
  object_id: string;
  lock_token: string;
  actor: Principal;
  /**
   * Where readers of the retired route should land (ruling 3). Defaults to the
   * site root, which is always a valid destination.
   */
  redirect_to?: string;
  reason?: string;
};

export type RetireObjectDeps = {
  nowMs?: number;
  exportRoot?: string;
  /** Existing redirects export, so the new one is appended rather than replacing. */
  existingRedirects?: SiteRedirect[];
  /** Resolves who still references this object; absent → the check is skipped. */
  findReferrers?: (objectType: ObjectType, objectId: string) => string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type RetireStore = ObjectRecordWriteStore & {
  delete: (key: string) => Promise<unknown>;
};

type RetireResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: number; body: { error: string; code?: string; [key: string]: unknown } };

const err = (status: number, code: string, body: Record<string, unknown>): RetireResult => ({
  status,
  body: { code, ...body } as { error: string; code?: string },
});

/** Routes only exist for pages; other types are removed without a redirect. */
const routeOf = (record: ObjectRecord): string | undefined => {
  if (record.object_type !== 'page') return undefined;
  const body = record.body as { route?: unknown } | undefined;
  return typeof body?.route === 'string' ? body.route : undefined;
};

export const retireObject = async (
  store: RetireStore,
  input: RetireObjectInput,
  deps: RetireObjectDeps = {}
): Promise<RetireResult> => {
  const ts = deps.nowMs ?? Date.now();
  const at = new Date(ts).toISOString();
  const key = objectRecordKey(input.object_type, input.object_id);

  // Type-level rule, checked BEFORE the record load: a site is never retirable,
  // whether or not the record happens to exist.
  if (input.object_type === 'site') {
    return err(409, 'not_retirable', {
      error: 'The site singleton cannot be retired — a site cannot render without it.',
    });
  }

  const raw = await store.get(key);
  if (!raw) return err(404, 'not_found', { error: 'Object record not found', not_found: true });
  const record = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ObjectRecord;

  if (record.status === 'archived') {
    // Idempotent: a retried retire reports success rather than failing.
    return {
      status: 200,
      body: {
        retired: true,
        already_archived: true,
        object_type: input.object_type,
        object_id: input.object_id,
      },
    };
  }

  // Lock precondition (423) — verbs parity with patch/publish.
  if (!record.lock || record.lock.token !== input.lock_token || !isObjectLockActive(record.lock, ts)) {
    return err(423, 'lock_required', {
      error: 'Lock required',
      locked: true,
      lock: sanitizeObjectLock(record.lock),
    });
  }

  // A pending human decision is not an agent's to discard.
  if (record.review?.state === 'open') {
    return err(409, 'review_open', {
      error: 'This object has an open review. Resolve the review before retiring it.',
    });
  }

  // Reference integrity, the symmetric edge of the genesis order law.
  const referrers = deps.findReferrers?.(input.object_type, input.object_id) ?? [];
  if (referrers.length > 0) {
    return err(409, 'still_referenced', {
      error: `Still referenced by ${referrers.join(', ')} — repoint or retire those first.`,
      referrers,
    });
  }

  if (!deps.exportRoot) {
    throw new Error('retireObject: deps.exportRoot is required (the site export root from its SiteBinding.dataRoot).');
  }

  // The export path to remove is the one publish would have written, derived
  // the same way so the two can never disagree.
  const exportPath = materialize(input.object_type, input.object_id, record.body, {
    exportRoot: deps.exportRoot,
    at,
    record_version: record.version,
  }).path;

  // Ruling 3: a removed route forwards, it does not 404.
  const route = routeOf(record);
  const redirectTo = input.redirect_to ?? '/';
  const files: Array<{ path: string; content: string }> = [];
  let redirect: SiteRedirect | undefined;
  if (route && route !== redirectTo) {
    redirect = { from: route, to: redirectTo, status: 301, retired_object_id: input.object_id, at };
    files.push({
      path: siteRedirectsExportPath(deps.exportRoot),
      content: `${JSON.stringify(upsertRedirect(deps.existingRedirects ?? [], redirect), null, 2)}\n`,
    });
  }

  // One commit: the export disappears and the redirect appears together, so a
  // reader can never see the gap between them.
  let commit;
  try {
    commit = await commitMaterializedFiles({
      files,
      deletions: [exportPath],
      message: `Retire ${input.object_type}: ${input.object_id} [skip netlify]`,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });
  } catch (error) {
    const gitError = error instanceof ObjectGitCommitError ? error : undefined;
    return err(gitError?.statusCode ?? 500, 'export_removal_failed', {
      error: 'The export could not be removed; the record is unchanged and the object is still live.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // Record last: if anything above failed the object is untouched, and the
  // reader-safe direction (still live, still active) is preserved.
  const archived: ObjectRecord = {
    ...record,
    status: 'archived',
    updated_at: at,
    lock: undefined,
    history: [
      ...record.history,
      {
        at,
        action: 'retire',
        actor: input.actor,
        details: {
          export_removed: exportPath,
          commit_sha: commit.commitSha,
          ...(redirect ? { redirect_from: redirect.from, redirect_to: redirect.to } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
    ],
    version: record.version + 1,
  };
  // M0.1: the record, the status-marker MOVE (archived on, active off) and the
  // inventory row are one call through the choke point. Naming the transition
  // is the point — `retireObjectRecord` cannot forget the marker it moved from,
  // which is what `object-purge.ts` later walks.
  await retireObjectRecord(store, { record: archived, previous_status: 'active', nowMs: ts });

  // Keep the store-backed redirect table in step with the export just committed.
  // Not a record and not part of the inventory projection, so it stays here.
  if (redirect) {
    await store.setJSON(SITE_REDIRECTS_DOC_KEY, upsertRedirect(deps.existingRedirects ?? [], redirect));
  }

  return {
    status: 200,
    body: {
      retired: true,
      object_type: input.object_type,
      object_id: input.object_id,
      status: 'archived',
      archived_at: at,
      export_removed: exportPath,
      ...(redirect ? { redirect } : {}),
      commit_sha: commit.commitSha,
      version: archived.version,
      // Ruling 2: the site keeps serving the old build until a release.
      production: {
        live_until_release: true,
        note: 'The export is removed from main. Run release_to_production to make the retirement live.',
      },
    },
  };
};
