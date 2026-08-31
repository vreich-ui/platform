import { useCallback, useEffect, useRef, useState } from 'react';

import type { UseChatState } from './chat';
import { DropdownMenu, type MenuItem } from './menus';
import { Popover } from './overlays';
import {
  readPersistedRunApprovalMode,
  readPersistedTestMode,
  runModeControl,
  shouldAutoApproveRunTool,
  writePersistedRunApprovalMode,
  writePersistedTestMode,
  type RunApprovalMode,
} from '@core/lib/admin/approval-mode';

/**
 * A5 — a small segmented pill, sized to sit in the composer's bottom-left
 * (`ChatComposer`'s `runMode` prop) rather than a full-width row above it.
 * The ask/safe-run choice is the kit `DropdownMenu`, labelled with the
 * CURRENT selection (e.g. "Ask each time ▾") so the trigger itself always
 * shows the live mode. Test mode is a second, separate pill next to it —
 * ORTHOGONAL to the dropdown (see `useTestMode`'s doc comment) — and per
 * Convention D3 it is now ALWAYS rendered, never hidden for a non-owner:
 * `runModeControl` (pure, unit-tested in `approval-mode.test.ts`) decides
 * whether it's enabled, and a disabled one explains why via
 * `Popover mode="hover"`, reachable by keyboard/touch as well as a mouse.
 */
export function RunApprovalControls({
  mode,
  onChange,
  testMode = false,
  onTestModeChange,
  canUseTestMode = false,
}: {
  mode: RunApprovalMode;
  onChange: (mode: RunApprovalMode) => void;
  /** Orthogonal to `mode` — a run can be asking OR continuing while in test mode. */
  testMode?: boolean;
  onTestModeChange?: (on: boolean) => void;
  /**
   * Owner-only (`AgentsHub.tsx`'s `owner` check, `AgentRail.tsx`'s prop of
   * the same name). Fed straight into `runModeControl` as the caller's
   * already-resolved role — the server re-derives roles independently
   * before ever honouring the flag either way.
   */
  canUseTestMode?: boolean;
}) {
  const testGate = runModeControl(canUseTestMode ? ['owner'] : []);
  const currentLabel = testGate.options.find((option) => option.value === mode)?.label ?? testGate.options[0].label;

  const items: MenuItem[] = testGate.options.map((option) => ({
    id: option.value,
    label: option.label,
    title: option.value === 'safe-run' ? 'Continue through every action this run proposes without asking. You can still deny or switch back.' : undefined,
    onSelect: () => onChange(option.value),
  }));

  return (
    <div className="flex items-center gap-1" aria-label="Run approval preference">
      <DropdownMenu
        align="start"
        items={items}
        trigger={({ ref, open, onToggle }) => (
          <button
            ref={ref}
            type="button"
            onClick={onToggle}
            aria-haspopup="menu"
            aria-expanded={open}
            className="adm-focusable inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--adm-radius-pill)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)] hover:text-[var(--adm-text)]"
          >
            {currentLabel} ▾
          </button>
        )}
      />
      {onTestModeChange ? (
        testGate.enabled ? (
          <button
            type="button"
            aria-pressed={testMode}
            onClick={() => onTestModeChange(!testMode)}
            title="Exercise publishing mechanics with the committed test fixture instead of writing client copy."
            className={`adm-focusable whitespace-nowrap rounded-[var(--adm-radius-pill)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium ${testMode ? 'bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : 'text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]'}`}
          >
            Test mode
          </button>
        ) : (
          <Popover
            mode="hover"
            content={testGate.reason ?? 'Owner only.'}
            disabled
            trigger={(a11y) => (
              <button
                type="button"
                disabled
                {...a11y}
                className="whitespace-nowrap rounded-[var(--adm-radius-pill)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)] opacity-50"
              >
                Test mode
              </button>
            )}
          />
        )
      ) : null}
    </div>
  );
}

/**
 * The test-mode switch, persisted per chat exactly like `useRunApprovalMode`.
 *
 * `allowed` is the caller's own owner check (the admin surfaces already hold
 * `me.roles`). When it is false the hook reports `false` and its setter is a
 * no-op, so a stale persisted `on` from a previous session can never re-arm the
 * switch for someone who is no longer an owner. The server re-derives roles per
 * turn regardless — this is convenience, not the gate.
 */
export function useTestMode(
  { preferenceScope, allowed }: { preferenceScope?: string; allowed: boolean }
): [boolean, (on: boolean) => void] {
  const [on, setOnState] = useState<boolean>(() => (allowed ? readPersistedTestMode(preferenceScope) : false));
  const scopeRef = useRef(preferenceScope);
  scopeRef.current = preferenceScope;

  const setOn = useCallback(
    (next: boolean) => {
      if (!allowed) return;
      writePersistedTestMode(scopeRef.current, next);
      setOnState(next);
    },
    [allowed]
  );

  // A scope change (switching chats) loads THAT chat's own stored value.
  useEffect(() => {
    setOnState(allowed ? readPersistedTestMode(preferenceScope) : false);
  }, [allowed, preferenceScope]);

  return [on, setOn];
}

/**
 * Shared run-only preference behavior for every admin chat surface.
 *
 * Per Wolf's ruling (2026-08-12), this preference is per-chat and sticky: it
 * persists (via `approval-mode.ts`, `sessionStorage`-backed) across turns,
 * status changes, remounts, and full page reloads, scoped by
 * `preferenceScope`. It changes only when the editor clicks the other
 * option, or when an auto-approval below is rejected by the server — both
 * paths go through `setMode`, which persists as well as updates state.
 */
export function useRunApprovalMode(
  chat: Pick<UseChatState, 'pending' | 'busy' | 'approve' | 'pendingConsumed'>,
  { preferenceScope, approvalInStage = false }: { preferenceScope?: string; approvalInStage?: boolean } = {}
): [RunApprovalMode, (mode: RunApprovalMode) => void] {
  const [mode, setModeState] = useState<RunApprovalMode>(() => readPersistedRunApprovalMode(preferenceScope));
  const autoApproved = useRef(new Set<string>());
  const scopeRef = useRef(preferenceScope);
  scopeRef.current = preferenceScope;

  const setMode = useCallback((next: RunApprovalMode) => {
    writePersistedRunApprovalMode(scopeRef.current, next);
    setModeState(next);
  }, []);

  // A scope change (e.g. switching chats) loads THAT scope's own stored
  // value — never a blanket reset to 'ask'.
  useEffect(() => {
    setModeState(readPersistedRunApprovalMode(preferenceScope));
    autoApproved.current.clear();
  }, [preferenceScope]);

  useEffect(() => {
    const pending = chat.pending;
    if (
      chat.busy ||
      // Already submitted (by this effect or a manual click on the same
      // call_id) and awaiting the poll — retrying here would just hit the
      // consumed-call guard and wrongly read as a failure below.
      chat.pendingConsumed ||
      !pending ||
      !shouldAutoApproveRunTool(mode, pending.tool, approvalInStage) ||
      autoApproved.current.has(pending.call_id)
    ) {
      return;
    }
    autoApproved.current.add(pending.call_id);
    void chat.approve(pending.call_id).then((result) => {
      if (!result.approved) {
        autoApproved.current.delete(pending.call_id);
        setMode('ask');
      }
    });
  }, [approvalInStage, chat.busy, chat.pendingConsumed, chat.pending, mode, setMode]);

  return [mode, setMode];
}
