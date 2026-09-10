/**
 * server-timing.ts (T0.1) — Server-Timing instrumentation for admin function
 * handlers.
 *
 * Measurements on the live admin surface showed the SAME function varying
 * 445 ms -> 5164 ms, with two suspected causes that look identical from the
 * outside: a cold Lambda container paying Node module-init + first `import`
 * of everything the function touches, and a warm one that is simply
 * competing with other in-flight requests for the same downstream (Blobs,
 * GitHub, Netlify Analytics). Chrome devtools' Network panel already renders
 * a `Server-Timing` response header as a per-request waterfall breakdown —
 * this module is the one place that header gets built, so every wrapped
 * handler reports the same four metrics the same way and a look at the
 * Network tab (not another investigation) says which of the two it was.
 *
 * ## The four metrics (all `;dur=` in milliseconds)
 *
 *   - `cold`   — 1 on this container's first invocation, 0 on every later one
 *     sharing the same warm container; `;desc="<ms since module load>"` is
 *     attached only on the cold sample (a warm sample's "ms since load" is
 *     just wall-clock container age, not a measurement of anything). A
 *     module-scope boolean, per the brief — see "Concurrency" below for why
 *     that's safe on this runtime.
 *   - `auth`   — time inside the request's auth/access-resolution call
 *     (`resolveAdminAccessFromEvent` / `getAdminStateFromEvent`, whichever
 *     the handler uses), via `timeAuth`.
 *   - `serialize` — time inside `JSON.stringify` producing the response
 *     body, via `timeSerialize`.
 *   - `work`   — everything else: `total - auth - serialize`, floored at 0.
 *     Deliberately DERIVED rather than separately instrumented: a large
 *     action-dispatched handler (admin-agent-chat.ts alone has 13 verbs,
 *     admin-object.ts's verb surface is shared with the publish-key path)
 *     would need a `timeWork` call threaded through every branch to measure
 *     it directly, and a call site missed on one branch would silently
 *     under-report that branch's time forever. The two phases that ARE cheap
 *     and unambiguous to isolate — the one auth call every wrapped handler
 *     makes near the top, and the one `JSON.stringify` every response goes
 *     through (this file's handlers all share the small local `jsonResponse`
 *     helper convention) — are instrumented directly; `work` is what's left,
 *     and can never under-count because a new branch forgot to wrap itself.
 *
 * ## Composition
 *
 * Same shape as every other cross-cutting concern already applied at
 * `createHandler` in this directory (see `admin-auth-state.ts` and its
 * `(binding) => buildHandlerImpl(binding)` factory): a wrapper applied once,
 * at export time —
 *
 *   export const createHandler = (binding: SiteBinding) =>
 *     withServerTiming('admin-analytics', buildHandlerImpl(binding));
 *
 * and, inside `buildHandlerImpl`, exactly two call sites change shape —
 * wrap the auth call:
 *
 *   const adminState = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
 *
 * and wrap the local `jsonResponse` helper's `JSON.stringify`:
 *
 *   body: timeSerialize(() => JSON.stringify({ ok: ..., ...body })),
 *
 * A handler with more than one auth call site (several `admin-analytics.ts`
 * resource branches each resolve access independently) wraps each one —
 * `timeAuth`'s cost accumulates across calls within one invocation, it does
 * not overwrite. `timeAuth`/`timeSerialize` are safe no-ops (they just run
 * the callback and return its result) outside a `withServerTiming`-wrapped
 * invocation, so nothing that calls a wrapped handler's internals directly —
 * a unit test constructing a request by hand, say — needs to change.
 *
 * ## Safety
 *
 * `withServerTiming` NEVER changes status code or body, and never throws past
 * the header-attach step: if computing the header somehow fails, the
 * original response is returned untouched and a warning is logged. A 304
 * (empty body) or an error response gets the header exactly like a 200 —
 * headers are merged (spread), never replaced, so an existing `ETag` /
 * `Cache-Control` survives.
 *
 * ## `sweep.stats`-style diagnostics
 *
 * Several handlers on this surface return an inventory-sweep diagnostic
 * object (`object-verbs.ts`'s `sweep.stats`, surfaced as `index` on `list`/
 * `inventory` verb responses). That object is worth seeing NEXT TO the timing
 * breakdown in Netlify's function logs — a slow `work` sample on a request
 * whose sweep touched thousands of records is a different finding than a
 * slow `work` sample on a small one. `logDiagnostics` is a plain `console.log`
 * call for a handler to make explicitly next to its sweep — it is never
 * placed on the response, so nothing here can leak it to the wire.
 *
 * ## Concurrency
 *
 * The module-scope mutable state below (`hasHandledInvocation`, and the
 * single "current invocation" timing accumulator `timeAuth`/`timeSerialize`
 * write into) is safe under Netlify Functions' AWS-Lambda-compatible
 * execution model: an execution environment (container, and therefore one
 * loaded copy of this module) never runs two invocations concurrently — a
 * burst of traffic gets more containers, each with its own fresh module
 * state, not interleaved calls into one. That is the same assumption the
 * brief's own `cold` design leans on (a single module-scope boolean, first
 * invocation wins), so this file does not invent a stronger requirement than
 * the feature it is instrumenting already has.
 */

const moduleLoadedAtMs = Date.now();

/** T0.1: single module-scope flag — true once this container has handled one invocation. */
let hasHandledInvocation = false;

