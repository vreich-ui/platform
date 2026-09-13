/**
 * token-subject.ts — the ONE place a browser-side cache key is derived from an
 * Identity token.
 *
 * Two modules persist a resolved identity to this tab's `sessionStorage` so
 * the next `/admin/*` navigation can paint from it instead of waiting on a
 * round trip: `admin-access-client.ts` (the gate's `AdminAccessState`) and
 * `use-current-user.ts` (the `me` snapshot — roles, e-mail, display name, and
 * since T-shell the whole membership policy). Both must scope that entry to
 * the PERSON it belongs to, or one person's resolved identity is readable by,
 * and paintable for, whoever is at the keyboard next.
 *
 * They key it the same way, which is why the derivation lives here rather than
 * twice: the token's `sub` claim, not the raw token, because a token rotates
 * on every refresh while the subject is what stays stable for a session. Two
 * copies of this that drifted would be two caches disagreeing about whose
 * entry is whose — the one bug the keying exists to prevent.
 *
 * DELIBERATELY DEPENDENCY-FREE. `admin-access-client.ts` is imported by
 * `HeaderAuthButton.astro`, which ships on every PUBLIC reader page, so
 * anything it reaches is reader weight; this module imports nothing at all.
 */

const base64UrlDecode = (segment: string): string => {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return atob(padded);
};

/**
 * Pulls the `sub` claim out of a JWT without verifying it — this is a cache
 * key, never a trust boundary; the server verifies the token on every real
 * request regardless of anything decoded here.
 *
 * `null` for anything that is not a readable JWT with a non-empty `sub`
 * (including a missing token), and every caller treats that as "this tab has
 * no cache to read or write" rather than falling back to an unscoped key.
 */
export const decodeTokenSubject = (token: string | null | undefined): string | null => {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(base64UrlDecode(payload)) as { sub?: string };
    return typeof decoded.sub === 'string' && decoded.sub ? decoded.sub : null;
  } catch {
    return null;
  }
};
