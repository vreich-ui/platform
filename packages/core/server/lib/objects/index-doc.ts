/**
 * `objects/index-doc.ts` — the two projection DOCUMENTS, and nothing that reads
 * records in bulk.
 *
 * Split out of `index-store.ts` in M0.1 for a reason the
 * `function-bundle-budget` test made concrete. The record-write choke point
 * (`record-writer.ts`) has to amend `objects/index.json` and stamp
 * `objects/version`, and `object-lock.ts` and `membership/offboarding.ts` are
 * both choke-point callers — so `admin-users`, a function that lists people,
 * suddenly statically reached the whole inventory SWEEP: listings, concurrency
 * helpers, the trusted-read path, the lot. Sixty kilobytes of cold start for
 * code it can never execute.
 *
 * So the dependency runs one way and stops: this module owns the two documents
 * — their keys, their schemas, reading them, writing them, arming and disarming
 * the drift alarm — and `index-store.ts` owns everything that needs a LISTING.
 * The choke point imports this file; the sweep imports both.
 *
 * Every design decision behind the documents themselves — why the index is
 * trusted at all, why the alarm is armed before the record rather than stamped
 * after it, what each interrupted write leaves behind — is stated once, in
 * `index-store.ts`'s header. Read that first; this file is the mechanism.
 */
import { z } from 'zod';

/**
 * M3.3 — the LEAF spelling. `object-inventory.js` re-exports this name and
 * adds the filter/sort/detail vocabulary a WRITER never calls; either compiles,
 * only this one is on `admin-users`' diet. See `object-inventory-row.ts`.
 */
import { inventoryRowFromRecord } from '../object-inventory-row.js';
import type { ApprovalPolicy } from '../../../lib/approval-policy.js';
import type { ObjectRecord } from '../../../schema/object-record-v1.js';

/**
 * ## The version, and why a bump is a hard break
 *
 * `v2` (W4.1): the ROW shape grew a `content` summary on `content_item` rows
 * (`object-inventory.ts`), so `/admin/variants` groups a family from the
 * listing instead of reading every record. A `v1` entry's `row` would still
 * PARSE — `row` is deliberately loose — and would then serve a row with no
 * `content` key, indistinguishable from an article that declares no parent.
 *
 * So the version is a `z.literal` in `objectIndexSchema` and `loadObjectIndex`
 * answers `undefined` for anything else: a `v1` blob is detected on the first
 * read after deploy and rebuilt in place by the same read-repair path that
 * already handles a corrupt or absent index. No script, no per-tenant
 * remediation. It costs one sweep, once, on one request per site, and
 * `stats.rebuilt` reports it (the idiom `requests/list-snapshot.ts` uses).
 *
 * The tolerant alternative is what `requests/store.ts` chose for
 * `object_published`, and its comment says why it could: that field's absence
 * has one honest reading (`false`). A missing `content` summary has none, so
 * tolerance would ship wrong variant families until something touched each
 * record.
 */
export const OBJECT_INDEX_SCHEMA_VERSION = 'object-inventory-index.v2';
export const OBJECT_INDEX_KEY = 'objects/index.json';