type TimingAccumulator = { authMs: number; serializeMs: number };

/** The in-flight invocation's accumulator, or null outside any wrapped call. */
let currentInvocation: TimingAccumulator | null = null;

const round2 = (ms: number): number => Math.round(ms * 100) / 100;

/**
 * Wrap the handler's auth/access-resolution call. Accumulates into the
 * current invocation's `auth` metric; a safe no-op (just runs `fn`) when
 * called outside a `withServerTiming`-wrapped invocation. Call it once per
 * auth call site — a handler with several independent branches, each
 * resolving access itself, may call this more than once per invocation; the
 * durations sum.
 */
export const timeAuth = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const invocation = currentInvocation;
  const start = invocation ? performance.now() : 0;
  try {
    return await fn();
  } finally {
    if (invocation) invocation.authMs += performance.now() - start;
  }
};

/**
 * Wrap the response-body `JSON.stringify` call. Accumulates into the current
 * invocation's `serialize` metric; a safe no-op (just runs `fn`) outside a
 * `withServerTiming`-wrapped invocation. Synchronous, matching `JSON.stringify`
 * itself — a handler's local `jsonResponse` helper is not async.
 */
export const timeSerialize = <T>(fn: () => T): T => {
  const invocation = currentInvocation;
  const start = invocation ? performance.now() : 0;
  try {
    return fn();
  } finally {
    if (invocation) invocation.serializeMs += performance.now() - start;
  }
};

/**
 * Log a `sweep.stats`-shaped diagnostic object next to this invocation's
 * timing, so both land on the same Netlify function-log line. Never placed
 * on the response — console only. A no-op when `stats` is undefined (most
 * verbs on a wrapped handler carry no sweep at all).
 */
export const logDiagnostics = (metricName: string, stats: unknown): void => {
  if (stats === undefined) return;
  console.log(`[server-timing] ${metricName} sweep.stats:`, stats);
};

/**
 * The minimal structural bound every `server/functions/*.ts` handler's
 * response already satisfies. Deliberately loose (`headers` allows an
 * `undefined` value per key, `body` is optional) — this repo's handlers
 * return several DIFFERENT concrete header shapes across their own branches
 * (a JSON error branch vs. a binary-image branch with `Content-Disposition`,
 * say), and `withServerTiming` below is generic over the handler's own exact
 * response type rather than coercing every wrapped handler onto one rigid
 * shape, precisely so wrapping a handler never has to fight that.
 */
type LambdaResponse = {
  statusCode: number;
  headers?: Record<string, string | undefined>;
  body?: string;
  [key: string]: unknown;
};

/**
 * Wrap an admin function handler so its response carries a `Server-Timing`
 * header with `cold`, `auth`, `work`, and `serialize`, all in milliseconds.
 * See this file's header comment for the full contract and the two call
 * sites (`timeAuth`, `timeSerialize`) a wrapped handler is expected to use.
 *
 * Generic over `R` (the handler's OWN response type, whatever shape it
 * already returns) rather than fixed to one canonical response interface:
 * the returned handler still resolves to `R` — callers, and any test that
 * imports the wrapped handler directly, see exactly the type they already
 * had. Only `.headers` is touched at runtime (spread, never replaced).
 *
 * `metricName` is never placed on the response — it is passed to
 * `console.error` if header construction fails, so a broken wrap is
 * attributable in the logs without becoming wire content.
 */
export const withServerTiming = <E, C, R extends LambdaResponse>(
  metricName: string,
  handler: (event: E, context?: C) => Promise<R>
): ((event: E, context?: C) => Promise<R>) => {
  return async (event: E, context?: C) => {
    const invocationStartMs = performance.now();
    const invocationStartWallMs = Date.now();
    const isCold = !hasHandledInvocation;
    hasHandledInvocation = true;

    const accumulator: TimingAccumulator = { authMs: 0, serializeMs: 0 };
    const previousInvocation = currentInvocation;
    currentInvocation = accumulator;

    let response: R;
    try {
      response = await handler(event, context);
    } finally {
      currentInvocation = previousInvocation;
    }

    try {
      if (!response || typeof response !== 'object') return response;

      const totalMs = performance.now() - invocationStartMs;
      const workMs = Math.max(0, totalMs - accumulator.authMs - accumulator.serializeMs);
      const coldDesc = isCold ? `;desc="${round2(invocationStartWallMs - moduleLoadedAtMs)}"` : '';

      const headerValue = [
        `cold;dur=${isCold ? 1 : 0}${coldDesc}`,
        `auth;dur=${round2(accumulator.authMs)}`,
        `work;dur=${round2(workMs)}`,
        `serialize;dur=${round2(accumulator.serializeMs)}`,
      ].join(', ');

      // Only `.headers` changes; every other field of `response` (including
      // any non-standard ones a handler carries) passes through untouched.
      // Cast back to `R`: this spread can only ever ADD/override the single
      // `Server-Timing` key, so it stays within whatever `R`'s `headers`
      // shape already allows.
      return {
        ...response,
        headers: { ...(response.headers ?? {}), 'Server-Timing': headerValue },
      } as R;
    } catch (error) {
      // Never let header construction break a real response.
      console.error(`[server-timing] failed to attach Server-Timing header for ${metricName}.`, error);
      return response;
    }
  };
};
