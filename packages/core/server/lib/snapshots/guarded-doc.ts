/**
 * M3 — the drift alarm and the compare-and-swap, for a snapshot that lives in
 * ONE blob. `objects/index-doc.ts` established the mechanism and states every
 * reason behind it; read that file first. Two differences, both forced:
 *
 *  1. THE ALARM IS INSIDE THE DOCUMENT. `index-doc.ts` spends a second blob on
 *     it because the record-write choke point must stamp the alarm without
 *     rewriting the index. M3's snapshots are read on a page path whose whole
 *     acceptance is ONE BLOB READ, and a second document is a second read. So
 *     the reader trusts the snapshot iff it parses AND `armed !== true`; the
 *     ARM compare-and-swaps in a document carrying `armed: true` and NO ROWS
 *     (an armed document is untrusted, so its rows can never be read, and
 *     carrying them would make every amendment write the snapshot twice); the
 *     COMMIT compare-and-swaps against the etag the ARM's own write returned.
 *     Every path out of an arm that is not a proven commit RE-ARMS, stickily —
 *     only a rebuild from the records puts the flag down.
 *  2. THIS FILE NEVER NAMES A KEY AND NEVER CALLS `.setJSON`. The single-writer
 *     law is a source scan for `.setJSON(<KEY>)`
 *     (`tests/netlify/object-inventory-index.test.ts`), and a shared writer
 *     would make it vacuous for every key routed through it. Each snapshot
 *     module hands this one a `GuardedDocIo` that names its own key.
 *
 * A store that cannot report an etag (the local shim, every hand-rolled fake)
 * never arms and so never commits: it degrades to "rebuilt on read", which is
 * the pre-M3 behaviour and the degradation `index-doc.ts` documents.
 */
import type { z } from 'zod';

export interface GuardedDocReadStore {
  get(key: string): Promise<string | null>;
  /** Optional: the ONLY source of a compare-and-swap token. Absent means "never arm". */
  getWithMetadata?(
    key: string,
    options?: { type?: 'text' }
  ): Promise<{ data: unknown; etag?: string } | null | undefined>;
}

/** What a Netlify Blobs conditional write answers. `modified: false` is the CAS refusal. */
export type GuardedWriteResult = void | { modified?: boolean; etag?: string };
/**
 * `onlyIfMatch` and nothing else. There is deliberately no create-if-absent
 * guard: an amendment never creates a guarded snapshot (see `armGuardedDoc`),
 * and only the unconditional rebuild write may bring one into existence.
 */
export type GuardedWriteGuard = { onlyIfMatch: string };

/** The fields every guarded snapshot carries on top of its own rows. */
export interface GuardedDoc {
  schema_version: string;
  as_of: string;
  seq: number;
  armed?: boolean;
}

/** One snapshot's identity and I/O, supplied by the module that OWNS its key. */
export interface GuardedDocIo<T extends GuardedDoc> {
  /** For log lines only — conventionally the blob key. */
  label: string;
  schema: z.ZodType<T>;
  /** A schema-valid document carrying NO rows: what an arm and a re-arm write. */
  empty: (seq: number, asOf: string) => T;
  read(): Promise<{ raw: string | null; etag: string | undefined }>;
  write(doc: T, guard?: GuardedWriteGuard): Promise<GuardedWriteResult>;
}

export const usableEtag = (etag: string | undefined): etag is string => typeof etag === 'string' && etag.length > 0;

/** A blob with its etag when the store can report one; plain `get` otherwise. */
export const readBlobWithEtag = async (
  store: GuardedDocReadStore,
  key: string
): Promise<{ raw: string | null; etag: string | undefined }> => {
  if (typeof store.getWithMetadata === 'function') {
    try {
      const result = await store.getWithMetadata(key, { type: 'text' });
      if (!result) return { raw: null, etag: undefined };
      const data = result.data;
      return {
        raw: typeof data === 'string' ? data : data == null ? null : JSON.stringify(data),
        etag: usableEtag(result.etag) ? result.etag : undefined,
      };
    } catch {
      return { raw: null, etag: undefined };
    }
  }
  try {
    return { raw: await store.get(key), etag: undefined };
  } catch {
    return { raw: null, etag: undefined };
  }
};

/** `present` distinguishes a cold store from a corrupt or superseded blob. */
export const parseGuardedDoc = <T extends GuardedDoc>(
  raw: string | null,
  schema: z.ZodType<T>
): { doc: T | undefined; present: boolean } => {
  if (!raw) return { doc: undefined, present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: undefined, present: true };
  }
  const result = schema.safeParse(parsed);
  return { doc: result.success ? result.data : undefined, present: true };
};

/**
 * THE READ PREDICATE. `undefined` covers absent, unreadable, unparseable,
 * written-by-another-schema AND armed alike — one answer to a caller: rebuild.
 */
export const trustedGuardedDoc = <T extends GuardedDoc>(raw: string | null, schema: z.ZodType<T>): T | undefined => {
  const { doc } = parseGuardedDoc(raw, schema);
  return doc && doc.armed !== true ? doc : undefined;
};

export type GuardedLease<T extends GuardedDoc> = {
  /**
   * The TRUSTED document a commit merges into. Present iff `armed`, so a caller
   * can never merge onto rows it did not earn the right to replace — and never
   * onto rows that were not there.
   */
  previous: T | undefined;
  /** The seq the arm took and the commit must carry. */
  seq: number;
  /** CAS token for the commit: the etag the arm's own write returned. */
  etag: string | undefined;
  armed: boolean;
};

const writeArmed = async <T extends GuardedDoc>(
  io: GuardedDocIo<T>,
  seq: number,
  asOf: string,
  guard?: GuardedWriteGuard
): Promise<GuardedWriteResult> => io.write(io.schema.parse({ ...io.empty(seq, asOf), armed: true }), guard);

