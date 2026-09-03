/**
 * Publishing-plugin client (W5.1) — wrappers over admin-plugin-manifest, plus
 * the presentation logic the page needs.
 *
 * Everything a test can assert lives HERE rather than in the page component:
 * `packages/core/admin/**\/*.tsx` is excluded from the test compile, so logic
 * that matters must sit in a module `node --test` can import. The page is a
 * thin renderer over this file.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';

const ENDPOINT = '/.netlify/functions/admin-plugin-manifest';

export type PluginPlatformId = 'claude' | 'openai' | 'gemini';

export interface ManifestToolRow {
  name: string;
  tool_class: string;
  consequential: boolean;
  autonomy_floor?: 'ask';
  summary: string;
}

export interface ManifestBundleView {
  manifest_version: string;
  rendered_at: string;
  tools: ManifestToolRow[];
  connection: {
    tenant: string;
    site_id: string;
    origin: string;
    mcp_url: string;
    mcp_auth_health_url: string;
    oauth: Record<string, string>;
    openapi_url?: string;
  };
  sources: {
    voice_object_id: string | null;
    voice_record_version: number | null;
    aggression_ceiling: Record<string, number>;
    approval_posture: string;
    tool_surface_digest: string;
  };
  warnings: string[];
}

export interface PluginManifestState {
  active: ManifestBundleView | null;
  draft: ManifestBundleView | null;
  stale: string[];
  updated_by: string;
  updated_at: string;
  history: Array<{ at: string; actor_email: string; action: string; manifest_version?: string; detail?: string }>;
  exports: Record<string, string> | null;
}

const request = async <T>(getToken: GetToken, init: RequestInit & { query?: string } = {}): Promise<T> => {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}${init.query ?? ''}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `Request failed (${response.status})`));
  /**
   * A DOMAIN failure now answers HTTP 200 with {ok:false, stage, error} rather
   * than dying and letting Netlify return a bare 502 (the state /admin/plugins
   * was stuck in). `response.ok` is therefore no longer the whole test — without
   * this check a stage failure would sail through as a success and the page
   * would render an empty manifest instead of saying what broke.
   *
   * The stage rides in the message because that is what the page displays;
   * naming the step is the difference between "unavailable" and "the render
   * step threw, here is what it said".
   */
  if (body.ok === false) {
    const detail = String(body.error ?? 'The request failed.');
    const stage = typeof body.stage === 'string' ? body.stage : '';
    throw new Error(stage ? `${detail} (failed at: ${stage})` : detail);
  }
  return body as T;
};

export const fetchPluginManifest = (getToken: GetToken): Promise<PluginManifestState> =>
  request<PluginManifestState>(getToken);

export const renderPluginDraft = (getToken: GetToken, platform: PluginPlatformId) =>
  request<{ draft: ManifestBundleView; warnings: string[] }>(getToken, {
    method: 'POST',
    body: JSON.stringify({ action: 'render', platform }),
  });

export const promotePluginDraft = (getToken: GetToken) =>
  request<{ active: ManifestBundleView }>(getToken, { method: 'POST', body: JSON.stringify({ action: 'promote' }) });

/* ── presentation ─────────────────────────────────────────────────────────── */

export interface PlatformCard {
  id: PluginPlatformId;
  title: string;
  /** Ledger actor(s) this platform's shapes declare. Empty when it cannot publish. */
  actors: string[];
  /** What the operator downloads, or null when this platform has no artifact. */
  downloadUrl: string | null;
  downloadLabel: string;
  /** A URL the operator copies rather than downloads (the connector / schema). */
  copyUrl: string | null;
  copyLabel: string | null;
  steps: string[];
  /** Set when the platform is deliberately not fully capable — shown as a caveat. */
  limitation: string | null;
}

const exportUrl = (kind: string) => `${ENDPOINT}?export=${kind}`;

/**
 * The step that comes before every platform, on every install.
 *
 * Both OpenAI shapes and the Claude connector authenticate the HUMAN to this
 * tenant over OAuth (Netlify Identity). An installer with no account on the
 * tenant can attach the tools successfully and then fail every single write —
 * a failure that looks like a broken connector and is actually a missing
 * invitation. So the invite is step one of the card, not a footnote under it.
 */
export const installerIdentityStep = {
  title: 'Invite the installer first',
  detail:
    'Every shape authenticates the person to this tenant over OAuth. Invite them as publisher or editor before sending the bundle — an installer with no account here can attach the tools and then fail every write.',
  action: { label: 'Invite a member', href: '/admin/settings/admins' },
  roles: ['publisher', 'editor'] as const,
};

/**
 * The three platform cards. Built from the ACTIVE bundle's connection so the
 * URLs an operator copies are the ones the tenant actually serves — never
 * typed by hand into the page (that is how the legacy GPT ended up with an
 * invented OAuth scope and a wrong path prefix).
 */
