/**
 * Per-member write rate limit (W7.5).
 *
 * WHAT IT IS FOR, precisely. Not security — an authenticated editor is not an
 * attacker, and a limit low enough to stop a determined one would stop real
 * work. It is a BLAST-RADIUS BOUND on the thing that actually happens: an agent
 * loop that retries a failing write, or a run that mistakes a 502 for a
 * no-op and re-issues it forty times. Each of those writes costs a blob write,
 * a history entry, and — past a publish — a git commit. The ledger is
 * append-only and never pruned, so a runaway loop is not a transient: it
 * permanently bloats an object's history.
 *
 * FIXED WINDOW, NOT SLIDING. A sliding window needs the timestamps of every
 * call in the period; a fixed window needs one counter. The cost of the
 * simplicity is the standard one — a caller can spend the tail of one window
 * and the head of the next, so the true worst case is ~2× the limit over a
 * window boundary. At a bound whose job is "stop a loop, never stop a person",
 * 2× a generous limit is still generous, and a second store round trip on every
 * write to buy exactness is a bad trade.
 *
 * FAIL OPEN, ALWAYS. A store outage must never stop an editor from publishing.
 * Every failure path here returns "allowed" — the limit is a courtesy to the
 * store, and a courtesy that can take down publishing is a defect.
 */

/** The two knobs, and the numbers behind them. */
export const WRITE_RATE_LIMIT = {
  /**
   * 60 writes in 10 minutes — one every ten seconds, sustained. A human editor
   * working through an article with an agent does not approach it; the live
   * moisturizer run, the busiest real session on record, made 17 tool calls
   * across the whole article. A loop reaches it in seconds.
   */
  max: 60,
  windowMs: 10 * 60 * 1000,
} as const;

export type RateLimitVerdict =
  | { allowed: true; remaining: number }
  | {
      allowed: false;
      /** Seconds until the current window ends — what a 429's Retry-After carries. */
      retryAfterSeconds: number;
      limit: number;
      windowSeconds: number;
    };

export interface RateLimitStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

/**
 * The counter key. Includes the window index, so an expired window's counter is
 * simply a key nobody reads again — no sweep, no TTL, no cleanup job. Blob
 * stores charge for what you read, not for what you leave behind.
 */
export const rateLimitKey = (subject: string, atMs: number): string =>
  `ratelimit/write/${Math.floor(atMs / WRITE_RATE_LIMIT.windowMs)}/${encodeURIComponent(subject)}`;

/**
 * Count one write against `subject` and say whether it may proceed.
 *
 * `subject` is the OAuth-bound member's id where there is one, and the verified
 * agent name otherwise. Deliberately NOT the client id: two editors sharing a
 * chat app must not throttle each other, and one editor with two connectors
 * should share one budget.
 */
export const countWrite = async (
  store: RateLimitStore | undefined,
  subject: string,
  atMs: number = Date.now()
): Promise<RateLimitVerdict> => {
  if (!store || !subject) return { allowed: true, remaining: WRITE_RATE_LIMIT.max };

  const key = rateLimitKey(subject, atMs);
  const windowEndMs = (Math.floor(atMs / WRITE_RATE_LIMIT.windowMs) + 1) * WRITE_RATE_LIMIT.windowMs;

  let used = 0;
  try {
    const raw = await store.get(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { count?: unknown };
      if (typeof parsed.count === 'number' && Number.isFinite(parsed.count)) used = parsed.count;
    }
  } catch {
    // Unreadable counter → treat as the first write of the window. See the
    // fail-open note in the header: a store fault must not stop an editor.
    used = 0;
  }

  if (used >= WRITE_RATE_LIMIT.max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - atMs) / 1000)),
      limit: WRITE_RATE_LIMIT.max,
      windowSeconds: WRITE_RATE_LIMIT.windowMs / 1000,
    };
  }

  try {
    await store.setJSON(key, { count: used + 1, window_ends_at: new Date(windowEndMs).toISOString() });
  } catch {
    // The write was allowed; failing to record it only loses a tick.
  }

  return { allowed: true, remaining: WRITE_RATE_LIMIT.max - used - 1 };
};
