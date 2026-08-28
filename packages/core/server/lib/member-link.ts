import { sha256Hex } from './crypto.js';
import { computeVisitorHashes } from './tracking-events.js';

const LINK_TIMEOUT_MS = 2_000;
const HEX64_RE = /^[0-9a-f]{64}$/;

type LinkRequest = {
  headers?: Record<string, string | undefined>;
};

export type MemberLinkDeps = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

export type MemberLinkPayload = {
  project_id: string;
  shash: string;
  member_hash: string;
};

const getHeader = (headers: LinkRequest['headers'], name: string): string | undefined => {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
};

const linkEndpoint = (sinkUrl: string): string => `${sinkUrl.replace(/\/+$/, '')}/link`;

export const visitorShashForRequest = (request: LinkRequest, deps: MemberLinkDeps = {}): string | null => {
  const env = deps.env ?? process.env;
  const salt = env.TRACKING_SALT?.trim();
  const projectId = env.TRACKING_PROJECT_ID?.trim();
  if (!salt || !projectId) return null;

  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const utcDate = new Date(nowMs).toISOString().slice(0, 10);
  const ip =
    getHeader(request.headers, 'x-nf-client-connection-ip') ??
    getHeader(request.headers, 'x-forwarded-for')?.split(',')[0]?.trim() ??
    '';
  const ua = getHeader(request.headers, 'user-agent') ?? '';
  return computeVisitorHashes({ salt, utcDate, ip, ua, projectId, nowMs }).shash;
};

export const enqueueMemberLinkForShash = (
  shash: string | null | undefined,
  email: string | null | undefined,
  deps: MemberLinkDeps = {}
): boolean => {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail || !shash || !HEX64_RE.test(shash)) return false;

  const env = deps.env ?? process.env;
  const sinkUrl = env.TRACKING_SINK_URL?.trim();
  const sinkToken = env.TRACKING_SINK_TOKEN?.trim();
  const projectId = env.TRACKING_PROJECT_ID?.trim();
  if (!sinkUrl || !sinkToken || !projectId) return false;

  const payload: MemberLinkPayload = {
    project_id: projectId,
    shash,
    member_hash: sha256Hex(normalizedEmail),
  };

  try {
    void (deps.fetchImpl ?? fetch)(linkEndpoint(sinkUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sinkToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    }).catch(() => undefined);
  } catch {
    // A synchronous transport failure is also best-effort and must not affect
    // opt-in capture or Stripe acknowledgement.
  }

  return true;
};

/**
 * Best-effort member/session link. Raw email and IP are reduced to one-way
 * hashes before fetch is called and are never included in its payload.
 */
export const enqueueMemberLink = (
  request: LinkRequest,
  email: string | null | undefined,
  deps: MemberLinkDeps = {}
): boolean => {
  return enqueueMemberLinkForShash(visitorShashForRequest(request, deps), email, deps);
};