export const platformCards = (active: ManifestBundleView | null): PlatformCard[] => {
  const origin = active?.connection.origin ?? '';
  const mcpUrl = active?.connection.mcp_url ?? '';
  return [
    {
      id: 'claude',
      title: 'Claude',
      actors: ['plugin:claude'],
      downloadUrl: active ? exportUrl('plugin') : null,
      downloadLabel: 'Download .plugin',
      copyUrl: active ? mcpUrl : null,
      copyLabel: 'Connector URL',
      steps: [
        'Install the .plugin file — it carries the skill and the connector together.',
        'Or: upload the skill zip to org skills and add the connector URL by hand.',
        'Sign in when the first tool runs. OAuth is required; there is no anonymous mode.',
        'Set the publishing tools to Ask for the first week.',
      ],
      limitation: null,
    },
    {
      id: 'openai',
      title: 'ChatGPT',
      actors: ['plugin:openai-gpt', 'plugin:openai-agent'],
      downloadUrl: active ? exportUrl('gpt') : null,
      downloadLabel: 'Download OpenAI config (both shapes)',
      copyUrl: active ? `${origin}/api/plugin/openapi.json` : null,
      copyLabel: 'Actions schema URL',
      steps: [
        'Two shapes ship together — read the bundle README first. Custom GPT (charter-enforced through the Actions façade, installs on the installer own plan) or Agent Studio (tenant /mcp attached directly, invite-only, better for long runs).',
        'Custom GPT: paste gpt/instructions.md, upload gpt/knowledge/*.md, then Actions → Import from URL using the schema URL above.',
        'Custom GPT OAuth: register a client once, paste the id and secret, leave the scope EMPTY.',
        'Agent: attach the tenant /mcp as an App, add agent/skill/SKILL.md as the skill, paste agent/operational-instructions.md. Remove any direct PDF-Tool app.',
      ],
      limitation: null,
    },
    {
      id: 'gemini',
      title: 'Gemini',
      actors: [],
      downloadUrl: active ? exportUrl('gemini') : null,
      downloadLabel: 'Download Gem instructions',
      copyUrl: null,
      copyLabel: null,
      steps: [
        'Paste into Gemini → Gems → new Gem → Instructions.',
        'Hand finished drafts to Claude or ChatGPT to publish.',
      ],
      limitation:
        'Drafting only. A Gem has no custom tool calling, so it cannot reach the CMS — the export says so plainly rather than letting the model claim it published.',
    },
  ];
};

/** One line per dial, for the ceiling readout. */
export const ceilingRows = (active: ManifestBundleView | null): Array<{ dial: string; value: string }> => {
  const ceiling = active?.sources.aggression_ceiling ?? {};
  return ['claim_strength', 'urgency', 'emotional_agitation', 'cta_density'].map((dial) => ({
    dial,
    value: typeof ceiling[dial] === 'number' ? ceiling[dial].toFixed(2) : '—',
  }));
};

export type ManifestStatus =
  | { kind: 'none'; label: string; tone: 'neutral'; detail: string }
  | { kind: 'draft-only'; label: string; tone: 'warn'; detail: string }
  | { kind: 'stale'; label: string; tone: 'warn'; detail: string }
  | { kind: 'current'; label: string; tone: 'ok'; detail: string };

/**
 * One status in one place — the admin convention. Deliberately distinguishes
 * "nothing promoted" from "promoted but stale": the first means the exports
 * 409, the second means installed copies are running an older revision.
 */
export const manifestStatus = (state: PluginManifestState | null): ManifestStatus => {
  if (!state || (!state.active && !state.draft)) {
    return {
      kind: 'none',
      label: 'Not generated',
      tone: 'neutral',
      detail: 'Render a draft to produce a plugin bundle for this site.',
    };
  }
  if (!state.active) {
    return {
      kind: 'draft-only',
      label: 'Draft only',
      tone: 'warn',
      detail: 'A draft exists but nothing is promoted, so the exports and the Actions schema are unavailable.',
    };
  }
  if (state.stale.length) {
    return {
      kind: 'stale',
      label: 'Stale',
      tone: 'warn',
      detail: `${state.stale.length} change${state.stale.length === 1 ? '' : 's'} since this bundle was rendered. Re-render, promote, then re-download and re-install.`,
    };
  }
  return {
    kind: 'current',
    label: 'Current',
    tone: 'ok',
    detail: `Manifest ${state.active.manifest_version}. Installed copies carrying this version are up to date.`,
  };
};

/** True when there is a draft newer than what is promoted. */
export const hasUnpromotedDraft = (state: PluginManifestState | null): boolean =>
  Boolean(state?.draft && state.draft.manifest_version !== state.active?.manifest_version);
