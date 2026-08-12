export type RunApprovalMode = 'ask' | 'safe-run';

/**
 * Wolf's ruling, 2026-08-12 (this session): "Approve safe actions" means
 * *continue the run without asking* — every pending approval in the run is
 * auto-approved, including publication, privileged, and unknown tools. This
 * used to be an allow-list (RUN_SAFE_TOOLS) of LEGACY tool names that no
 * longer matched the generated registry's canonical names, so the toggle
 * silently did nothing (Task 5 root cause 2). The function stays (so callers
 * keep one seam to read), but it now always returns true — the server
 * remains the sole authority: a risk floor still forces the pause in the
 * first place (see `resolveAutonomy`'s D2 clamp), an Owner gate still
 * enforces at EXECUTION, and Deny / "Ask each time" remain available at any
 * time.
 */
export function isRunSafeApproval(_tool: string): boolean {
  return true;
}

/**
 * Browser convenience only: the server remains the authority for every
 * approval. `approvalInStage` still fails closed (a staged proposal always
 * asks, regardless of the run's approval mode).
 */
export function shouldAutoApproveRunTool(mode: RunApprovalMode, tool: string, approvalInStage = false): boolean {
  return mode === 'safe-run' && !approvalInStage && isRunSafeApproval(tool);
}

/**
 * Persistence for the run-approval preference (Wolf's ruling, 2026-08-12):
 * the choice is per-chat and sticky — it survives turns, status changes,
 * remounts, and full page reloads (the admin is an MPA; every nav is a new
 * document) — scoped by the caller's `preferenceScope`, falling back to a
 * shared default scope when the caller has none yet (e.g. before a chat_id
 * exists). It changes ONLY when the editor clicks the other option, or when
 * an auto-approval is rejected by the server (the fail-safe downgrade).
 *
 * `sessionStorage` (not `localStorage`) matches the existing admin pattern in
 * `library-client.ts`: scoped to this tab/session, versioned key prefix, and
 * every read/write is guarded so SSR or disabled/private-browsing storage
 * never throws — it just behaves as if nothing were persisted.
 */
const STORAGE_KEY_PREFIX = 'run-approval-mode:v1:';

/** Used when a caller has no `preferenceScope` yet — matches the admin's other scoped-storage fallbacks. */
const DEFAULT_PREFERENCE_SCOPE = 'default';

const storageKeyForScope = (scope: string | undefined): string =>
  `${STORAGE_KEY_PREFIX}${scope || DEFAULT_PREFERENCE_SCOPE}`;

function isRunApprovalMode(value: unknown): value is RunApprovalMode {
  return value === 'ask' || value === 'safe-run';
}

/** Reads the persisted mode for a scope. Never throws; defaults to `'ask'` when unset, invalid, or storage is unavailable. */
export function readPersistedRunApprovalMode(scope: string | undefined): RunApprovalMode {
  try {
    const raw = sessionStorage.getItem(storageKeyForScope(scope));
    return isRunApprovalMode(raw) ? raw : 'ask';
  } catch {
    return 'ask';
  }
}

/** Persists a mode for a scope. Never throws — a write failure just means the choice isn't sticky this session. */
export function writePersistedRunApprovalMode(scope: string | undefined, mode: RunApprovalMode): void {
  try {
    sessionStorage.setItem(storageKeyForScope(scope), mode);
  } catch {
    // ignored — private browsing / disabled storage; in-memory state still
    // works for the rest of this page's lifetime, which is all this loses.
  }
}

/** Drops the persisted mode for one scope (used when a scope is torn down, e.g. a chat is deleted). */
export function clearPersistedRunApprovalMode(scope: string | undefined): void {
  try {
    sessionStorage.removeItem(storageKeyForScope(scope));
  } catch {
    // ignored — nothing to clear if storage isn't available
  }
}

/**
 * Drops every persisted run-approval mode, across all scopes — mirrors
 * `library-client.ts`'s `invalidateInventoryCache` on `goTrueClient.logout()`
 * so a shared machine's next sign-in never inherits the previous user's
 * per-chat approval preferences.
 */
export function clearAllPersistedRunApprovalModes(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // ignored — nothing to clear if storage isn't available
  }
}
