/**
 * admin-plugin-manifest — the surface for the publishing-plugin bundle.
 *
 *   GET                      → the stored doc: active, draft, and why an
 *                              installed export is stale (W4.2).
 *   GET ?export=skill        → the Claude skill zip for the ACTIVE bundle (W2.1).
 *   GET ?export=plugin       → the Cowork `.plugin` bundle (W2.2).
 *   POST {action:"render"}   → render a fresh draft from live state.
 *   POST {action:"promote"}  → make the current draft the active bundle.
 *   POST {action:"invite"}   → invite a member AND send them the install link
 *                              in one click (W7.1).
 *
 * Exports serve the ACTIVE bundle only. A draft is a proposal — shipping one to
 * a human's Claude org would put an unreviewed skill in front of the team, and
 * "promote, then download" is one extra click that makes the review real.
 *
 * Owner/admin only. The bundle carries no secrets — the OAuth URLs and the MCP
 * endpoint are public facts, and the token never transits here — but rendering
 * reads the site's governed objects, so it stays behind admin auth.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { getGovernanceBlobStore, resolveActivePolicies } from '../lib/governance-store.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { visibleToolDefinitions } from './mcp.js';
import {
  getPluginManifestBlobStore,
  getPluginManifestDoc,
  putPluginManifestDoc,
  promoteDraft,
  recordRenderedDraft,
} from '../lib/plugin/manifest-store.js';
import { buildManifestBundle, manifestStaleReasons, skillFingerprint } from '../lib/plugin/build-manifest.js';
import { toolSurfaceDigest, buildPluginTools } from '../lib/plugin/build-tools.js';
import { platformForActor, pluginPlatforms, type PluginPlatform } from '../lib/plugin/manifest-types.js';
import { buildSkillZip, buildCoworkPlugin } from '../lib/plugin/export-claude.js';
import { buildGptConfigZip, GptInstructionsTooLongError } from '../lib/plugin/export-openai.js';
import { buildGemInstructions } from '../lib/plugin/export-gemini.js';
import { readVoiceRecord } from '../lib/plugin/read-voice.js';
import { ensureMcpSiblings } from '../lib/agent/mcp-siblings.js';
import { handleMembershipVerb } from '../lib/membership/verbs.js';
import { getUsersBlobStore } from '../lib/users-store.js';
import { installInviteMail } from '../lib/mail/send.js';
import { resolveMailSender } from '../lib/mail/send.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import type { GoTrueIdentity } from '../lib/membership/invitations.js';
import { getInstallSignalsDoc, type InstallSignalsStore } from '../lib/plugin/install-signals.js';
import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY } from '../lib/blob-list.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';

/**
 * W7.6 — how many published articles the installers board looks back over.
 *
 * The board answers "when did this member last publish, from which surface".
 * Reading every article on every plugins-page load would be a scan an operator
 * pays for on a page they open to read two numbers, so the board is served on
 * its own request (`?view=installers`) and bounded here. Sixty covers months of
 * real publishing on a tenant this size; past that the answer is "a while ago",
 * which the board says by having no row.
 */
const INSTALLERS_PUBLISH_SCAN_CAP = 60;

/**
 * Tiers this action may grant. `owner` is deliberately absent: transferring
 * ownership is its own verb with its own confirmation, and it has no business
 * riding a convenience button on the plugins page.
 */
const INVITABLE_ROLES = ['admin', 'publisher', 'editor', 'viewer'];

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined>;
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

/**
 * The tenant's public origin. The deploy does not know its own hostname from
 * config — it learns it per request — so it is derived from the forwarded host,
 * exactly as the OAuth audience check does.
 */
const originFromEvent = (event: LambdaEvent): string | null => {
  const headers = event.headers ?? {};
  const host = headers['x-forwarded-host'] ?? headers['X-Forwarded-Host'] ?? headers.host ?? headers.Host;
  if (!host) return null;
  const proto = headers['x-forwarded-proto'] ?? headers['X-Forwarded-Proto'] ?? 'https';
  return `${proto}://${host}`;
};

const parsePlatform = (value: unknown): PluginPlatform =>
  pluginPlatforms.includes(value as PluginPlatform) ? (value as PluginPlatform) : 'claude';

/**
 * The named steps of a request, in the order they run.
 *
 * /admin/plugins showed "Plugin manifest unavailable — Request failed (502)".
 * A 502 is Netlify saying the lambda died; it carries no stage, no message and
 * no way to tell "the tool surface threw" from "the store is down" from "the
 * render is broken". The operator's only next move was to ask someone to read
 * a function log they cannot reach.
 *
 * So a domain failure anywhere below never becomes a 502: it answers HTTP 200
 * with {ok:false, stage, error}, and the page names the stage. HTTP codes stay
 * honest for TRANSPORT-level facts — 401/403 for auth, 405 for method, 400 for
 * a missing Host, 409 for "no draft to promote" — those are well-formed
 * answers, not crashes.
 */
