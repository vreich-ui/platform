/**
 * CMS Agents hub (T9.17, plan §2) — cross-object conversations: the surface
 * for work not scoped to one existing object. Session list with human titles
 * and outcome chips (never raw chat ids), resume, and new-chat starters that
 * walk the §4 creation tools conversationally — dry-run-first, REUSE-FIRST,
 * results landing as normal governed objects with a one-click route to the
 * new object's workspace.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from 'astro:transitions/client';

import { useCurrentUser } from '@core/lib/admin/use-current-user';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Avatar, Badge, Button, Card, EmptyState, Skeleton, StatusPill } from './primitives';
import { Input, Select, Textarea } from './forms';
import { Dialog, useToast } from './overlays';
import { AgentChip, ChatComposer, ChatStateChip, ChatThread, useChat } from './chat';
import { RequestActivity } from './RequestActivity';
import { RunApprovalControls, useRunApprovalMode, useTestMode } from './RunApprovalControls';
import { IconExternalLink, IconFilePlus, IconPalette, IconPencil, IconPlus, IconSparkles } from './icons';
import { AGENT_STARTERS, agentStarterByKey, type AgentStarter } from '@core/lib/admin/agent-starters';
import { createdObjectsFromEvents } from '@core/lib/admin/chat-logic';
import {
  assignProfile,
  createFreeChat,
  listChats,
  listProfiles,
  upsertProfile,
  type AgentAssignmentsView,
  type AgentProfileView,
  type ChatStatus,
  type ChatSummaryView,
  type ProfileUpsertInput,
} from '@core/lib/admin/chat-client';
import { presentChatSession } from '@core/lib/admin/chat-session-presentation';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const STARTER_ICONS: Record<AgentStarter['key'], React.ReactNode> = {
  article: <IconPencil size={18} />,
  page: <IconFilePlus size={18} />,
  'section-template': <IconPlus size={18} />,
  retheme: <IconPalette size={18} />,
  media: <IconSparkles size={18} />,
};

const STATUS_TONE: Record<ChatStatus, 'success' | 'info' | 'warning' | 'neutral'> = {
  idle: 'neutral',
  queued: 'info',
  running: 'info',
  awaiting_approval: 'warning',
  awaiting_candidate: 'warning',
  error: 'warning',
  cancelled: 'neutral',
};

// ─── T9.26: agent roster & assignment (Owner manage, Admin read) ───────────

const OBJECT_TYPES = [
  'page',
  'section',
  'navigation',
  'taxonomy',
  'site',
  'template',
  'product',
  'content_item',
  'section_template',
  'theme',
];

/** Compatibility editor for the profile records that still carry per-tool
 * autonomy overrides. PF5 deliberately does not render it as a reasoning-
 * agent selector; it can move to a policy surface in a later scoped change. */
