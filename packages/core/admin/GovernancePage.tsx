/**
 * GovernancePage (T9.15) — the adjustable guardrails page. Owner-write,
 * Admin-read. The approval-policy matrix is a RUNTIME override over the
 * committed one-file lever; the committed config is the labeled default and
 * one-click revert restores it. Creation policy and chat-tool autonomy are
 * shown with provenance; chat-tool autonomy activates with the chat loop
 * (T9.13).
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { Select, Switch } from './forms';
import { useToast } from './overlays';
import { IconAlertTriangle } from './icons';
import { exportPreferences, listProfiles, type AgentProfileView } from '@core/lib/admin/chat-client';
import { toolLabelForName } from '@core/lib/admin/chat-logic';
import { objectTypeLabel } from '@core/lib/admin/display-name';
import { governedObjectTypes } from '@core/lib/approval-policy';
import type { ObjectType } from '@core/schema/object-record-v1';
import {
  fetchGovernance,
  setApprovalOverride,
  setChatToolsOverride,
  setLearningMode,
  revertGovernance,
  effectiveApprovalMode,
  type GovernanceState,
  type ApprovalConfig,
  type ApprovalMode,
  type ChatToolCatalogEntry,
  type ToolAutonomy,
} from '@core/lib/admin/governance-client';
import {
  describeTrackingGovernance,
  withTrackingPublishMode,
  type CreationPolicyLike,
} from '@core/lib/admin/tracking-governance';
import {
  AUTONOMY_LABELS,
  autonomyEffect,
  governanceProvenanceLabel,
  toolGroupLabel,
} from '@core/lib/admin/governance-presentation';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const sameConfig = (a: ApprovalConfig, b: ApprovalConfig) => JSON.stringify(a) === JSON.stringify(b);

function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="mt-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] px-3 py-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
      <summary className="cursor-pointer font-medium text-[var(--adm-text)]">Technical</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function GovernanceBody({ identity }: { identity: SiteIdentity }) {
  const { toast } = useToast();
  const [gov, setGov] = useState<GovernanceState | null>(null);
  const [owner, setOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ApprovalConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfileView[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  const refresh = async () => {
    const state = await fetchGovernance(getToken);
    setGov(state);
    setDraft(JSON.parse(JSON.stringify(state.active.approval)) as ApprovalConfig);
  };

  useEffect(() => {
    (async () => {
      try {
        const { fetchMe } = await import('@core/lib/admin/users-client');
        const [me, profileResult] = await Promise.all([
          fetchMe(getToken),
          listProfiles(getToken).catch(() => undefined),
        ]);
        setOwner(me.roles.includes('owner'));
        setProfiles(profileResult?.profiles ?? []);
        setProfilesLoaded(Boolean(profileResult));
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load guardrails.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const dirty = useMemo(() => Boolean(gov && draft && !sameConfig(draft, gov.active.approval)), [gov, draft]);

  const setTypeMode = (type: ObjectType, value: 'default' | ApprovalMode) => {
    if (!draft) return;
    const overrides = { ...draft.overrides };
    if (value === 'default') delete overrides[type];
    else overrides[type] = value;
    setDraft({ ...draft, overrides });
  };

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await setApprovalOverride(getToken, draft);
      await refresh();
      toast({ title: 'Guardrails updated', tone: 'success' });
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const onRevert = async () => {
    setSaving(true);
    try {
      await revertGovernance(getToken, 'approval');
      await refresh();
      toast({ title: 'Reverted to the committed default', tone: 'success' });
    } catch (err) {
      toast({ title: 'Revert failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Skeleton variant="rect" height={360} />;
  if (error || !gov || !draft) {
    return (
      <Card>
        <EmptyState
          icon={<IconAlertTriangle size={26} />}
          title="Couldn't load guardrails"
          message={error ?? undefined}
        />
      </Card>
    );
  }

  const overridden = gov.active.provenance.approval === 'override';

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <TrackingGovernanceCard gov={gov} owner={owner} onSaved={refresh} identity={identity} />

      <Card kicker="Effective policy" title="How these settings work together">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          A conversation first follows its assigned agent&rsquo;s setting, then a setting changed here, then the
          standard setting. Changes apply to new runs; a run already in progress keeps the policy it started with.
        </p>
        <TechnicalDetails>
          <p>Precedence: agent profile override → governance chat-tools override → class default.</p>
        </TechnicalDetails>
      </Card>

      <Card
        kicker="Approval policy"
        title="Who approves publishes"
        actions={
          <Badge tone={overridden ? 'accent' : 'neutral'}>
            {governanceProvenanceLabel(gov.active.provenance.approval)}
          </Badge>
        }
      >
        <p className="mb-4 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Decide whether agents can publish when work is ready or must ask a person first. This changes the default for
          each type below unless that type has its own setting.
        </p>

        <div className="mb-4 max-w-xs">
          <Select
            label="Default for everything"
            hint="Changing this sets the publishing rule for types that do not have their own setting."
            value={draft.master}
            disabled={!owner}
            onChange={(e) => setDraft({ ...draft, master: e.target.value as ApprovalConfig['master'] })}
            options={[
              { value: 'all-autonomous', label: 'Let agents publish when ready' },
              { value: 'all-require-approval', label: 'Ask before every publish' },
            ]}
          />
        </div>

        <div className="overflow-hidden rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)]">
          {governedObjectTypes.map((type) => {
            const override = draft.overrides[type];
            const effective = effectiveApprovalMode(draft, type);
            return (
              <div
                key={type}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--adm-border)] px-4 py-2.5 last:border-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                      {objectTypeLabel(type)}
                    </span>
                    <Badge tone={effective === 'require-approval' ? 'warning' : 'success'}>
                      {effective === 'require-approval' ? 'Ask before publishing' : 'Publish when ready'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    {effective === 'require-approval'
                      ? 'A person reviews this before it can be published.'
                      : 'The agent can publish this once the usual checks pass.'}
                  </p>
                </div>
                <div className="w-52">
                  <Select
                    aria-label={`Approval policy for ${objectTypeLabel(type)}`}
                    value={override ?? 'default'}
                    disabled={!owner}
                    onChange={(e) => setTypeMode(type, e.target.value as 'default' | ApprovalMode)}
                    options={[
                      { value: 'default', label: 'Use default for everything' },
                      { value: 'autonomous', label: 'Publish when ready' },
                      { value: 'require-approval', label: 'Ask before publishing' },
                    ]}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <TechnicalDetails>
          <p>
            Policy key: approval. Stored values: all-autonomous, all-require-approval, autonomous, require-approval.
          </p>
        </TechnicalDetails>

        {owner ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={onSave} loading={saving} disabled={!dirty || saving}>
              Save changes
            </Button>
            <Button variant="secondary" onClick={onRevert} disabled={saving || !overridden}>
              Revert to site default
            </Button>
          </div>
        ) : (
          <p className="mt-4 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            Only Owners can change guardrails.
          </p>
        )}
      </Card>

      <Card
        kicker="Creation policy"
        title="Who can create each type"
        actions={
          <Badge tone={gov.active.provenance.creation === 'override' ? 'accent' : 'neutral'}>
            {governanceProvenanceLabel(gov.active.provenance.creation)}
          </Badge>
        }
      >
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          People can always create. The active site policy decides which agents may create each type. This screen shows
          that policy read-only so the visible rule and server enforcement stay aligned.
        </p>
        <TechnicalDetails>
          <p>Policy key: creation.</p>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(gov.active.creation, null, 2)}</pre>
        </TechnicalDetails>
      </Card>

      <ChatToolAutonomyCard
        catalog={gov.chat_tools_catalog ?? []}
        current={gov.doc?.chat_tools ?? {}}
        profiles={profiles}
        profilesLoaded={profilesLoaded}
        owner={owner}
        onSaved={refresh}
      />
      <LearningModeCard gov={gov} owner={owner} onSaved={refresh} />
    </div>
  );
}

function LearningModeCard({
  gov,
  owner,
  onSaved,
}: {
  gov: GovernanceState;
  owner: boolean;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(gov.active.learning_mode);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const active = gov.active.learning_mode;
  const overridden = gov.active.provenance.learning_mode === 'override';

  useEffect(() => setDraft(active), [active]);

  const save = async () => {
    setSaving(true);
    try {
      await setLearningMode(getToken, draft);
      await onSaved();
      toast({ title: draft ? 'Learning mode enabled' : 'Learning mode disabled', tone: 'success' });
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const revert = async () => {
    setSaving(true);
    try {
      await revertGovernance(getToken, 'learning_mode');
      await onSaved();
      toast({ title: 'Learning mode restored to its site default', tone: 'success' });
    } catch (err) {
      toast({ title: 'Revert failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const downloadPreferences = async () => {
    setExporting(true);
    try {
      const result = await exportPreferences(getToken);
      const blob = new Blob([result.jsonl], { type: 'application/x-ndjson;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cms-agent-preferences-${new Date().toISOString().slice(0, 10)}.jsonl`;
      link.click();
      URL.revokeObjectURL(url);
      toast({
        title: `${result.count} preference pair${result.count === 1 ? '' : 's'} exported`,
        description: `${result.candidate_events} candidate choices · ${result.manual_edits} manual edits · ${result.hard_negatives} hard negatives retained`,
        tone: 'success',
      });
    } catch (err) {
      toast({ title: 'Export failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      kicker="Learning"
      title="Candidate learning mode"
      actions={<Badge tone={active ? 'accent' : 'neutral'}>{active ? 'On' : 'Off'}</Badge>}
    >
      <Switch
        checked={draft}
        onCheckedChange={setDraft}
        disabled={!owner || saving}
        label="Offer 2–3 versions for substantive writing decisions"
        hint="Choices and later corrections become Owner-readable preference evidence. Lookups and mechanical changes remain single-version. Candidate generation costs more, so this is disabled by default."
      />
      {owner ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={save} loading={saving} disabled={saving || draft === active}>
            Save setting
          </Button>
          <Button variant="secondary" onClick={revert} disabled={saving || !overridden}>
            Restore disabled setting
          </Button>
          <Button variant="secondary" onClick={downloadPreferences} loading={exporting} disabled={saving || exporting}>
            Export preference pairs
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Only Owners can change learning mode.
        </p>
      )}
    </Card>
  );
}

// ─── tracking governance card (W13 T13.12 — the OQ-W13-2 surface) ──────────

function TrackingGovernanceCard({
  gov,
  owner,
  onSaved,
  identity,
}: {
  gov: GovernanceState;
  owner: boolean;
  onSaved: () => Promise<void>;
  identity: SiteIdentity;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const view = describeTrackingGovernance(
    gov.active.approval,
    gov.active.provenance.approval,
    gov.active.creation as CreationPolicyLike,
    gov.active.provenance.creation
  );

  const flipTo = async (mode: ApprovalMode) => {
    setSaving(true);
    try {
      // An explicit per-type pin through the SAME audit-logged override the
      // matrix below edits — never a silent master change.
      await setApprovalOverride(getToken, withTrackingPublishMode(gov.active.approval, mode));
      await onSaved();
      toast({
        title: mode === 'autonomous' ? 'Tracker changes can publish when ready' : 'Tracker changes now ask first',
        tone: 'success',
      });
    } catch (err) {
      toast({ title: 'Flip failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      kicker="Tracking"
      title="Who controls the tracker registry"
      actions={
        <Badge tone={view.approvalProvenance === 'override' ? 'accent' : 'neutral'}>
          {governanceProvenanceLabel(view.approvalProvenance)}
        </Badge>
      }
    >
      <p className="mb-4 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Publishing tracker changes affects which third-party scripts run on every page. This card shows who may publish
        them now; the full publishing policy is below.
      </p>

      <div className="overflow-hidden rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)]">
        {view.rows.map((row) => (
          <div
            key={row.type}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--adm-border)] px-4 py-2.5 last:border-0"
          >
            <div className="flex items-center gap-2">
              <span className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">{row.label}</span>
              <Badge tone={row.publish === 'require-approval' ? 'warning' : 'success'}>
                {row.publish === 'require-approval' ? 'Ask before publishing' : 'Publish when ready'}
              </Badge>
              {row.pinned && <Badge tone="neutral">Special rule</Badge>}
            </div>
            {row.type === 'tracking_config' && owner && (
              <Button
                variant="secondary"
                loading={saving}
                disabled={saving}
                onClick={() => flipTo(row.publish === 'autonomous' ? 'require-approval' : 'autonomous')}
              >
                {row.publish === 'autonomous' ? 'Ask before publishing' : 'Allow agent publishing'}
              </Button>
            )}
          </div>
        ))}
      </div>

      <p className="mt-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        Creation: people can always create;{' '}
        {view.creation.agents === 'open'
          ? 'agents may create this type'
          : view.creation.agents.length === 0
            ? 'agents may not create it'
            : `only ${view.creation.agents.join(', ')} may create it`}
        . Editing the record itself happens in the normal object workspace.
      </p>

      <TechnicalDetails>
        <p>Tracker registry project: {identity.trackingProjectId}</p>
        <p>Creation policy source: {view.creation.creationProvenance}.</p>
      </TechnicalDetails>

      {!owner && (
        <p className="mt-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Only Owners can flip the posture.
        </p>
      )}
    </Card>
  );
}

// ─── chat tool autonomy table (T9.13 chat_tools override) ────────────────────────

const AUTONOMY_TONE: Record<ToolAutonomy, 'success' | 'warning' | 'neutral'> = {
  auto: 'success',
  ask: 'warning',
  off: 'neutral',
};
const TOOL_CLASS_ORDER: ChatToolCatalogEntry['tool_class'][] = [
  'read',
  'draft',
  'creation',
  'publication',
  'privileged',
  'membership',
];
const sameOverride = (a: Record<string, ToolAutonomy>, b: Record<string, ToolAutonomy>) =>
  JSON.stringify(a) === JSON.stringify(b);

function ChatToolAutonomyCard({
  catalog,
  current,
  profiles,
  profilesLoaded,
  owner,
  onSaved,
}: {
  catalog: ChatToolCatalogEntry[];
  current: Record<string, ToolAutonomy>;
  profiles: AgentProfileView[];
  profilesLoaded: boolean;
  owner: boolean;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Record<string, ToolAutonomy>>(current);
  const [saving, setSaving] = useState(false);

  // Re-sync the local draft whenever the persisted override changes (the parent
  // refreshes `current` after a save/revert; keying on the serialized map
  // leaves in-progress edits untouched while nothing has been persisted).
  const currentKey = JSON.stringify(current);
  useEffect(() => {
    setDraft(JSON.parse(currentKey) as Record<string, ToolAutonomy>);
  }, [currentKey]);

  const dirty = useMemo(() => !sameOverride(draft, current), [draft, current]);
  const overridden = Object.keys(current).length > 0;

  const setToolMode = (name: string, value: 'default' | ToolAutonomy) => {
    const next = { ...draft };
    if (value === 'default') delete next[name];
    else next[name] = value;
    setDraft(next);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await setChatToolsOverride(getToken, draft);
      await onSaved();
      toast({ title: 'Agent tool settings updated', tone: 'success' });
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const onRevert = async () => {
    setSaving(true);
    try {
      await revertGovernance(getToken, 'chat_tools');
      await onSaved();
      toast({ title: 'Returned to the standard settings', tone: 'success' });
    } catch (err) {
      toast({ title: 'Revert failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const grouped = TOOL_CLASS_ORDER.map((cls) => ({
    cls,
    tools: catalog.filter((tool) => tool.tool_class === cls),
  })).filter((group) => group.tools.length > 0);

  return (
    <Card
      kicker="Agent permissions"
      title="How the agent uses tools"
      actions={
        <Badge tone={overridden ? 'accent' : 'neutral'}>{overridden ? 'Changed here' : 'Standard settings'}</Badge>
      }
    >
      <p className="mb-4 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        Choose how much freedom the agent has in new conversations. Some agents may carry a more specific setting; when
        they do, that setting takes priority and is called out below.
      </p>

      {!profilesLoaded ? (
        <p
          role="alert"
          className="mb-4 rounded-[var(--adm-radius-md)] border border-[var(--adm-warning)] bg-[var(--adm-warning-soft)] px-3 py-2 text-[length:var(--adm-text-sm)] text-[var(--adm-warning-text)]"
        >
          Agent-specific settings could not be loaded, so this page cannot confirm the final policy.{' '}
          <a href="/admin/agents" className="adm-focusable font-medium underline">
            Check agents
          </a>
          .
        </p>
      ) : null}

      {catalog.length === 0 ? (
        <EmptyState
          icon={<IconAlertTriangle size={22} />}
          title="No chat tools"
          message="The tool catalog came back empty."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map((group) => (
            <div key={group.cls}>
              <p className="mb-1 px-1 text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
                {toolGroupLabel(group.cls)}
              </p>
              {group.cls === 'membership' ? (
                <p className="mb-2 px-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                  Inviting, changing roles, suspending and removing members from chat. Only the signed-in human&apos;s
                  own authority applies (Owner for everything except inviting editors/viewers) and every change is
                  audited. The writes always ask first — that floor is built in and cannot be lowered here or per agent.
                  Off by default so the chat tool list stays small; switch on the ones you use.
                </p>
              ) : null}
              <div className="overflow-hidden rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)]">
                {group.tools.map((tool) => {
                  const effective = draft[tool.name] ?? tool.default;
                  const profileOverrides = profiles.filter(
                    (profile) => profile.status === 'active' && profile.tool_autonomy_overrides?.[tool.name]
                  );
                  return (
                    <div
                      key={tool.name}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--adm-border)] px-4 py-2.5 last:border-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
                            {toolLabelForName(tool.name)}
                          </span>
                          <Badge tone={AUTONOMY_TONE[effective]}>{AUTONOMY_LABELS[effective]}</Badge>
                        </div>
                        <p className="mt-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                          {autonomyEffect(effective)}
                        </p>
                        {profileOverrides.map((profile) => {
                          const profileMode = profile.tool_autonomy_overrides![tool.name]!;
                          return (
                            <p
                              key={profile.profile_id}
                              role="alert"
                              className="mt-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-warning)] bg-[var(--adm-warning-soft)] px-2 py-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-warning-text)]"
                            >
                              <strong>{profile.name}</strong> is set to {AUTONOMY_LABELS[profileMode]}. When this agent
                              is selected, its setting takes priority over this page.{' '}
                              <a href="/admin/agents" className="adm-focusable font-medium underline">
                                View agents
                              </a>
                            </p>
                          );
                        })}
                        <TechnicalDetails>
                          <p>Tool name: {tool.name}</p>
                          <p>Stored values: auto, ask, off.</p>
                          <p>{tool.description}</p>
                        </TechnicalDetails>
                      </div>
                      <div className="w-56">
                        <Select
                          aria-label={`Permission for ${toolLabelForName(tool.name)}`}
                          value={draft[tool.name] ?? 'default'}
                          disabled={!owner}
                          onChange={(e) => setToolMode(tool.name, e.target.value as 'default' | ToolAutonomy)}
                          options={[
                            { value: 'default', label: `Use standard setting (${AUTONOMY_LABELS[tool.default]})` },
                            ...(tool.autonomy_floor === 'ask'
                              ? [{ value: 'auto', label: 'Run automatically — locked: always asks first' }]
                              : [{ value: 'auto', label: 'Run automatically' }]),
                            { value: 'ask', label: 'Ask me first' },
                            { value: 'off', label: 'Not allowed' },
                          ]}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        Site-wide changes still require an Owner when they run. This screen cannot remove that protection.
      </p>

      <TechnicalDetails>
        <p>Site-wide theme changes require the Owner role at execution, independent of the stored setting above.</p>
      </TechnicalDetails>

      {owner ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={onSave} loading={saving} disabled={!dirty || saving}>
            Save changes
          </Button>
          <Button variant="secondary" onClick={onRevert} disabled={saving || !overridden}>
            Return to standard settings
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Only Owners can change agent permissions.
        </p>
      )}
    </Card>
  );
}

export interface GovernancePageProps {
  identity: SiteIdentity;
}

export default function GovernancePage({ identity }: GovernancePageProps) {
  return (
    <AdminShell currentPath="/admin/settings/guardrails" title="Guardrails" identity={identity}>
      <GovernanceBody identity={identity} />
    </AdminShell>
  );
}