type ManifestStage =
  | 'mcp_siblings'
  | 'manifest_store'
  | 'manifest_doc'
  | 'approval'
  | 'tool_surface'
  | 'voice'
  | 'summary'
  | 'export'
  | 'render'
  | 'promote'
  | 'invite'
  | 'persist';

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  const method = event.httpMethod ?? 'GET';
  if (method !== 'GET' && method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const access = await resolveAdminAccessFromEvent(event, context);
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });

  /**
   * This function reads the live tool surface through `visibleToolDefinitions()`,
   * and that filter calls `requireSiblings()` — which throws by design in a
   * process that never injected the /mcp siblings. This is a different lambda
   * from /mcp, so nothing had ever injected them here: an authenticated GET
   * threw "MCP server not configured" one line below the auth gate and Netlify
   * answered a bare 502. Every test this endpoint had stopped at 401/403/405,
   * so no test ever reached the throwing line.
   *
   * Derived from this function's OWN binding and guarded by `isMcpConfigured()`
   * — it can never inject another tenant's handlers, and never downgrades a
   * real /mcp shim that already injected a richer set.
   */
  // Every step from here on names itself, so a failure can say WHERE.
  let stage: ManifestStage = 'mcp_siblings';

  try {
    ensureMcpSiblings(binding);

    const origin = originFromEvent(event);
    if (!origin)
      return jsonResponse(400, { error: 'The request carried no Host header, so the tenant origin is unknown.' });

    stage = 'manifest_store';
    const store = await getPluginManifestBlobStore(event, binding);

    stage = 'manifest_doc';
    const doc = await getPluginManifestDoc(store);

    stage = 'approval';
    const approval = await resolveApproval(event);

    stage = 'tool_surface';
    const liveTools = buildPluginTools(visibleToolDefinitions());
    const liveDigest = toolSurfaceDigest(liveTools);

    if (method === 'GET' && event.queryStringParameters?.view === 'installers') {
      /**
       * The installers board (W7.6): who has proven an install, on which
       * surface, against which manifest — and when they last actually
       * published from it.
       *
       * Its own request, deliberately. It costs a bounded object scan, and the
       * plugins page's main job (render, promote, download) must not pay for a
       * section the operator has not opened.
       */
      stage = 'manifest_store';
      const signals = await getInstallSignalsDoc(store as unknown as InstallSignalsStore);

      stage = 'summary';
      const publishes = await recentPublishes(event);

      return jsonResponse(200, {
        signals: signals.members,
        publishes,
        live: { tools_digest: liveDigest, manifest_version: doc.active?.manifest_version ?? null },
      });
    }

    if (method === 'GET') {
      const exportKind = event.queryStringParameters?.export;
      if (exportKind) {
        if (!['skill', 'plugin', 'gpt', 'gemini'].includes(exportKind)) {
          return jsonResponse(400, { error: 'export must be "skill", "plugin", "gpt" or "gemini".' });
        }
        if (!doc.active) {
          return jsonResponse(409, {
            error: 'There is no active bundle to export. Render a draft and promote it first.',
          });
        }

        stage = 'export';

        // Gemini is markdown, not a zip: a Gem has one instructions field and
        // nothing to connect (plan D6), so there is no bundle to build.
        if (exportKind === 'gemini') {
          const gem = buildGemInstructions(doc.active);
          return {
            statusCode: 200,
            headers: {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': `attachment; filename="${gem.filename}"`,
              'Cache-Control': 'no-store',
              'X-Plugin-Manifest-Version': doc.active.manifest_version,
            },
            body: gem.content,
          };
        }
        let artifact;
        try {
          artifact =
            exportKind === 'skill'
              ? buildSkillZip(doc.active)
              : exportKind === 'plugin'
                ? buildCoworkPlugin(doc.active)
                : buildGptConfigZip(doc.active);
        } catch (error) {
          // The GPT instructions cap is ChatGPT's, not ours: a bundle that would
          // not fit is a render defect to fix, never something to truncate
          // silently into a half-instruction.
          if (error instanceof GptInstructionsTooLongError) {
            return jsonResponse(500, { error: error.message, error_code: 'gpt_instructions_too_long' });
          }
          throw error;
        }
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${artifact.filename}"`,
            'Cache-Control': 'no-store',
            // The version the human is installing, readable without unzipping —
            // this is what an operator compares against the live manifest when
            // an install looks stale.
            'X-Plugin-Manifest-Version': doc.active.manifest_version,
          },
          body: artifact.bytes.toString('base64'),
          isBase64Encoded: true,
        };
      }

      stage = 'voice';
      const voice = await readVoiceRecord(event, binding, getSiteObjectsBlobStore).catch(() => null);

      stage = 'summary';
      /**
       * W7.7: what the skill WOULD render as right now, for the same platform
       * the active bundle was rendered for.
       *
       * Rendered through `buildManifestBundle` rather than by calling the
       * renderer directly, so the live side and the stored side can never drift
       * apart — a comparison whose two halves are built differently reports
       * staleness forever. It is pure and synchronous (voice and approval are
       * already in hand), so this costs no extra I/O.
       *
       * Skipped for a bundle with no `actor_id`: those predate the field, the
       * platform cannot be known, and rendering against the wrong one would
       * report a healthy bundle as stale.
       */
      const activeActor = doc.active?.actor_id;
      const liveSkillDigest = activeActor
        ? skillFingerprint(
            buildManifestBundle({
              origin,
              definitions: visibleToolDefinitions(),
              voice,
              platform: platformForActor(activeActor),
              approval,
            }).skill_md
          )
        : undefined;

      const live = {
        voiceRecordVersion: voice?.record_version ?? null,
        toolSurfaceDigest: liveDigest,
        approvalPosture: approval.master,
        ...(liveSkillDigest ? { skillDigest: liveSkillDigest } : {}),
      };
      return jsonResponse(200, {
        active: doc.active ?? null,
        draft: doc.draft ?? null,
        stale: doc.active ? manifestStaleReasons(doc.active, live) : [],
        updated_by: doc.updated_by,
        updated_at: doc.updated_at,
        history: doc.history.slice(0, 10),
        exports: doc.active
          ? {
              skill_zip: '/.netlify/functions/admin-plugin-manifest?export=skill',
              cowork_plugin: '/.netlify/functions/admin-plugin-manifest?export=plugin',
              gpt_config: '/.netlify/functions/admin-plugin-manifest?export=gpt',
              gem_instructions: '/.netlify/functions/admin-plugin-manifest?export=gemini',
              actions_openapi: '/api/plugin/openapi.json',
            }
          : null,
      });
    }

    let payload: Record<string, unknown> = {};
    try {
      const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body.' });
    }

    const action = typeof payload.action === 'string' ? payload.action : '';

    if (action === 'promote') {
      stage = 'promote';
      const promoted = promoteDraft(doc, access.email, new Date().toISOString());
      if (!promoted.ok) return jsonResponse(409, { error: promoted.error });
      stage = 'persist';
      await putPluginManifestDoc(store, promoted.doc);
      return jsonResponse(200, { active: promoted.doc.active, promoted: true });
    }

    /**
     * W7.1 — "Invite & send link", one click.
     *
     * It lives HERE rather than on the members page because the operator who
     * decides someone should publish from ChatGPT is looking at this page, and
     * the two-surface dance ("go invite them, then come back and send them the
     * link") is exactly where an install stops happening. One action does both.
     *
     * The invitation itself runs in the membership core with the human this
     * function authenticated — same gate, same tier checks, same audit as the
     * members page; nothing about permissions is re-decided here. What this
     * adds is the SECOND message: GoTrue's template cannot interpolate a role
     * (it has three variables and role is not one of them), and the role is
     * what tells an invitee whether they can publish at all.
     *
     * The mail is best-effort by construction. A tenant with no mail configured
     * still gets the invitation — `resolveMailSender` returns the null sender,
     * the response says `mail.sent: false` with the catalogued code, and the
     * operator copies the link by hand. An invitation must never fail because a
     * courtesy e-mail could not go out.
     */
    if (action === 'invite') {
      stage = 'invite';
      const email = typeof payload.email === 'string' ? payload.email.trim() : '';
      const role = typeof payload.role === 'string' ? payload.role : '';
      if (!email) return jsonResponse(400, { error: 'email is required.' });
      if (!INVITABLE_ROLES.includes(role)) {
        return jsonResponse(400, { error: `role must be one of: ${INVITABLE_ROLES.join(', ')}.` });
      }

      const identityCtx = (context as { clientContext?: { identity?: GoTrueIdentity } } | undefined)?.clientContext
        ?.identity;
      const invited = await handleMembershipVerb({
        verb: 'invite',
        args: { email, role },
        principal: { kind: 'human', id: access.userId ?? '', email: access.email, via: 'admin_ui' },
        deps: {
          store: (await getUsersBlobStore(event)) as never,
          identity: identityCtx,
          fetchImpl: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
            fetch(url, init),
          oauthStore: async () => (await getGovernanceBlobStore(event)) as never,
          objectStore: async () => (await getSiteObjectsBlobStore(event)) as never,
        },
      });
      if (invited.status < 200 || invited.status >= 300) return jsonResponse(invited.status, invited.body);

      const message = installInviteMail({
        brandName: getSiteIdentity().brandName,
        role,
        origin,
        invitedBy: access.email,
      });
      const mail = await resolveMailSender()
        .send({ to: email, subject: message.subject, text: message.text, tags: { kind: 'install_invite' } })
        .catch((error: unknown) => ({
          ok: false as const,
          code: 'mail_unreachable' as const,
          message: error instanceof Error ? error.message : String(error),
        }));

      return jsonResponse(200, {
        invited: invited.body,
        install_url: `${origin}/plugin/install`,
        mail: mail.ok ? { sent: true } : { sent: false, code: mail.code, error: mail.message },
      });
    }

    if (action !== 'render') {
      return jsonResponse(400, { error: 'action must be "render", "promote" or "invite".' });
    }

    stage = 'voice';
    const voice = await readVoiceRecord(event, binding, getSiteObjectsBlobStore).catch(() => null);

    stage = 'render';
    const bundle = buildManifestBundle({
      origin,
      definitions: visibleToolDefinitions(),
      voice,
      platform: parsePlatform(payload.platform),
      approval,
    });

    stage = 'persist';
    const next = recordRenderedDraft(doc, bundle, access.email);
    await putPluginManifestDoc(store, next);
    return jsonResponse(200, { draft: bundle, warnings: bundle.warnings });
  } catch (error) {
    /**
     * An operator sees WHICH step failed and what it said, on a page that still
     * renders. A 502 told them only that something died.
     *
     * But HTTP 200 is only honest where the SUCCESS is also JSON. The export
     * routes answer bytes: a 200 carrying {ok:false} there is indistinguishable
     * from a bundle to any client that checks `response.ok`, and that is not
     * theoretical — it shipped. The GPT export threw, this wrapper answered
     * 200, and the browser saved 148 bytes of error JSON as
     * `plugin-bundle.zip`, which of course would not open. A download that
     * fails must fail loudly enough that a client cannot mistake it for a file.
     */
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`admin-plugin-manifest failed at stage "${stage}".`, error);
    const isBinaryRoute = Boolean(event.queryStringParameters?.export);
    return jsonResponse(isBinaryRoute ? 500 : 200, {
      ok: false,
      stage,
      error: detail.slice(0, 500),
    });
  }
};

