export type RunApprovalMode = 'ask' | 'safe-run';

export interface RunModeOption {
  value: RunApprovalMode;
  label: string;
}

/**
 * The two mutually exclusive run-mode choices, in display order. Shared
 * between the trigger label and the menu items (A5's segmented pill) so they
 * can never drift apart.
 */
export const RUN_MODE_OPTIONS: readonly RunModeOption[] = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'safe-run', label: 'Approve safe actions' },
];

export interface RunModeControlState {
  options: readonly RunModeOption[];
  /** Whether Test mode is available to THIS caller. */
  enabled: boolean;
  /** Present exactly when `enabled` is false — the D3 Popover's hover text. */
  reason?: string;
}

/**
 * A5 — the pure decision behind the run-mode control's owner-only Test-mode
 * gate (`AgentsHub.tsx`'s `owner` check at ~:301), extracted so it is
 * unit-testable without rendering React (BRIEF.md's test convention). `roles`
 * is the CALLER's own already-resolved role list — this function resolves
 * nothing itself, exactly like `useTestMode`'s `allowed` above: the server
 * independently re-derives roles before honouring the flag regardless, so a
 * stale or spoofed client-side role list can never grant more than a
 * disabled-with-a-reason control.
 *
 * Per Convention D3, a caller renders the control disabled-with-`reason`
 * (via `Popover mode="hover"`) rather than hiding it outright whenever
 * `enabled` is false.
 */
export function runModeControl(roles: readonly string[]): RunModeControlState {
  const owner = roles.includes('owner');
  return owner
    ? { options: RUN_MODE_OPTIONS, enabled: true }
    : { options: RUN_MODE_OPTIONS, enabled: false, reason: 'Test mode is owner-only.' };
}

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

/**
 * TEST MODE (Wolf, 2026-08-24) — the operator's "I am exercising mechanics, not
 * producing editorial copy" switch, persisted exactly like the approval mode
 * above and scoped per chat.
 *
 * DELIBERATELY NOT a third `RunApprovalMode`. Those two are a mutually
 * exclusive pair — a run is either asking or continuing — whereas test mode is
 * ORTHOGONAL: you still want ask-vs-continue while testing. Folding it into
 * that union would have forced a false choice between them.
 *
 * This flag is a REQUEST, never a grant. It is sent with the turn and the
 * server independently re-derives the caller's roles before honouring it
 * (`admin-agent-chat.ts`, the `send` case). A browser that sets this without
 * the matching identity changes nothing — which is the whole reason the switch
 * lives here and the authority does not.
 */
const TEST_MODE_KEY_PREFIX = 'run-test-mode:v1:';

const testModeKeyForScope = (scope: string | undefined): string =>
  `${TEST_MODE_KEY_PREFIX}${scope || DEFAULT_PREFERENCE_SCOPE}`;

/** Reads the persisted test-mode flag for a scope. Never throws; defaults to `false`. */
export function readPersistedTestMode(scope: string | undefined): boolean {
  try {
    return sessionStorage.getItem(testModeKeyForScope(scope)) === 'on';
  } catch {
    return false;
  }
}

/** Persists the test-mode flag for a scope. Never throws — a write failure just means the choice isn't sticky. */
export function writePersistedTestMode(scope: string | undefined, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(testModeKeyForScope(scope), 'on');
    else sessionStorage.removeItem(testModeKeyForScope(scope));
  } catch {
    // ignored — private browsing / disabled storage
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
      if (key?.startsWith(STORAGE_KEY_PREFIX) || key?.startsWith(TEST_MODE_KEY_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // ignored — nothing to clear if storage isn't available
  }
}
