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

export type InviteRole = 'admin' | 'publisher' | 'editor' | 'viewer';

export interface InviteAndSendResult {
  invited: Record<string, unknown>;
  install_url: string;
  /**
   * Whether the SECOND message went out — the one carrying the role, which
   * GoTrue's own template cannot interpolate. `sent: false` is a normal state
   * on a tenant with no mail configured, not a failed invitation: the member
   * is invited either way and the operator copies `install_url` by hand.
   */
  mail: { sent: boolean; code?: string; error?: string };
}

/**
 * W7.1 — "Invite & send link". One request, because two ("go invite them, then
 * come back for the link") is where an install stops happening.
 */
export const inviteAndSendInstallLink = (getToken: GetToken, email: string, role: InviteRole) =>
  request<InviteAndSendResult>(getToken, {
    method: 'POST',
    body: JSON.stringify({ action: 'invite', email, role }),
  });

/**
 * The filename the server chose, from `Content-Disposition`.
 *
 * It matters: the bundle name carries the tenant and the manifest version, and
 * an operator comparing an installed copy against the live manifest reads it
 * off the file. A browser-invented "admin-plugin-manifest" would throw that
 * away. Falls back to a sane name rather than failing the download.
 */
export const filenameFromDisposition = (disposition: string | null, fallback: string): string => {
  if (!disposition) return fallback;
  const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1];
  const bare = disposition.match(/filename\s*=\s*([^;]+)/i);
  return bare ? bare[1].trim() : fallback;
};

/**
 * Fetch one export bundle AS THE SIGNED-IN ADMIN.
 *
 * The page used to `window.open(url)` these. A top-level navigation carries no
 * `Authorization` header, so the admin function answered
 * {"ok":false,"status":401,"error":"Authentication is required."} and the
 * browser displayed that JSON instead of saving a file. Every export button —
 * the Claude .plugin, the OpenAI config, the Gem instructions — had been dead
 * since they shipped, in a way that looked like a broken download rather than
 * a missing credential.
 *
 * The bytes have to come through `fetch` with the same bearer every other call
 * on this page uses, and reach the disk as a blob.
 */
export const fetchPluginExport = async (
  getToken: GetToken,
  url: string,
  fallbackName: string
): Promise<{ blob: Blob; filename: string }> => {
  const token = await getToken();
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  if (!response.ok) {
    // The endpoint answers JSON on refusal — surface its reason, not "failed".
    let reason = `Download failed (${response.status})`;
    try {
      const body = (await response.clone().json()) as { error?: string };
      if (body.error) reason = body.error;
    } catch {
      /* a non-JSON body: the status is all there is to say */
    }
    throw new Error(reason);
  }

  /**
   * A 2xx is not proof of a bundle.
   *
   * The endpoint's failure envelope is JSON, and for a while a failing export
   * answered HTTP 200 with it — so `response.ok` was true, this function
   * returned the JSON as a "blob", and the page wrote 148 bytes of error text
   * to disk named `plugin-bundle.zip`. The operator got a zip that would not
   * open instead of the reason it could not be built. The server no longer
   * does that; refusing it here too means no future variant of the same
   * mistake reaches the disk.
   */
  // Narrow on purpose: the refusal envelope is application/json, while the Gem
  // export is legitimately text/markdown. Rejecting "not a zip" would break a
  // working download to guard against a broken one.
  const contentType = response.headers.get('Content-Type') ?? '';
  if (/application\/json/i.test(contentType)) {
    let reason = 'The server returned a message instead of a bundle.';
    try {
      const body = (await response.clone().json()) as { error?: string; stage?: string };
      if (body.error) reason = body.stage ? `${body.error} (failed at: ${body.stage})` : body.error;
    } catch {
      /* not JSON after all — keep the generic reason */
    }
    throw new Error(reason);
  }

  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackName),
  };
};

/* ── W7.6: the installers board ───────────────────────────────────────────── */

export interface InstallSignalView {
  last_whoami_at: string;
  manifest_version: string | null;
  tools_digest: string;
  can_write: boolean;
  count: number;
}

export interface PublishRow {
  object_id: string;
  surface: string | null;
  attribution: string | null;
  published_at: string;
}

export interface InstallersBoard {
  /** email → surface → signal. */
  signals: Record<string, Record<string, InstallSignalView>>;
  publishes: PublishRow[];
  live: { tools_digest: string; manifest_version: string | null };
}

/**
 * Its own request: the board costs a bounded object scan, and the page's main
 * job must not pay for a section the operator has not opened.
 */
export const fetchInstallersBoard = (getToken: GetToken) =>
  request<InstallersBoard>(getToken, { query: '?view=installers' });

export interface InstallerRow {
  email: string;
  surface: string;
  lastSeen: string;
  canWrite: boolean;
  /** The bundle that install is running, and whether it is the promoted one. */
  manifestVersion: string | null;
  stale: boolean;
  /** Their most recent publish FROM THIS SURFACE, when there is one. */
  lastPublishedAt: string | null;
  sessions: number;
}

/**
 * Fold the board into one row per member+surface.
 *
 * The three columns are the three questions an owner actually asks, in order:
 * did it work (a signal exists at all), can they write (the role took effect),
 * and are they current (their install's manifest matches the promoted one).
 *
 * `stale` is computed against the LIVE manifest version rather than trusted
 * from the stored signal: a re-promote makes every previously-current install
 * stale without any of them calling again, and a board that only noticed on the
 * installer's next session would be reassuring at exactly the wrong moment.
 *
 * The last publish is matched by SURFACE, not by member: the receipt records
 * which chat app published, not which human, so "editor@x last published from
 * their Custom GPT" is the honest reading and "editor@x published" is not.
 */
export const installerRows = (board: InstallersBoard | null): InstallerRow[] => {
  if (!board) return [];
  const lastPublishBySurface = new Map<string, string>();
  for (const row of board.publishes) {
    if (!row.surface) continue;
    const current = lastPublishBySurface.get(row.surface);
    if (!current || row.published_at > current) lastPublishBySurface.set(row.surface, row.published_at);
  }

  return Object.entries(board.signals)
    .flatMap(([email, bySurface]) =>
      Object.entries(bySurface).map(([surface, signal]) => ({
        email,
        surface,
        lastSeen: signal.last_whoami_at,
        canWrite: signal.can_write,
        manifestVersion: signal.manifest_version,
        stale: Boolean(board.live.manifest_version) && signal.manifest_version !== board.live.manifest_version,
        lastPublishedAt: lastPublishBySurface.get(surface) ?? null,
        sessions: signal.count,
      }))
    )
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
};

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
        'Or: upload the skill zip to org skills and add the connector URL by hand. The zip is a SKILL, not a plugin: one folder with SKILL.md at its root — uploading the .plugin here instead fails with an unhelpful error.',
        'Sign in when the first tool runs. OAuth is required; there is no anonymous mode.',
        'Delete any older connector for this tenant first. Duplicates authenticate independently, and nothing in the chat tells you which one answered — the usual cause of "it worked yesterday".',
        'Set the publishing tools to Ask for the first week, and have them run whoami once to prove the install.',
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
        'Agent: attach the tenant /mcp as an App, add agent/skill/SKILL.md as the skill, paste agent/operational-instructions.md. Remove any direct PDF-Tool app — this endpoint already carries those tools.',
        'UPDATE IS A STEP on Agent Studio. It caches what it imported and will not notice a re-promote: after every promote, re-attach the App and re-paste the instructions. whoami reports tools_digest_matches false when that is due, and the Installers board flags the member as stale.',
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