/**
 * M0.2 — the drift alarm.
 *
 * Two fields and nothing else, so that reading it costs what reading a
 * scalar costs. `seq` is a monotonic counter shared with `objects/index.json`:
 * the record-write choke point ARMS the alarm by writing `index.seq + 1` here
 * BEFORE it writes the record, and the index write that follows carries the
 * same `seq` and disarms it. `version.seq === index.seq` is therefore the
 * whole trust predicate, and any write that did not finish leaves the two
 * apart until a verified sweep puts them back together.
 *
 * `updated_at` is for a human reading the store, not for the predicate — a
 * clock is never part of a correctness decision here.
 *
 * ## REVIEW (2026-09-16) — `seq` alone was not enough
 *
 * The predicate above did not hold. Two writers read the index at `seq = S`
 * and both stamped `version.seq = S + 1`; the winner committed the index at
 * `S + 1`, so the pair AGREED and a `trusted: true` read served an index that
 * never mentioned the loser's record — live in the store, absent from the
 * library until the nightly `object-index-rebuild`. The same shape arrives
 * without concurrency, because on this runtime every store's requested
 * `'strong'` is silently EVENTUAL (`blob-store.ts`): a stale read of either
 * doc makes the disarm decision against state that has already moved.
 * Pinned by four cases in `tests/netlify/object-inventory-index.test.ts`.
 *
 * Three rules answer it:
 *
 *   - ARMING IS A COMPARE-AND-SWAP on this doc (`onlyIfMatch` the etag read,
 *     `onlyIfNew` when cold). CAS is evaluated against LIVE state, so a
 *     writer whose read was stale loses the arm and LEARNS it — which a seq
 *     comparison over an eventually-consistent read can never do.
 *   - A WRITER THAT DID NOT COMMIT SETS `armed: true` (`disarmRefused`).
 *     Sticky: only a full verified sweep clears it, because only a sweep
 *     re-derives every row from the records. A later writer that finds it set
 *     retreats the same way.
 *   - TRUST REQUIRES `version.seq === index.seq` AND `armed !== true`.
 *
 * `armed` is optional, so a pre-REVIEW blob parses and an older deployment
 * ignores it (zod strips unknown keys): the rollout window degrades to the
 * pre-fix behaviour, never to a parse failure.
 */
export const OBJECT_VERSION_KEY = 'objects/version';
export const OBJECT_VERSION_SCHEMA_VERSION = 'object-store-version.v1';

export const objectStoreVersionSchema = z.object({
  schema_version: z.literal(OBJECT_VERSION_SCHEMA_VERSION),
  seq: z.number().int().nonnegative(),
  updated_at: z.string(),
  /**
   * Sticky "this index is known to be short a row". Set by any writer that
   * armed and then could not commit; cleared only by a full verified sweep.
   * Absent means false — a pre-REVIEW blob, and the honest reading of it.
   */
  armed: z.boolean().optional(),
});
export type ObjectStoreVersion = z.infer<typeof objectStoreVersionSchema>;

/**
 * The row as STORED. `lock` and `requires_approval` are stripped from the
 * cached projection because they are re-derived per read (see the header); the
 * raw lease is kept so `lock` can be re-derived at any `atMs`.
 */
const indexEntrySchema = z.object({
  /** The record's blob key — the identity `store.list()` reports. */
  key: z.string(),
  /** The etag `list()` reported when `row` was projected. Never trusted when empty. */
  etag: z.string(),
  /**
   * `InventoryRow` minus the two re-derived fields. Kept as a loose record on
   * purpose: this is a cache, and a future row-shape change must degrade to a
   * re-read, never to a parse failure that breaks the library.
   */
  row: z.record(z.string(), z.unknown()),
  /** Raw `record.lock`, absent when the record held none. */
  lock: z.unknown().optional(),
});
export type ObjectIndexEntry = z.infer<typeof indexEntrySchema>;

export const objectIndexSchema = z.object({
  schema_version: z.literal(OBJECT_INDEX_SCHEMA_VERSION),
  /** Monotonic write counter, bumped by every index write including repairs. */
  seq: z.number().int().nonnegative(),
  updated_at: z.string(),
  entries: z.array(indexEntrySchema),
});
export type ObjectIndex = z.infer<typeof objectIndexSchema>;

/**
 * What a Netlify Blobs `setJSON` answers. `modified: false` is how a
 * CONDITIONAL write (`onlyIfNew` / `onlyIfMatch`) reports that it declined —
 * the loser of a race, which this module must never mistake for a success.
 */
export type BlobWriteResult = void | { modified?: boolean; etag?: string };

/**
 * The doc-level subset: enough to read and write `objects/index.json` and
 * `objects/version`, and nothing more. The record-write choke point holds a
 * store of exactly this shape — it has no business listing anything, and
 * `object-lock.ts`'s store never had a `list` to give it.
 */
