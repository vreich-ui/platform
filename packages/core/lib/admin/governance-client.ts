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
  default: ToolAutonomy;
  description: string;
}

export interface GovernanceState {
  doc: {
    approval?: ApprovalConfig;
    creation?: unknown;
    chat_tools?: Record<string, ToolAutonomy>;
    learning_mode?: boolean;
  } | null;
  committed: { approval: ApprovalConfig; creation: unknown };
  active: {
    approval: ApprovalConfig;
    creation: unknown;
    learning_mode: boolean;
    provenance: { approval: string; creation: string; learning_mode: string };
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

export const revertGovernance = (
  getToken: GetToken,
  target: 'approval' | 'creation' | 'chat_tools' | 'learning_mode' | 'all'
) => post<GovernanceState>(getToken, { verb: 'revert', target });

/** Effective mode for a type given a config (per-type override, else master). */
export const effectiveApprovalMode = (config: ApprovalConfig, type: string): ApprovalMode =>
  config.overrides[type] ?? (config.master === 'all-require-approval' ? 'require-approval' : 'autonomous');
