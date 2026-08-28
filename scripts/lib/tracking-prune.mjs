/**
 * Mirror-prune core (T20.2) — select and optionally delete tracking mirror
 * blobs older than the 90-day retention window.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const parseMirrorDate = (key) => {
  const match = /^events\/(\d{4}-\d{2}-\d{2})\//.exec(key);
  return match?.[1] ?? null;
};

export const pruneBeforeDate = (today = new Date()) => {
  const midnightUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return new Date(midnightUtc - 90 * DAY_MS).toISOString().slice(0, 10);
};

export const selectPrunableKeys = (items, beforeDate) => {
  if (!DATE_RE.test(beforeDate)) throw new Error(`selectPrunableKeys: beforeDate must be yyyy-mm-dd (got ${beforeDate})`);
  const prunable = [];
  for (const item of items) {
    const key = typeof item === 'string' ? item : item?.key;
    if (typeof key !== 'string') continue;
    const date = parseMirrorDate(key);
    if (date && date < beforeDate) prunable.push(key);
  }
  return prunable.sort();
};

export const pruneMirrorKeys = async (keys, { del, dryRun = true } = {}) => {
  const sorted = [...keys].sort();
  if (!dryRun && typeof del !== 'function') throw new Error('pruneMirrorKeys: del is required when dryRun is false');
  let deleted = 0;
  if (!dryRun) {
    for (const key of sorted) {
      await del(key);
      deleted += 1;
    }
  }
  return { keys: sorted, matched: sorted.length, deleted, dryRun };
};