export interface ObjectIndexDocStore {
  get(key: string): Promise<string | null>;
  /**
   * Optional on purpose: the local file-backed shim implements it without an
   * etag, and the hand-rolled fakes across `tests/` predate it entirely. It is
   * the ONLY source of the index etag, so a store without it simply never
   * disarms the drift alarm and always takes the verified sweep.
   */
  getWithMetadata?(
    key: string,
    options?: { type?: 'text' }
  ): Promise<{ data: unknown; etag?: string } | null | undefined>;
  /**
   * Answers `unknown` rather than `BlobWriteResult` so that every hand-rolled
   * fake store across `tests/` (all of which predate conditional writes and
   * return `Promise<void>` or `Promise<unknown>`) still satisfies this type.
   * The one place the answer MATTERS narrows it itself — see
   * `commitObjectIndexEntries`, which treats anything it cannot read as a
   * refusal.
   */
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<unknown>;
}

/** An etag is usable only when the store actually reported one (`local-blobs.ts` reports `''`). */
export const usableEtag = (etag: string | undefined): etag is string => typeof etag === 'string' && etag.length > 0;

/**
 * The index, plus WHY it is missing when it is. `superseded` means a blob was
 * there and could not be used — unparseable, or a schema version this build no
 * longer reads. That is a REBUILD; an absent key is merely a cold store.
 */
export type IndexRead = {
  index: ObjectIndex | undefined;
  superseded: boolean;
  /**
   * The index blob's own etag, when the store could report one. It is the
   * compare-and-swap token for the next write; `undefined` means this store
   * cannot do CAS on this key, so nothing may be written conditionally.
   */
  etag: string | undefined;
};

/**
 * Read the index blob with its etag when the store can give one. Falls back to
 * the plain `get` so a fake store that only implements `get` still works, at
 * the cost of never being able to write conditionally.
 */
/**
 * The same read, at any key. INTEGRATE (wave 2): M3.3 lifted this out of
 * `readIndexBlob` and EXPORTED it, so that its own alarm plumbing could reuse
 * it rather than copy it. That plumbing is gone — `snapshots/visual-identity.json`
 * is a `snapshots/guarded-doc.ts` document now and uses that module's
 * `readBlobWithEtag`, which is this function generalised the other way — so the
 * export has no consumer and is private again. The key parameter stays: it is
 * what makes the two spellings interchangeable if a third document ever wants
 * one of them.
 */
const readDocBlob = async (
  store: ObjectIndexDocStore,
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

const readIndexBlob = (store: ObjectIndexDocStore) => readDocBlob(store, OBJECT_INDEX_KEY);

export const readObjectIndex = async (store: ObjectIndexDocStore): Promise<IndexRead> => {
  const { raw, etag } = await readIndexBlob(store);
  if (!raw) return { index: undefined, superseded: false, etag };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { index: undefined, superseded: true, etag };
  }
  const result = objectIndexSchema.safeParse(parsed);
  return result.success
    ? { index: result.data, superseded: false, etag }
    : { index: undefined, superseded: true, etag };
};

/**
 * The alarm, as it currently stands. `undefined` covers absent, unreadable,
 * unparseable and written-by-another-schema alike: every one of them means
 * "nothing here may be trusted", which is the safe reading.
 */