export function LegacyProfilePolicyEditor({ owner }: { owner: boolean }) {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<AgentProfileView[] | null>(null);
  const [assignments, setAssignments] = useState<AgentAssignmentsView | null>(null);
  const [editing, setEditing] = useState<ProfileUpsertInput | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const res = await listProfiles(getToken);
      setProfiles(res.profiles);
      setAssignments(res.assignments);
    } catch {
      setProfiles([]);
      setAssignments(null);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await upsertProfile(getToken, editing);
      toast({ title: 'Agent saved', tone: 'success' });
      setEditing(null);
      await reload();
    } catch (saveError) {
      toast({
        title: 'Could not save the agent',
        description: saveError instanceof Error ? saveError.message : undefined,
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  const assign = async (target: Parameters<typeof assignProfile>[1], profileId: string | null) => {
    setBusy(true);
    try {
      const res = await assignProfile(getToken, target, profileId);
      setAssignments(res.assignments);
    } catch (assignError) {
      toast({
        title: 'Assignment failed',
        description: assignError instanceof Error ? assignError.message : undefined,
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  const profileOptions = (profiles ?? [])
    .filter((profile) => profile.status === 'active')
    .map((profile) => ({ value: profile.profile_id, label: profile.name }));

  return (
    <Card
      kicker="Roster"
      title="Dedicated agents"
      actions={
        owner ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<IconPlus size={14} />}
            onClick={() => setEditing({ name: '', provider: 'anthropic', model: 'claude-opus-4-8', system_prompt: '' })}
          >
            New agent
          </Button>
        ) : undefined
      }
    >
      {profiles === null ? (
        <Skeleton variant="rect" height={80} />
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col">
            {profiles.map((profile) => (
              <li
                key={profile.profile_id}
                className="flex items-center justify-between gap-2 border-b border-[var(--adm-border)] py-2 last:border-0"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={profile.name} size={24} />
                  <span className="min-w-0">
                    <span className="block truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                      {profile.name}
                    </span>
                    <span className="block text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                      {profile.provider === 'anthropic' ? 'Claude' : 'GPT'} · {profile.model}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {profile.status === 'disabled' ? <Badge tone="warning">disabled</Badge> : null}
                  {assignments?.site_default === profile.profile_id ? <Badge tone="info">site default</Badge> : null}
                  {owner ? (
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ ...profile })}>
                      Edit
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          {owner && assignments ? (
            <details>
              <summary className="cursor-pointer text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)]">
                Assignments (site default + per-type)
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <Select
                  label="Site default"
                  value={assignments.site_default ?? ''}
                  onChange={(event) => void assign({ kind: 'site_default' }, event.target.value || null)}
                  options={[{ value: '', label: '— none —' }, ...profileOptions]}
                  disabled={busy}
                />
                {OBJECT_TYPES.map((type) => (
                  <Select
                    key={type}
                    label={type}
                    value={assignments.types[type] ?? ''}
                    onChange={(event) => void assign({ kind: 'type', object_type: type }, event.target.value || null)}
                    options={[{ value: '', label: '— inherit site default —' }, ...profileOptions]}
                    disabled={busy}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.profile_id ? `Edit ${editing.name}` : 'New agent'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={busy} disabled={!editing?.name || !editing?.model}>
              Save agent
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="flex flex-col gap-3">
            <Input
              label="Name"
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
            <Select
              label="Provider"
              value={editing.provider}
              onChange={(event) => setEditing({ ...editing, provider: event.target.value as 'anthropic' | 'openai' })}
              options={[
                { value: 'anthropic', label: 'Anthropic (Claude)' },
                { value: 'openai', label: 'OpenAI (GPT)' },
              ]}
            />
            <Input
              label="Model"
              value={editing.model}
              onChange={(event) => setEditing({ ...editing, model: event.target.value })}
              hint="e.g. claude-opus-4-8 / gpt-5 — editable data, never hardcoded."
            />
            <Textarea
              label="System prompt"
              rows={5}
              value={editing.system_prompt ?? ''}
              onChange={(event) => setEditing({ ...editing, system_prompt: event.target.value })}
              hint="Leave empty to keep the current prompt (or the house default for new agents)."
            />
            <Input
              label="Avatar artifact (optional)"
              value={editing.avatar_artifact ?? ''}
              onChange={(event) => setEditing({ ...editing, avatar_artifact: event.target.value || undefined })}
              hint="An artifact reference; upload via your profile page's avatar flow."
            />
            <Select
              label="Status"
              value={editing.status ?? 'active'}
              onChange={(event) => setEditing({ ...editing, status: event.target.value as 'active' | 'disabled' })}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'disabled', label: 'Disabled (falls through the resolution chain)' },
              ]}
            />
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}

function HubBody() {
  const [chats, setChats] = useState<ChatSummaryView[] | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return new URLSearchParams(window.location.search).get('chat') ?? undefined;
  });
  /**
   * T5.1 R5 (F5+F6): `owner` comes from the SHARED `use-current-user` module
   * store, which `AdminShell` — this component's own parent — has already
   * populated. It used to be a private `fetchMe` here, which meant
   * `admin-users {verb:'me'}` twice per mount, and `me` is a WRITE
   * (`invitations.ts` stamps `last_seen_at`, `admin-users.ts` appends an
   * audit entry), so that duplicate cost 2 blob reads AND 2 blob writes.
   */
  const currentUser = useCurrentUser();
  const owner = currentUser.roles.includes('owner') || currentUser.user?.role === 'owner';
  const [pendingStarter, setPendingStarter] = useState<string | undefined>(undefined);
  const requestedStarterHandled = useRef(false);
  const chat = useChat(getToken, activeId);

  const reloadList = async (includeAll = owner) => {
    try {
      const { chats: list } = await listChats(getToken, includeAll);
      setChats(list);
    } catch {
      setChats([]);
    }
  };

  /**
   * T5.1 R5 (F5): ONE `list_chats` per mount, scoped correctly the first
   * time. This effect used to fire `reloadList()` immediately, then await a
   * private `fetchMe`, then — for an Owner, the common case on this surface
   * — fire `reloadList(true)`, a strict SUPERSET of the first. Two full
   * chat sweeps (each `1 list() + C get()`, every get pulling a whole
   * transcript), the second serialised behind the `me` round trip, and the
   * first's result thrown away with a visible list flash.
   *
   * Waiting for the resolved role costs nothing extra: `AdminShell` already
   * has `me` in flight through the shared store, so this subscribes to a
   * request that was going out anyway rather than issuing a second one.
   */
  useEffect(() => {
    if (currentUser.loading) return;
    void reloadList(owner);
  }, [currentUser.loading, owner]);

  // Keep the list fresh while a run is live (titles/outcomes update server-side).
  useEffect(() => {
    if (chat.status === 'idle' || chat.status === 'error' || chat.status === 'cancelled') void reloadList();
  }, [chat.status]);

  const startConversation = async (starter: AgentStarter) => {
    setPendingStarter(starter.key);
    try {
      const { chat: created } = await createFreeChat(getToken, starter.label);
      setActiveId(created.chat_id);
      // Seed the conversation once the chat exists.
      const { sendChatMessage } = await import('@core/lib/admin/chat-client');
      await sendChatMessage(getToken, created.chat_id, starter.prompt);
      await reloadList();
    } finally {
      setPendingStarter(undefined);
    }
  };

  useEffect(() => {
    if (requestedStarterHandled.current) return;
    const requested = agentStarterByKey(new URLSearchParams(window.location.search).get('starter'));
    if (requested && (!requested.ownerOnly || owner) && pendingStarter === undefined) {
      requestedStarterHandled.current = true;
      void startConversation(requested);
      window.history.replaceState({}, '', '/admin/agents');
    }
  }, [owner]);

  /** Creation results carry object_id/object_type — route to the workspace. */
  const createdObjects = useMemo(() => createdObjectsFromEvents(chat.events), [chat.events]);

  const active = chats?.find((item) => item.chat_id === activeId);
  const [approvalMode, setApprovalMode] = useRunApprovalMode(chat, { preferenceScope: activeId });
  // `owner` is the same fetchMe roles check the rest of this surface uses. It
  // decides only whether the switch is OFFERED — the server re-derives roles on
  // every turn before honouring the flag.
  const [testMode, setTestMode] = useTestMode({ preferenceScope: activeId, allowed: owner });
  // Highlight-to-reference: a quoted selection from the transcript, relayed into the composer.
  const [quote, setQuote] = useState<{ token: number; text: string } | undefined>(undefined);

  return (
    <div className="grid min-h-0 gap-5 lg:h-[calc(100dvh-9rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      {/* Left: starters + session list */}
      <div className="flex min-h-0 flex-col gap-4">
        <Card kicker="Start something" title="New conversation">
          <div className="grid gap-2">
            {AGENT_STARTERS.filter((starter) => !starter.ownerOnly || owner).map((starter) => (
              <button
                key={starter.key}
                type="button"
                onClick={() => void startConversation(starter)}
                disabled={pendingStarter !== undefined}
                className="adm-focusable flex items-start gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-2.5 text-left hover:border-[var(--adm-accent)]"
              >
                <span className="mt-0.5 text-[var(--adm-accent)]">{STARTER_ICONS[starter.key]}</span>
                <span className="min-w-0">
                  <span className="block text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                    {starter.label}
                    {pendingStarter === starter.key ? '…' : ''}
                  </span>
                  <span className="block text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    {starter.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Card>

        <Card kicker="Reasoning agent" title="Client Manager">
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            Every admin conversation runs through CMS-Agent. If Client Manager is unavailable, the chat stops safely
            instead of switching to another model.
          </p>
        </Card>

        <Card
          kicker="Conversations"
          title="Recent sessions"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          bodyClassName="min-h-0 flex-1 overflow-y-auto"
        >
          {chats === null ? (
            <Skeleton variant="rect" height={120} />
          ) : chats.length === 0 ? (
            <EmptyState
              icon={<IconSparkles size={24} />}
              title="No conversations yet"
              message="Start one above, or open any object's workspace — every object has its own agent."
            />
          ) : (
            <ul className="flex flex-col">
              {chats.map((item) => (
                <li key={item.chat_id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(item.chat_id)}
                    className={`adm-focusable w-full border-b border-[var(--adm-border)] px-2 py-2.5 text-left last:border-0 hover:bg-[var(--adm-surface-sunken)] ${
                      item.chat_id === activeId ? 'bg-[var(--adm-surface-sunken)]' : ''
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                        {presentChatSession(item).title}
                      </span>
                      <StatusPill
                        status={item.status}
                        tone={STATUS_TONE[item.status]}
                        label={item.status.replaceAll('_', ' ')}
                      />
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={item.kind === 'object' ? 'info' : 'neutral'}>
                        {presentChatSession(item).kindLabel}
                      </Badge>
                      {(item.last_outcome?.chips ?? []).map((chip) => (
                        <Badge key={chip} tone="neutral">
                          {chip}
                        </Badge>
                      ))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Right: the active conversation — a fixed-height chat panel at every
          breakpoint (AgentRail's proven pattern): the thread scrolls inside
          ChatThread's own overflow container, pinned to the latest message,
          while the composer stays stationary at the bottom. */}
      <Card
        className="flex h-[calc(100dvh-9rem)] min-h-[24rem] flex-col overflow-hidden"
        bodyClassName="flex min-h-0 flex-1 flex-col"
      >
        {activeId ? (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--adm-border)] pb-3">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <AgentChip agent={chat.agent} />
                {/* D5 tier 1: the ambient state chip — always visible while
                    this chat has an active or recently-finished run. */}
                <ChatStateChip
                  status={chat.status}
                  lastOutcome={chat.lastOutcome}
                  events={chat.events}
                  lastEventAtMs={chat.lastEventAtMs}
                />
                {chat.request ? (
                  <a
                    href={`/admin/requests/${encodeURIComponent(chat.request.request_id)}`}
                    className="adm-focusable truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
                    title={chat.request.request_id}
                  >
                    on “{chat.request.title}”
                  </a>
                ) : null}
              </span>
              {active?.kind === 'object' && active.object_id ? (
                <a
                  href={`/admin/content/${encodeURIComponent(active.object_id)}?type=${encodeURIComponent(active.object_type ?? '')}`}
                  className="adm-focusable inline-flex items-center gap-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
                >
                  <IconExternalLink size={16} /> Open workspace
                </a>
              ) : null}
            </div>
            {/* W19: the live view of the job this conversation is about —
                one line until expanded, and the place an editor watches a
                23-node article being written instead of asking for an update. */}
            {chat.request ? (
              <div className="mb-3">
                <RequestActivity requestId={chat.request.request_id} />
              </div>
            ) : null}
            {createdObjects.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {createdObjects.map((created) => (
                  <Button
                    key={created.id}
                    size="sm"
                    variant="secondary"
                    leftIcon={<IconExternalLink size={14} />}
                    onClick={() =>
                      void navigate(
                        `/admin/content/${encodeURIComponent(created.id)}${created.type ? `?type=${encodeURIComponent(created.type)}` : ''}`
                      )
                    }
                  >
                    Open {created.id}
                  </Button>
                ))}
              </div>
            ) : null}
            <ChatThread
              key={activeId}
              events={chat.events}
              status={chat.status}
              pending={chat.pending}
              busy={chat.busy}
              onApprove={(editedArgs) => chat.pending && void chat.approve(chat.pending.call_id, editedArgs)}
              onDeny={(reason) => chat.pending && void chat.deny(chat.pending.call_id, reason)}
              onQuote={(text) => setQuote({ token: Date.now(), text })}
              onSendControls={(text) => void chat.send(text, undefined, testMode)}
              pendingConsumed={chat.pendingConsumed}
              lastOutcome={chat.lastOutcome}
              lastEventAtMs={chat.lastEventAtMs}
              onUndo={(prompt) => void chat.send(prompt, undefined, testMode)}
            />
            {chat.error ? (
              <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{chat.error}</p>
            ) : null}
            <div className="mt-3 border-t border-[var(--adm-border)] pt-3">
              <div className="mb-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2 py-1.5">
                <RunApprovalControls
                  mode={approvalMode}
                  onChange={setApprovalMode}
                  testMode={testMode}
                  onTestModeChange={setTestMode}
                  canUseTestMode={owner}
                />
              </div>
              <ChatComposer
                status={chat.status}
                busy={chat.busy}
                onSend={(text) => void chat.send(text, undefined, testMode)}
                onCancel={() => void chat.cancel()}
                quote={quote}
              />
            </div>
          </>
        ) : (
          <EmptyState
            icon={<IconSparkles size={26} />}
            title="CMS Agents"
            message="Pick a conversation, or use a starter — create articles, pages from templates, section recipes, or preview a retheme. Every write shows an approval card first."
          />
        )}
      </Card>
    </div>
  );
}

export interface AgentsHubProps {
  identity: SiteIdentity;
}

export default function AgentsHub({ identity }: AgentsHubProps) {
  return (
    <AdminShell currentPath="/admin/agents" title="CMS Agents" identity={identity}>
      <HubBody />
    </AdminShell>
  );
}
