import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, EmptyState, IconButton } from './primitives';
import { ChatComposer, ChatStateChip, ChatThread, type UseChatState } from './chat';
import type { ControlsActionSurface } from './ControlsCard';
import { IconChevronLeft, IconChevronRight, IconPlus, IconSparkles } from './icons';
import { RequestActivity, useRetryRequest } from './RequestActivity';
import { RunApprovalControls, useRunApprovalMode, useTestMode } from './RunApprovalControls';
import { cn } from './utils';
import { objectIdFromEvents } from '@core/lib/admin/chat-liveness';
import type { DockedChatControl } from '@core/lib/admin/docked-chat-session';
import type { ObjectSelection } from '@core/lib/admin/object-selection';
import {
  DOCK_EMPTY_HEADING,
  dockHeading,
  readPersistedDockCollapsed,
  resolveDockCollapsed,
  writePersistedDockCollapsed,
} from '@core/lib/admin/universal-dock';

export function AgentRail({
  chat,
  focus,
  agentFocus,
  suggestions,
  preferenceScope,
  aboveComposer,
  controlsActionSurface,
  belowHeader,
  contextActions,
  draftSeed,
  newChat,
  approvalInStage = false,
  canUseTestMode = false,
  isOwner = false,
  className,
  collapsed = false,
  onToggleCollapsed,
  selection,
  selectionTitle,
  onSelectionChange,
}: {
  chat: UseChatState;
  focus: string;
  agentFocus?: string;
  suggestions?: string[];
  preferenceScope?: string;
  aboveComposer?: React.ReactNode;
  /**
   * ASV2-W4.2 — the SAME row/roles/trace bundle the host hands
   * `<ObjectActionStrip>` in `aboveComposer`, passed as data rather than as a
   * node so an §6.1 `actions` card IN the transcript can dispatch through the
   * same executor. A host with no object in focus passes nothing, and §6.4
   * renders every button disabled with its reason.
   */
  controlsActionSurface?: ControlsActionSurface;
  /** Contextual sections the host surface docks above the transcript (T2.2). */
  belowHeader?: React.ReactNode;
  contextActions?: Array<{ id: string; label: string; text: string }>;
  draftSeed?: { key: string; text: string };
  /**
   * "New chat" for a surface that HOSTS its own conversation (the docked
   * rails, which mint a chat and cache its id) rather than listing chats the
   * way `AgentsHub` does. Reported defect: a conversation that broke
   * server-side stayed the only conversation that surface could ever reach,
   * because the cached id was never cleared and nothing on screen offered a
   * fresh one. The rail renders it in its header AND passes it to the
   * composer, so it is reachable both as a button and from the chat window
   * itself; `control` (`dockedChatControl`) decides the label, the disabled
   * state while minting, and the retry text after a failed mint. Optional, so
   * a surface with no conversation of its own to reset renders unchanged.
   */
  newChat?: { control: DockedChatControl; onStart: () => void };
  approvalInStage?: boolean;
  /**
   * Owner-only test mode. The rail does not resolve roles itself — the surface
   * that already holds them passes this in. Default false, so every existing
   * caller renders exactly as it did before test mode existed.
   */
  canUseTestMode?: boolean;
  /**
   * Task B (provider-error-details): whether the CURRENT viewer is an Owner —
   * the rail does not resolve roles itself, exactly like `canUseTestMode`
   * above. Gates the Owner-only provider detail line on a failed run's error
   * text, in both the transcript and the "Stopped at …" activity card.
   */
  isOwner?: boolean;
  /** Layout override for the host (T2.2 docks it sticky). Height/border stay the rail's. */
  className?: string;
  /**
   * T2.2: the object detail dock collapses to a spine. No `Resizable`
   * primitive exists in this kit (`primitives.tsx`/`overlays.tsx` have none),
   * so the dock is fixed-width with this toggle rather than drag-resizable.
   * Both default off, so every pre-existing caller renders unchanged.
   */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * ASV2-W2.1 — the UNIVERSAL DOCK's binding.
   *
   * Until W2 this rail was mounted only where exactly one object was in
   * scope, and `focus` (a sentence) was the only thing it knew about that
   * object. On a surface that LISTS objects there is no such single object:
   * what the agent is talking about is the row the editor clicked, or the one
   * `?focus=<type>:<id>` named. That is this prop.
   *
   * BACKWARD COMPATIBILITY IS A HARD REQUIREMENT: passing neither `selection`
   * nor `onSelectionChange` leaves every existing call site
   * (`ObjectWorkspace`, `VisualIdentityWorkspace`, `TemplatesWorkspace`,
   * `InventoryPage`) rendering exactly as it does today — `selectionBound`
   * below is the single switch, and it is false for all four.
   */
  selection?: ObjectSelection;
  /**
   * The host's own row label for `selection`. The selection itself carries
   * only the pair (W0 keeps it wire-shaped), and a selection restored from
   * the address may name an object whose row this surface never loaded, so
   * this is optional and the id is the fallback.
   */
  selectionTitle?: string;
  /**
   * How the rail hands a selection change BACK to its host — today only to
   * clear it ("Clear" in the header), which is the one selection gesture the
   * rail itself owns; the rows own the rest. Passing it is also what puts the
   * rail in selection-bound mode when nothing is selected yet, so the header
   * can say "Select an object" instead of nothing.
   */
  onSelectionChange?: (next: ObjectSelection | undefined) => void;
}) {
  const [approvalMode, setApprovalMode] = useRunApprovalMode(chat, { preferenceScope, approvalInStage });
  /** B2: the run card's Retry, wired the same way on all four surfaces. */
  const retryRun = useRetryRequest();
  const [testMode, setTestMode] = useTestMode({ preferenceScope, allowed: canUseTestMode });
  // Highlight-to-reference: a quoted selection from the transcript, relayed into the composer.
  const [quote, setQuote] = useState<{ token: number; text: string } | undefined>(undefined);
  /**
   * FIX 6 — the rail mounts a run card too, and never told its thread. A2's
   * `RunProgress` suppression and A4's `request_progress` suppression had
   * been applied on the hub only, so this surface still stated the same run
   * twice. Same semantics as the hub: this is "the card is stating the
   * status right now", not "a request is bound" (FIX 5).
   */
  const [runCardStatesStatus, setRunCardStatesStatus] = useState(false);
  /**
   * FIX 2 — the object this run has produced. Not a hook, so it is safe here;
   * held above the collapsed-rail early return with everything else all the
   * same. See the `objectId` prop below for why the events, not the binding.
   */
  const railObjectId = chat.request?.object_id ?? objectIdFromEvents(chat.events);
  /**
   * W2.1 — the ONE switch between the rail this file has always been and the
   * universal dock. False for every call site that passes neither new prop,
   * which is all four pre-existing ones. Not a hook, so it is safe here.
   */
  const selectionBound = selection !== undefined || onSelectionChange !== undefined;
  const heading = dockHeading(selection, selectionTitle);

  const collapsedTone =
    chat.status === 'awaiting_approval' || chat.status === 'awaiting_candidate'
      ? { label: 'The agent is waiting for you', className: 'bg-[var(--adm-warning)]' }
      : chat.status === 'queued' || chat.status === 'running'
        ? { label: 'The agent is working', className: 'animate-pulse bg-[var(--adm-info)]' }
        : chat.status === 'error'
          ? { label: 'The last run failed', className: 'bg-[var(--adm-danger)]' }
          : undefined;

  if (collapsed) {
    return (
      <section
        className={cn(
          'flex h-[calc(100dvh-8rem)] min-h-[30rem] w-12 flex-col items-center gap-3 border-l border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] py-3',
          className
        )}
        aria-label="Publishing Agent (collapsed)"
      >
        <IconButton
          label="Expand the agent dock"
          title="Expand the agent dock"
          onClick={onToggleCollapsed}
          size="sm"
          icon={<IconChevronLeft size={16} />}
        />
        <IconSparkles size={16} className="text-[var(--adm-text-muted)]" />
        {/* The ambient tier survives collapse as a dot — the full
            `<ChatStateChip>` needs more width than a spine has. Amber =
            waiting on the editor (a held gate is never red, W19); blue =
            running; red = the run failed. */}
        {collapsedTone ? (
          <span
            aria-label={collapsedTone.label}
            title={collapsedTone.label}
            role="status"
            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', collapsedTone.className)}
          />
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={cn(
        'flex h-[calc(100dvh-8rem)] min-h-[30rem] min-w-0 flex-col border-l border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] pl-4',
        className
      )}
      aria-label="Publishing Agent"
    >
      <header className="shrink-0 border-b border-[var(--adm-border)] pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[length:var(--adm-text-sm)] font-semibold text-[var(--adm-text-heading)]">
            Publishing Agent
          </h2>
          {/* D5 tier 1: the ambient state chip — always visible while this
              chat has an active or recently-finished run. */}
          <div className="flex items-center gap-1.5">
            <ChatStateChip
              status={chat.status}
              lastOutcome={chat.lastOutcome}
              events={chat.events}
              lastEventAtMs={chat.lastEventAtMs}
            />
            {newChat ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={newChat.onStart}
                disabled={newChat.control.disabled}
                aria-label={newChat.control.hint}
                leftIcon={<IconPlus size={14} />}
              >
                {newChat.control.label}
              </Button>
            ) : null}
            {onToggleCollapsed ? (
              <IconButton
                label="Collapse the agent dock"
                title="Collapse the agent dock"
                onClick={onToggleCollapsed}
                size="sm"
                icon={<IconChevronRight size={16} />}
              />
            ) : null}
          </div>
        </div>
        {/* W2.1: bound to a SELECTION, the header states the object — title
            plus a type pill — rather than the `focus` sentence a
            single-object surface supplies. With nothing selected it states
            the instruction, because on a listing surface that IS the state. */}
        {selectionBound ? (
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {heading.typeLabel ? <Badge>{heading.typeLabel}</Badge> : null}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[length:var(--adm-text-sm)]',
                heading.empty ? 'text-[var(--adm-text-muted)]' : 'font-medium text-[var(--adm-text-heading)]'
              )}
              {...(heading.empty ? {} : { title: heading.title })}
            >
              {heading.title}
            </span>
            {onSelectionChange && !heading.empty ? (
              <button
                type="button"
                onClick={() => onSelectionChange(undefined)}
                className="adm-focusable shrink-0 rounded px-1.5 py-0.5 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : (
          <p className="mt-0.5 truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            Working on {focus}
          </p>
        )}
        {/* A failed mint must never be a silent `undefined` chat: the reason
            stays on screen next to the control that retries it. */}
        {newChat?.control.error ? (
          <p role="alert" className="mt-1 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">
            {newChat.control.error}
          </p>
        ) : null}
      </header>
      {/* W2.1 — nothing selected is a real state on a listing surface, and
          the empty state IS the instruction. The transcript and the composer
          are not rendered at all here: there is no object to bind a turn to,
          and a composer that accepted text would have to either refuse it or
          mint an unbound conversation. */}
      {selectionBound && heading.empty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <EmptyState
            icon={<IconSparkles size={26} />}
            title={DOCK_EMPTY_HEADING}
            message="Pick a row and the agent works on that object. Nothing is sent — and no conversation is started — until you write the first message."
          />
        </div>
      ) : (
        <>
          {belowHeader ? <div className="shrink-0 pt-3">{belowHeader}</div> : null}
          {/* W19: what the job is doing, above the transcript. Collapsed to one
          live line until the editor asks for the detail. */}
          {chat.request ? (
            <div className="shrink-0 pt-3">
              <RequestActivity
                requestId={chat.request.request_id}
                isOwner={isOwner}
                {...(chat.status ? { chatStatus: chat.status } : {})}
                onStatesStatusChange={setRunCardStatesStatus}
                onRetry={() => void retryRun(chat.request!.request_id)}
                // E3b/FIX 2: the binding's `object_id` when the client happens to
                // hold one, else the newest `request_progress` event that names it
                // — the binding is sent on the first poll only and latched, and
                // the object is recorded long after that, so mid-run the events
                // are the only place this fact arrives. Absent = not recorded yet.
                {...(railObjectId ? { objectId: railObjectId } : {})}
              />
            </div>
          ) : null}
          <ChatThread
            events={chat.events}
            status={chat.status}
            pending={chat.pending}
            candidateSet={chat.candidateSet}
            {...(chat.blockage ? { blockage: chat.blockage } : {})}
            onResolveBlockage={(remedyId, args) => void chat.resolveBlockage(remedyId, args)}
            previewCandidateId={chat.previewCandidate?.candidate_id}
            busy={chat.busy}
            onApprove={(editedArgs) => chat.pending && void chat.approve(chat.pending.call_id, editedArgs)}
            onReject={(reason) => chat.pending && void chat.deny(chat.pending.call_id, reason)}
            onPreviewCandidate={(candidateId) => chat.preview(candidateId)}
            onChooseCandidate={(candidateId) => void chat.chooseCandidate(candidateId)}
            onRejectCandidates={(reason) => void chat.rejectCandidates(reason)}
            onQuote={(text) => setQuote({ token: Date.now(), text })}
            onSendControls={(text) => void chat.send(text, undefined, testMode)}
            {...(controlsActionSurface ? { controlsActionSurface } : {})}
            preferenceScope={preferenceScope}
            approvalInStage={approvalInStage}
            pendingConsumed={chat.pendingConsumed}
            lastOutcome={chat.lastOutcome}
            lastEventAtMs={chat.lastEventAtMs}
            onUndo={(prompt) => void chat.send(prompt)}
            isOwner={isOwner}
            hasRunCard={runCardStatesStatus}
            emptyHint={
              <EmptyState
                title="Ready when you are"
                message="Describe an outcome. The agent can inspect this object and propose a governed change."
              />
            }
          />
          {chat.error ? (
            <p className="shrink-0 py-2 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{chat.error}</p>
          ) : null}
          <div className="shrink-0 border-t border-[var(--adm-border)] pt-3">
            <ChatComposer
              status={chat.status}
              busy={chat.busy}
              onSend={(text) => void chat.send(text, agentFocus ?? focus, testMode)}
              onCancel={() => void chat.cancel()}
              suggestions={suggestions}
              contextActions={contextActions}
              draftSeed={draftSeed}
              // FIX: `newChat` is intentionally NOT forwarded to the composer
              // here — the header above already renders it (`Button` next to
              // the state chip), and that stays the one place this rail offers
              // it. Forwarding it too was the second half of a row that, once
              // the starter-suggestion chips were dropped, had nothing left in
              // it but this one chip. `ChatComposer` still accepts `newChat` on
              // its own (compactly, no full-width row) for a caller that hosts
              // it with no header of its own — none does today, but the prop
              // stays so that case isn't a silent dead end.
              quote={quote}
              above={aboveComposer}
              // FIX: moved out of a bordered `mb-2` row above the composer and
              // into its `runMode` slot (bottom-left of the input row) — the
              // placement `RunApprovalControls`' own doc comment already
              // describes ("A5 ... rather than a full-width row above it") and
              // that `AgentsHub` already uses. The rail just hadn't caught up:
              // it alone still spent a full boxed row on the autonomy controls.
              runMode={
                <RunApprovalControls
                  mode={approvalMode}
                  onChange={setApprovalMode}
                  testMode={testMode}
                  onTestModeChange={setTestMode}
                  canUseTestMode={canUseTestMode}
                />
              }
            />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * ASV2-W2.1 — the collapsed-state half of the dock, for a host that binds the
 * rail to a selection.
 *
 * It deliberately does NOT live inside `AgentRail`. `collapsed` /
 * `onToggleCollapsed` are controlled props and four call sites already drive
 * them from their own state; persisting from inside the component would have
 * changed what those four do, which W2.1 forbids. So this extends that same
 * path rather than adding a second one: the host still passes `collapsed` and
 * `onToggleCollapsed`, and this hook is where the value comes from.
 *
 * Two rules, both decided in `universal-dock.ts` and tested there:
 *  - with no selection the dock is a spine, whatever the toggle last said;
 *  - the stored preference is keyed by the SAME `preferenceScope` string the
 *    rail already threads to `useRunApprovalMode` / `useTestMode`, so a
 *    surface has one scope mechanism, not two.
 */
export function useAgentDock(
  selection: ObjectSelection | undefined,
  preferenceScope: string
): { collapsed: boolean; toggle: () => void } {
  const [userCollapsed, setUserCollapsed] = useState(false);

  // A scope change (a different selection, or a different viewer) loads THAT
  // scope's own stored value — never a blanket reset, the `useTestMode`
  // convention. An unstored scope falls back to open, which is what makes the
  // first selection open the dock.
  useEffect(() => {
    setUserCollapsed(readPersistedDockCollapsed(preferenceScope) ?? false);
  }, [preferenceScope]);

  const toggle = useCallback(() => {
    setUserCollapsed((current) => {
      const next = !current;
      writePersistedDockCollapsed(preferenceScope, next);
      return next;
    });
  }, [preferenceScope]);

  return { collapsed: resolveDockCollapsed({ selection, userCollapsed }), toggle };
}
