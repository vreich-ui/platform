/**
 * Did the retag actually land? — the decision half of `admin-inventory`'s
 * `retag-artifact` action.
 *
 * WHY THIS EXISTS. `retag-artifact` used to answer 200 the moment
 * `writeArtifactReferenceIndexes` resolved, and echo back the tag list it had
 * COMPUTED. The client turned that 200 into "N of N updated". Nothing in the
 * loop ever read the index back, so every way the new tag could fail to be
 * there afterwards — a write that resolved against a store whose requested
 * `consistency: 'strong'` is silently eventual on this runtime
 * (`server/lib/blob-store.ts`, W14 T14.4), an index entry that stopped
 * parsing, an entry written under a key the next reader does not look at —
 * produced the same cheerful success message as a write that worked. That is
 * exactly the shape the Inventory brief forbids: a surface claiming a state it
 * cannot prove. It cost a live acceptance run: the owner tagged two artifacts,
 * was told it worked, searched for the tag, and got zero rows with nothing
 * anywhere saying which of the two statements was the lie.
 *
 * So the server now re-reads the canonical reference after writing it and runs
 * the answer through this function. `verified` is the only thing downstream is
 * allowed to treat as "the tag is on the artifact"; everything else is
 * reported with the store's own answer attached.
 *
 * Pure and store-free on purpose — the I/O lives in the server function, the
 * ruling lives here where `artifact-retag-verification.test.ts` can see it.
 */

/** What re-reading the artifact-index entry answered — mirrors `ArtifactReferenceRead`. */
export type ArtifactRetagReadback =
  | { status: 'ok'; tags?: readonly string[] | undefined }
  | { status: 'absent' }
  | { status: 'rejected'; issue: string };

export type ArtifactRetagVerification = {
  /** True ONLY when the store itself reported exactly the tag set the write intended. */
  verified: boolean;
  /**
   * The tags the STORE reports, never the ones the request computed. Empty for
   * a read-back that failed — an unreadable entry proves nothing about tags,
   * and inventing the intended list here is the fabrication this module
   * exists to stop.
   */
  persistedTags: string[];
  /** Intended tags the read-back did not carry. */
  missing: string[];
  /** Tags the read-back carries that the write did not intend (e.g. a removal that did not take). */
  unexpected: string[];
  /** Present exactly when `verified` is false: what to tell the operator. */
  reason?: string;
};

/** Tags compare case-insensitively here, the same rule `applyArtifactTagChanges` uses for its arithmetic. */
const foldTags = (tags: readonly string[] | undefined): string[] =>
  (tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);

const list = (tags: readonly string[]): string => (tags.length ? tags.join(', ') : '(none)');

/**
 * Compares the tag list the write intended to leave behind against the one a
 * fresh read of the index actually reports.
 *
 * `intendedTags` is `applyArtifactTagChanges(...).tags` — the complete list the
 * reference should now carry, so this covers a removal that did not take
 * exactly as it covers an addition that did not.
 */
export const verifyArtifactRetag = (
  intendedTags: readonly string[],
  readback: ArtifactRetagReadback
): ArtifactRetagVerification => {
  if (readback.status === 'absent') {
    return {
      verified: false,
      persistedTags: [],
      missing: [...intendedTags],
      unexpected: [],
      reason:
        'The artifact index entry could not be read back after the write, so the new tags are not proven. Nothing was reported as changed.',
    };
  }

  if (readback.status === 'rejected') {
    return {
      verified: false,
      persistedTags: [],
      missing: [...intendedTags],
      unexpected: [],
      reason: `The artifact index entry is not usable after the write (${readback.issue}), so the new tags are not proven.`,
    };
  }

  const persistedTags = [...(readback.tags ?? [])];
  const intendedKeys = new Set(foldTags(intendedTags));
  const persistedKeys = new Set(foldTags(persistedTags));

  const missing = intendedTags.filter((tag) => !persistedKeys.has(tag.trim().toLowerCase()));
  const unexpected = persistedTags.filter((tag) => !intendedKeys.has(tag.trim().toLowerCase()));

  if (missing.length === 0 && unexpected.length === 0) {
    return { verified: true, persistedTags, missing, unexpected };
  }

  return {
    verified: false,
    persistedTags,
    missing,
    unexpected,
    reason: `The write was accepted but the artifact index still reports ${list(persistedTags)} — expected ${list(
      intendedTags
    )}. The change is NOT confirmed; re-read the artifact before relying on it.`,
  };
};
