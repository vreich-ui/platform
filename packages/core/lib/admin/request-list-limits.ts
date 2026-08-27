/**
 * The contract between `admin-requests {action:'list'}` and every client of it.
 *
 * This MUST equal `REQUEST_PAGE_SIZE` in
 * `packages/core/server/functions/admin-requests.ts`. That handler's Zod
 * schema caps `limit` with `.max(REQUEST_PAGE_SIZE)`, so a client asking for
 * more does NOT get a truncated page — it gets a 400 `Invalid request fields.`
 * and the view never loads at all.
 *
 * That is exactly what shipped: `requests-store.ts` asked for 200 against a
 * cap of 100, so every list call from the shared poll 400'd and `/admin/requests`
 * rendered a permanent skeleton, taking the header "Needs you" pill down with
 * it (both read the same store).
 *
 * It lives in its own module, rather than in `requests-client.ts`, so the
 * server's own test can import it without pulling in a fetch client — the two
 * numbers are asserted equal in `admin-requests.test.ts` and cannot drift
 * apart again.
 */
export const REQUEST_LIST_MAX_LIMIT = 100;