const parseVersion = (raw: string | null): ObjectStoreVersion | undefined => {
  if (!raw) return undefined;
  try {
    const result = objectStoreVersionSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

export const readObjectStoreVersion = async (store: ObjectIndexDocStore): Promise<ObjectStoreVersion | undefined> => {
  try {
    return parseVersion(await store.get(OBJECT_VERSION_KEY));
  } catch {
    return undefined;
  }
};

/**
 * REVIEW — the alarm doc WITH its compare-and-swap token.
 *
 * `etag: undefined` is the honest answer for a store that cannot report one
 * (the local file-backed shim, every hand-rolled fake), and it is what makes
 * the arm refuse to take exclusive hold: no CAS token, no proof that the read
 * was not stale, so the writer never disarms and the sweep repairs. That is
 * the same degradation an etag-less LISTING already forces on this module.
 */
export const readObjectStoreVersionWithEtag = async (
  store: ObjectIndexDocStore
): Promise<{ version: ObjectStoreVersion | undefined; etag: string | undefined }> => {
  if (typeof store.getWithMetadata === 'function') {
    try {
      const result = await store.getWithMetadata(OBJECT_VERSION_KEY, { type: 'text' });
      if (!result) return { version: undefined, etag: undefined };
      const data = result.data;
      const raw = typeof data === 'string' ? data : data == null ? null : JSON.stringify(data);
      return { version: parseVersion(raw), etag: usableEtag(result.etag) ? result.etag : undefined };
    } catch {
      return { version: undefined, etag: undefined };
    }
  }
  return { version: await readObjectStoreVersion(store), etag: undefined };
};

/**
 * Stamp the alarm at `seq`.
 *
 * Unconditional by default — it is one small doc and it is only ever moved
 * forward. `guard` makes the write a compare-and-swap, which is how the ARM
 * takes exclusive hold of the right to commit an index row (see the schema
 * note above); the answer is then whether the write actually LANDED, and a
 * store that cannot prove it did is treated as a refusal, exactly as
 * `commitObjectIndexEntries` treats an unprovable index write.
 */
export const writeObjectStoreVersion = async (
  store: ObjectIndexDocStore,
  seq: number,
  nowIso: string,
  options: { armed?: boolean; guard?: { onlyIfMatch: string } | { onlyIfNew: true } } = {}
): Promise<boolean> => {
  const doc = objectStoreVersionSchema.parse({
    schema_version: OBJECT_VERSION_SCHEMA_VERSION,
    seq,
    updated_at: nowIso,
    ...(options.armed ? { armed: true } : {}),
  });
  if (!options.guard) {
    await store.setJSON(OBJECT_VERSION_KEY, doc);
    return true;
  }
  const result = (await store.setJSON(OBJECT_VERSION_KEY, doc, options.guard)) as BlobWriteResult;
  return Boolean(result && typeof result === 'object' && result.modified === true);
};

/** `undefined` when absent, unreadable, unparseable, or written by a different schema version — the caller then rebuilds. */
export const loadObjectIndex = async (store: ObjectIndexDocStore): Promise<ObjectIndex | undefined> =>
  (await readObjectIndex(store)).index;

/**
 * The approval policy this projection uses, and why it is a constant.
 *
 * `inventoryRowFromRecord` derives exactly ONE field from the active policy —
 * `requires_approval` — and this function strips that field before storing the
 * entry, because it is re-derived per read (see `index-store.ts`'s header on
 * time- and policy-dependent fields). Its default argument is
 * `activeApprovalPolicy()`, which THROWS when the site policy bindings have not
 * been imported.
 *
 * Before M0.1 that could not reach a write path. It can now: the record-write
 * choke point projects a row on every save, so an unbound provider would turn
 * a missing `import '…/policy-bindings.js'` — a startup wiring mistake, and one
 * every deployed shim happens to get right — into a thrown OBJECT WRITE.
 * Passing a value the caller cannot observe is strictly better than reading a
 * global whose absence is fatal: whatever this says, the field is discarded on
 * the next line and the real policy is applied when the row is read.
 */
const DISCARDED_POLICY: ApprovalPolicy = { master: 'all-autonomous', overrides: {} };

/** The one place an entry is derived from a record, so a cached row can never drift from the live projection's shape. */
export const projectIndexEntry = (key: string, etag: string, record: ObjectRecord, atMs: number): ObjectIndexEntry => {
  // `atMs` reaches only the two fields stripped below; every retained field is
  // a pure function of the record.
  const {
    lock: _lock,
    requires_approval: _requiresApproval,
    ...rest
  } = inventoryRowFromRecord(record, atMs, DISCARDED_POLICY);
  return {
    key,
    etag,
    row: rest as unknown as Record<string, unknown>,
    ...(record.lock ? { lock: record.lock } : {}),
  };
};

export const emptyIndex = (): ObjectIndex => ({
  schema_version: OBJECT_INDEX_SCHEMA_VERSION,
  seq: 0,
  updated_at: new Date(0).toISOString(),
  entries: [],
});

export const persistIndex = async (store: ObjectIndexDocStore, index: ObjectIndex, nowMs: number): Promise<boolean> => {
  try {
    await store.setJSON(
      OBJECT_INDEX_KEY,
      objectIndexSchema.parse({ ...index, updated_at: new Date(nowMs).toISOString() })
    );
    return true;
  } catch (error) {
    // The index is a cache. Failing to persist it costs the next call a full
    // sweep; it must never fail the call that noticed.
    console.warn('inventory: could not persist objects/index.json.', error);
    return false;
  }
};

// ═══ M0.1 — what the record-write choke point calls ════════════════════════

/**
 * The state a record write needs before it touches anything, plus the alarm
 * already armed when it is this module's job to arm it.
 *
 * `indexSeq` is the seq the returned `entries` came from and the seq the
 * eventual commit must carry. `armed === false` means the alarm was ALREADY
 * up when we looked — somebody else's write did not finish, or a store
 * without CAS never disarms — and in that case the caller must not commit an
 * index at all: the entries it holds are missing whatever that other write
 * did, and disarming would publish that gap as current.
 */
export type ObjectIndexWriteLease = {
  entries: readonly ObjectIndexEntry[];
  indexSeq: number;
  /** CAS token for the commit; `undefined` when the store cannot report one. */
  etag: string | undefined;
  /** False when the alarm was already armed, or when arming failed. */
  armed: boolean;
};

/**
 * Raise the drift alarm and hand back the index to amend.
 *
 * Called BEFORE the record blob is written. See the header, case 1: arming
 * first is what makes a crash between the record write and the index write
 * detectable at all.
 */
export const armObjectIndexWrite = async (
  store: ObjectIndexDocStore,
  nowMs: number
): Promise<ObjectIndexWriteLease> => {
  const [{ index, etag }, { version, etag: versionEtag }] = await Promise.all([
    readObjectIndex(store),
    readObjectStoreVersionWithEtag(store),
  ]);
  const indexSeq = index?.seq ?? 0;
  const entries = index?.entries ?? [];
  const nowIso = new Date(nowMs).toISOString();

  /**
   * REVIEW — the only safe way to NOT commit.
   *
   * Returning `armed: false` is not on its own enough to keep the alarm up:
   * another writer, or this one on its next call, can still arrive at a state
   * where `version.seq === index.seq` over an index that is short this
   * record. So every retreat STAMPS the sticky flag, which no committer ever
   * clears and only a full verified sweep puts down. Best-effort: if even
   * this write fails, the alarm keeps whatever it had, which is either
   * already armed or about to be re-armed by the next failed commit.
   */
  const retreat = async (seq: number): Promise<ObjectIndexWriteLease> => {
    try {
      await writeObjectStoreVersion(store, seq, nowIso, { armed: true });
    } catch (error) {
      console.warn('objects: could not arm objects/version; the index will be rebuilt on the next read.', error);
    }
    return { entries, indexSeq, etag, armed: false };
  };

  // Somebody's index write never landed, or a writer retreated: whatever the
  // index says, it is not the whole truth, and amending it entry by entry
  // would publish that gap as current.
  if (version && (version.armed === true || version.seq > indexSeq)) {
    return retreat(Math.max(version.seq, indexSeq) + 1);
  }
  // No index worth amending (cold, corrupt, superseded): let the next READ
  // rebuild it from records rather than growing a new one an entry at a time
  // off a base we never validated.
  if (!index) return retreat(Math.max(indexSeq, version?.seq ?? 0) + 1);

  /**
   * The arm is the serialization point. A CAS here is what distinguishes
   * "I read the current state" from "I read a state that has since moved" on
   * a store whose reads are eventually consistent — the store evaluates
   * `onlyIfMatch` against the live blob, so a stale read simply loses.
   *
   * A store that cannot report an etag for this doc cannot make that
   * distinction at all, so it arms best-effort and never commits: the
   * pre-M0 verified sweep, which is the documented degradation.
   */
  const guard = version
    ? usableEtag(versionEtag)
      ? ({ onlyIfMatch: versionEtag } as const)
      : undefined
    : ({ onlyIfNew: true } as const);
  if (!guard) return retreat(indexSeq + 1);

  let held: boolean;
  try {
    held = await writeObjectStoreVersion(store, indexSeq + 1, nowIso, { guard });
  } catch (error) {
    console.warn('objects: could not arm objects/version; the index will be rebuilt on the next read.', error);
    return retreat(Math.max(version?.seq ?? 0, indexSeq) + 1);
  }
  // Lost the arm: another writer moved this doc between our read and our
  // write, so our view of the index is not one we may commit on top of.
  if (!held) return retreat(Math.max(version?.seq ?? 0, indexSeq) + 1);
  return { entries, indexSeq, etag, armed: true };
};

/**
 * REVIEW — an armed writer that did NOT commit, telling the store so.
 *
 * A refusal must leave the alarm ARMED, and before this pass it did not: the
 * loser stamped `version.seq = indexSeq + 1` at arm time and the WINNER
 * committed the index at that same `indexSeq + 1`, so the two agreed and a
 * trusted read served an index missing the loser's record. Every path out of a
 * record write that is not a proven index write now sets the sticky flag, and
 * only a full verified sweep puts it down.
 *
 * Best-effort: the record it belongs to is already durable, and failing to
 * re-arm costs at worst what the pre-REVIEW code cost. It never throws.
 */
export const disarmRefused = async (
  store: ObjectIndexDocStore,
  lease: ObjectIndexWriteLease,
  nowMs: number
): Promise<void> => {
  try {
    await writeObjectStoreVersion(store, lease.indexSeq + 1, new Date(nowMs).toISOString(), { armed: true });
  } catch (error) {
    console.warn('objects: could not re-arm objects/version after a refused index commit.', error);
  }
};

/**
 * Amend the index and disarm the alarm, or do neither.
 *
 * Compare-and-swap on the index blob: `onlyIfMatch` is the etag the lease was
 * read at, so a second writer that slipped in between cannot be overwritten.
 * Declining is the normal, safe outcome — the alarm stays armed and the next
 * read rebuilds — so this answers a boolean rather than throwing.
 *
 * `upserts` replace by key; `removals` drop by key.
 */
export const commitObjectIndexEntries = async (
  store: ObjectIndexDocStore,
  lease: ObjectIndexWriteLease,
  change: { upserts?: readonly ObjectIndexEntry[]; removals?: readonly string[]; nowMs: number }
): Promise<boolean> => {
  const retreat = async (): Promise<false> => {
    await disarmRefused(store, lease, change.nowMs);
    return false;
  };

  // The arm already retreated and stamped the flag — nothing owed here.
  if (!lease.armed) return false;
  // No etag means no CAS means no safe read-modify-write of a shared doc.
  if (!lease.etag) return retreat();

  const removals = new Set(change.removals ?? []);
  const byKey = new Map<string, ObjectIndexEntry>();
  for (const entry of lease.entries) {
    if (!removals.has(entry.key)) byKey.set(entry.key, entry);
  }
  for (const entry of change.upserts ?? []) byKey.set(entry.key, entry);

  const merged = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const seq = lease.indexSeq + 1;
  const index: ObjectIndex = {
    schema_version: OBJECT_INDEX_SCHEMA_VERSION,
    seq,
    updated_at: new Date(change.nowMs).toISOString(),
    entries: merged,
  };

  try {
    const result = (await store.setJSON(OBJECT_INDEX_KEY, objectIndexSchema.parse(index), {
      onlyIfMatch: lease.etag,
    })) as BlobWriteResult;
    // `modified: false` is the CAS refusal. A store that answers nothing at
    // all cannot prove the write was conditional, so it is not trusted either.
    if (!result || typeof result !== 'object' || result.modified !== true) return retreat();
    return true;
  } catch (error) {
    console.warn('objects: could not commit the index row; the next read will rebuild.', error);
    return retreat();
  }
};