/**
 * The most recent publishes, with the surface that made each one.
 *
 * Read from `publication.publish_receipt` (W7.4 stamps `surface` and
 * `attribution` there from the auth-derived actor), so the board reports what
 * the ledger will agree with rather than a second, drifting derivation.
 *
 * Failures are per-record and silent: one unreadable article must not blank a
 * board that is otherwise useful, and an operator can tell "no row" from
 * "everything is missing" at a glance.
 */
const recentPublishes = async (event: LambdaEvent) => {
  type Row = { object_id: string; surface: string | null; published_at: string; attribution: string | null };
  let rows: Row[] = [];
  try {
    const objects = await getSiteObjectsBlobStore(event);
    const keys = (await collectBlobListItems(await objects.list({ prefix: 'objects/content_item/by-id/' })))
      .map((item) => item.key)
      .slice(0, INSTALLERS_PUBLISH_SCAN_CAP);

    const read = await mapWithConcurrency(keys, STORE_READ_CONCURRENCY, async (key) => {
      try {
        const raw = await objects.get(key);
        if (!raw) return null;
        const record = JSON.parse(raw as string) as ObjectRecord;
        const receipt = record.publication?.publish_receipt;
        const publishedAt = record.publication?.published_time;
        if (!publishedAt) return null;
        return {
          object_id: record.object_id,
          surface: receipt?.surface ?? null,
          attribution: receipt?.attribution ?? null,
          published_at: publishedAt,
        } satisfies Row;
      } catch {
        return null;
      }
    });
    rows = read.filter((row): row is Row => row !== null);
  } catch {
    return [];
  }
  return rows.sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, 20);
};

const resolveApproval = async (event: LambdaEvent): Promise<{ master: string; overrides?: Record<string, string> }> => {
  try {
    const governance = await getGovernanceBlobStore(event);
    const active = await resolveActivePolicies(governance);
    const approval = active.approval as unknown as { master: string; overrides?: Record<string, string> };
    return { master: approval.master, overrides: approval.overrides };
  } catch {
    // The committed posture file is the documented fallback; buildManifestBundle
    // reads it when no posture is passed, and records a warning if even that fails.
    return { master: 'all-autonomous' };
  }
};

export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