/** Best-effort sticky re-arm. Never throws: the mutation it guards is already durable. */
const reArm = async <T extends GuardedDoc>(io: GuardedDocIo<T>, seq: number, nowMs: number): Promise<void> => {
  try {
    await writeArmed(io, seq, new Date(nowMs).toISOString());
  } catch (error) {
    console.warn(`snapshots: could not arm ${io.label}; the next read will rebuild.`, error);
  }
};

/**
 * Raise the alarm and hand back the rows to amend. Called BEFORE the mutation
 * the snapshot projects — arming first is what makes a crash between the two
 * detectable. Every refusal STAMPS the flag rather than merely reporting
 * itself: a caller that retreats quietly leaves a document that looks current
 * and is not.
 */
export const armGuardedDoc = async <T extends GuardedDoc>(
  io: GuardedDocIo<T>,
  nowMs: number,
  options: {
    /**
     * Consulted with the TRUSTED document before anything is written. `true`
     * means this mutation does not move the projection enough to be worth an
     * amendment: no alarm is raised and the caller gets a refused lease.
     */
    skip?: (current: T | undefined) => boolean;
  } = {}
): Promise<GuardedLease<T>> => {
  const { raw, etag } = await io.read();
  const { doc } = parseGuardedDoc(raw, io.schema);
  const seq = (doc?.seq ?? 0) + 1;
  const refused: GuardedLease<T> = { previous: undefined, seq, etag: undefined, armed: false };
  const refuse = async (): Promise<GuardedLease<T>> => {
    await reArm(io, seq, nowMs);
    return refused;
  };

  // Already armed: somebody's commit never landed, so these rows are not the
  // whole truth. The flag is up, so there is nothing to write.
  if (doc?.armed === true) return refused;
  if (options.skip?.(doc)) return refused;

  /**
   * NO DOCUMENT WORTH AMENDING — cold, corrupt, or written by a schema version
   * this build does not read. The one rule that matters most here, and the one
   * `index-doc.ts` states for the same reason: an AMENDMENT MUST NEVER CREATE
   * THE DOCUMENT. Growing a snapshot one row at a time off a base nobody
   * validated is how the first chat saved after a deploy publishes a
   * ONE-ROW list of a workspace that has forty — trusted, complete-looking and
   * wrong. So the arm stamps the flag and lets the next READ rebuild from the
   * records, which is the only thing that knows what "every row" is.
   */
  if (!doc) return refuse();

  // No CAS token — a stale read cannot be told from a current one, so the right
  // to amend cannot be taken.
  if (!usableEtag(etag)) return refuse();

  const asOf = new Date(nowMs).toISOString();
  let result: GuardedWriteResult;
  try {
    result = await writeArmed(io, seq, asOf, { onlyIfMatch: etag });
  } catch (error) {
    console.warn(`snapshots: could not arm ${io.label}; the next read will rebuild.`, error);
    return refuse();
  }
  // Lost the arm: another writer moved this document between our read and our
  // write, so our view of the rows is not one we may commit on top of.
  if (!result || typeof result !== 'object' || result.modified !== true) return refuse();

  const armEtag = usableEtag(result.etag) ? result.etag : undefined;
  // The arm LANDED but the store will not say at what etag, so the commit can
  // never be conditional. The alarm is up and sticky; do not write again.
  if (!armEtag) return refused;
  return { previous: doc, seq, etag: armEtag, armed: true };
};

/** Commit the amended document and put the alarm down, or do neither. */
export const commitGuardedDoc = async <T extends GuardedDoc>(
  io: GuardedDocIo<T>,
  lease: GuardedLease<T>,
  next: T,
  nowMs: number
): Promise<boolean> => {
  if (!lease.armed || !lease.etag) return false;
  const doc = { ...next, seq: lease.seq, as_of: new Date(nowMs).toISOString() } as T;
  delete (doc as { armed?: boolean }).armed;
  try {
    const result = await io.write(io.schema.parse(doc), { onlyIfMatch: lease.etag });
    if (result && typeof result === 'object' && result.modified === true) return true;
  } catch (error) {
    console.warn(`snapshots: could not commit ${io.label}; the next read will rebuild.`, error);
  }
  await reArm(io, lease.seq + 1, nowMs);
  return false;
};

/**
 * The REBUILD write: a complete re-derivation from the records, so it is
 * unconditional and it clears the alarm — the distinction
 * `release/snapshot-store.ts` draws. A document AMENDED entry by entry must be
 * compare-and-swapped; one rewritten WHOLE cannot lose what it re-derived. A
 * rebuild racing an amendment makes that amendment lose its CAS, which re-arms
 * and costs one more rebuild. Never throws: failing to persist a cache must
 * never fail the read that noticed it was missing.
 */
export const writeRebuiltDoc = async <T extends GuardedDoc>(io: GuardedDocIo<T>, next: T): Promise<boolean> => {
  // One extra read keeps `seq` monotonic across a rebuild; free in context,
  // this path has just paid for a full sweep of the records.
  let seq = next.seq;
  try {
    const { doc } = parseGuardedDoc((await io.read()).raw, io.schema);
    seq = Math.max(seq, (doc?.seq ?? 0) + 1);
  } catch {
    // A store that cannot be read is one whose seq nobody can rely on.
  }
  const doc = { ...next, seq } as T;
  delete (doc as { armed?: boolean }).armed;
  try {
    await io.write(io.schema.parse(doc));
    return true;
  } catch (error) {
    console.warn(`snapshots: could not persist ${io.label}; the next read will rebuild.`, error);
    return false;
  }
};
