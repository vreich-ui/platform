/**
 * Guardrails client (T9.15) — wrappers over admin-governance. read (any admin);
 * set / revert (Owner; the server 403s a non-owner).
 */
import type { GetToken } from '../edit-mode/verbs-client.js';

const ENDPOINT = '/.netlify/functions/admin-governance';

export type ApprovalMode = 'autonomous' | 'require-approval';
export type ApprovalMaster = 'all-autonomous' | 'all-require-approval';

export interface ApprovalConfig {
  master: ApprovalMaster;
  overrides: Partial<Record<string, ApprovalMode>>;
}

/** Per-chat-tool autonomy (T9.13 run loop): run immediately / pause for
 *  approval / hide from the tool list entirely. */
export type ToolAutonomy = 'auto' | 'ask' | 'off';

/** One row of the guardrails chat-tool table, from the server (CHAT_TOOLS is
 *  the single source, so the UI never drifts from the wired tools). */
export interface ChatToolCatalogEntry {
  name: string;
  tool_class: 'read' | 'draft' | 'creation' | 'publication' | 'privileged' | 'membership';
  /** W18 T18.6b: 'ask' = a hard floor — no override (here or per agent) can make the tool run automatically. */
  autonomy_floor?: 'ask';
  /**
   * The name this tool is STORED under, when it differs from `name`.
   *
   * The catalog serves the legacy chat names (`patch`, `publish`, …) because
   * that is what CHAT_TOOLS is keyed by, but admin-governance canonicalizes
   * every written key through CHAT_TOOL_ALIASES (`patch` → `object_patch`).
   * Without this, a saved override was written under one key and read back
   * under another, so the row snapped straight back to "Use standard setting"
   * and the change looked like it had never saved. The server sends the
   * canonical name so the client can read its own writes back without
   * importing the server's alias table.
   */
  canonical_name?: string;
  default: ToolAutonomy;
  description: string;
}

/** The `style` override channel guardrail (BRIEF §3.7/R5) — 'allow' is the
 *  default; 'lock' makes an artifact job ignore a supplied `style` and use
 *  only the site's own brandImagery. */
export type BrandImageryOverridePolicy = 'allow' | 'lock';

export interface GovernanceState {
  doc: {
    approval?: ApprovalConfig;
    creation?: unknown;
    chat_tools?: Record<string, ToolAutonomy>;
    learning_mode?: boolean;
    brandImageryOverrides?: BrandImageryOverridePolicy;
  } | null;
  committed: { approval: ApprovalConfig; creation: unknown };
  active: {
    approval: ApprovalConfig;
    creation: unknown;
    learning_mode: boolean;
    brandImageryOverrides: BrandImageryOverridePolicy;
    provenance: { approval: string; creation: string; learning_mode: string; brandImageryOverrides: string };
  };
  chat_tools_catalog?: ChatToolCatalogEntry[];
}

async function post<T>(getToken: GetToken, body: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as T;
}

export const fetchGovernance = (getToken: GetToken) => post<GovernanceState>(getToken, { verb: 'get' });

export const setApprovalOverride = (getToken: GetToken, approval: ApprovalConfig) =>
  post<GovernanceState>(getToken, { verb: 'set', approval });

/** Write the chat-tool autonomy override map (partial — omitted tools fall back
 *  to their class default in the run loop). Owner-only server-side. */
export const setChatToolsOverride = (getToken: GetToken, chatTools: Record<string, ToolAutonomy>) =>
  post<GovernanceState>(getToken, { verb: 'set', chat_tools: chatTools });

export const setLearningMode = (getToken: GetToken, enabled: boolean) =>
  post<GovernanceState>(getToken, { verb: 'set', learning_mode: enabled });

/** Write the brand-imagery override guardrail (U2). Owner-only server-side. */
export const setBrandImageryOverrides = (getToken: GetToken, policy: BrandImageryOverridePolicy) =>
  post<GovernanceState>(getToken, { verb: 'set', brandImageryOverrides: policy });

export const revertGovernance = (
  getToken: GetToken,
  target: 'approval' | 'creation' | 'chat_tools' | 'learning_mode' | 'brandImageryOverrides' | 'all'
) => post<GovernanceState>(getToken, { verb: 'revert', target });

/** Effective mode for a type given a config (per-type override, else master). */
export const effectiveApprovalMode = (config: ApprovalConfig, type: string): ApprovalMode =>
  config.overrides[type] ?? (config.master === 'all-require-approval' ? 'require-approval' : 'autonomous');
