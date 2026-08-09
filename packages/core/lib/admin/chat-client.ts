/**
 * Agent chat client (T9.14) — browser wrappers over the admin-agent-chat verb
 * endpoint (T9.13). Same house pattern as users-client: Identity bearer,
 * typed results, errors thrown with the server's human message.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { CandidateSetView } from './candidate-choice.js';

const ENDPOINT = '/.netlify/functions/admin-agent-chat';

export type ChatStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_candidate'
  | 'error'
  | 'cancelled';

export interface ChatEventView {
  seq: number;
  at: string;
  type:
    | 'user_message'
    | 'run_started'
    | 'assistant_text'
    | 'candidate_set'
    | 'candidate_selected'
    | 'candidate_rejected'
    | 'tool_call'
    | 'tool_result'
    | 'tool_approval_required'
    | 'tool_approved'
    | 'tool_denied'
    | 'run_finished'
    | 'run_error'
    | 'run_cancelled'
    | 'events_trimmed';
  detail?: Record<string, unknown>;
}

export interface AgentView {
  profile_id: string;
  name: string;
  provider: 'anthropic' | 'openai';
  model: string;
  avatar_artifact?: string;
}

export interface PendingView {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  dry_run?: Record<string, unknown>;
}

export interface RunSummaryView {
  run_id: string;
  started_at: string;
  finished_at: string;
  outcome: 'completed' | 'error' | 'cancelled' | 'caps';
  chips: string[];
}

export interface ChatSummaryView {
  chat_id: string;
  kind: 'object' | 'free';
  object_type?: string;
  object_id?: string;
  title: string;
  status: ChatStatus;
  updated_at: string;
  last_outcome: RunSummaryView | null;
  agent?: AgentView;
}

export interface ChatView extends ChatSummaryView {
  seq: number;
  events: ChatEventView[];
  pending?: PendingView;
  candidate_set?: CandidateSetView;
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

export const createObjectChat = (getToken: GetToken, objectType: string, objectId: string, title?: string) =>
  post<{ chat: ChatSummaryView; existed: boolean }>(getToken, {
    action: 'create_chat',
    kind: 'object',
    object_type: objectType,
    object_id: objectId,
    ...(title ? { title } : {}),
  });

export const createFreeChat = (getToken: GetToken, title?: string) =>
  post<{ chat: ChatSummaryView; existed: boolean }>(getToken, {
    action: 'create_chat',
    kind: 'free',
    ...(title ? { title } : {}),
  });

export const listChats = (getToken: GetToken, includeAll = false) =>
  post<{ chats: ChatSummaryView[] }>(getToken, { action: 'list_chats', ...(includeAll ? { include_all: true } : {}) });

export const getChat = (getToken: GetToken, chatId: string, sinceSeq?: number) =>
  post<ChatView>(getToken, { action: 'get_chat', chat_id: chatId, ...(sinceSeq ? { since_seq: sinceSeq } : {}) });

export const sendChatMessage = (getToken: GetToken, chatId: string, text: string, focus?: string) =>
  post<{ chat_id: string; run_id: string }>(getToken, {
    action: 'send',
    chat_id: chatId,
    text,
    ...(focus ? { focus } : {}),
  });

export const chooseCandidate = (getToken: GetToken, chatId: string, callId: string, candidateId: string) =>
  post<{ selected: boolean }>(getToken, {
    action: 'choose_candidate',
    chat_id: chatId,
    call_id: callId,
    candidate_id: candidateId,
  });

export const rejectCandidates = (getToken: GetToken, chatId: string, callId: string, reason: string) =>
  post<{ rejected: boolean }>(getToken, {
    action: 'reject_candidates',
    chat_id: chatId,
    call_id: callId,
    reason,
  });

export interface PreferenceExportView {
  jsonl: string;
  count: number;
  candidate_events: number;
  manual_edits: number;
  hard_negatives: number;
}

export const exportPreferences = (getToken: GetToken) =>
  post<PreferenceExportView>(getToken, { action: 'export_preferences' });

export const approveTool = (getToken: GetToken, chatId: string, callId: string, editedArgs?: Record<string, unknown>) =>
  post<{ approved: boolean; is_error: boolean; edited: boolean }>(getToken, {
    action: 'approve_tool',
    chat_id: chatId,
    call_id: callId,
    ...(editedArgs ? { edited_args: editedArgs } : {}),
  });

export const denyTool = (getToken: GetToken, chatId: string, callId: string, reason?: string) =>
  post<{ denied: boolean }>(getToken, {
    action: 'deny_tool',
    chat_id: chatId,
    call_id: callId,
    ...(reason ? { reason } : {}),
  });

export const cancelChatRun = (getToken: GetToken, chatId: string) =>
  post<{ cancelled: boolean }>(getToken, { action: 'cancel', chat_id: chatId });

/** Live statuses poll fast (~1.2s); idle backs off (5s). */
export const pollIntervalFor = (status: ChatStatus | undefined): number =>
  status === 'queued' || status === 'running'
    ? 1200
    : status === 'awaiting_approval' || status === 'awaiting_candidate'
      ? 2000
      : 5000;

// ─── T9.26: roster & assignment ──────────────────────────────────────────────

export interface AgentProfileView {
  profile_id: string;
  name: string;
  avatar_artifact?: string;
  provider: 'anthropic' | 'openai';
  model: string;
  system_prompt: string;
  tool_autonomy_overrides?: Record<string, 'auto' | 'ask' | 'off'>;
  status: 'active' | 'disabled';
  created_by: string;
  updated_at: string;
}

export interface AgentAssignmentsView {
  objects: Record<string, string>;
  types: Record<string, string>;
  site_default?: string;
}

export const listProfiles = (getToken: GetToken) =>
  post<{ profiles: AgentProfileView[]; assignments: AgentAssignmentsView }>(getToken, { action: 'list_profiles' });

export interface ProfileUpsertInput {
  profile_id?: string;
  name: string;
  avatar_artifact?: string;
  provider: 'anthropic' | 'openai';
  model: string;
  system_prompt?: string;
  tool_autonomy_overrides?: Record<string, 'auto' | 'ask' | 'off'>;
  status?: 'active' | 'disabled';
}

export const upsertProfile = (getToken: GetToken, profile: ProfileUpsertInput) =>
  post<{ profile: AgentProfileView }>(getToken, { action: 'upsert_profile', profile });

export type AssignTarget =
  | { kind: 'object'; object_id: string }
  | { kind: 'type'; object_type: string }
  | { kind: 'site_default' };

export const assignProfile = (getToken: GetToken, target: AssignTarget, profileId: string | null) =>
  post<{ assignments: AgentAssignmentsView }>(getToken, { action: 'assign_profile', target, profile_id: profileId });
