/**
 * T9.13 — agent profiles & assignment (`agent-profiles` blob store; plan §4a,
 * Wolf's 2026-07-16 amendment).
 *
 * An agent profile is a named configuration: provider + model are SET on the
 * profile, never hardcoded in the runtime (both Anthropic and OpenAI are v1
 * providers — OQ-W9-3 resolved). One doc holds every profile plus the
 * assignments map; resolution chain: object → type default → site default →
 * built-in fallback. The chat runtime stamps the RESOLVED profile into the
 * run record at send time, so a mid-run reassignment never switches a live
 * run. Owner-managed (management UI lands in T9.26); read: any admin.
 */
import { getSiteIdentity } from '../../../lib/site-identity.js';
import { z } from 'zod';

import { getNetlifyBlobStore } from '../blob-store.js';

export const AGENT_PROFILES_DOC_KEY = 'profiles.v1';

export const agentProviderSchema = z.enum(['anthropic', 'openai']);
export type AgentProvider = z.infer<typeof agentProviderSchema>;

export const agentProfileSchema = z.object({
  profile_id: z.string().min(1),
  name: z.string().min(1),
  avatar_artifact: z.string().optional(),
  provider: agentProviderSchema,
  model: z.string().min(1),
  system_prompt: z.string(),
  /** Per-tool autonomy overrides layered over defaults + governance (auto/ask/off). */
  tool_autonomy_overrides: z.record(z.string(), z.enum(['auto', 'ask', 'off'])).optional(),
  status: z.enum(['active', 'disabled']),
  created_by: z.string(),
  updated_at: z.string(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const agentProfilesDocSchema = z.object({
  schema_version: z.literal('agent-profiles.v1'),
  profiles: z.record(z.string(), agentProfileSchema),
  assignments: z.object({
    /** object_id → profile_id */
    objects: z.record(z.string(), z.string()),
    /** object_type → profile_id */
    types: z.record(z.string(), z.string()),
    site_default: z.string().optional(),
  }),
  updated_at: z.string(),
  /** Task 3 (schema-additive): set once every profile's
   *  `tool_autonomy_overrides` has been canonicalized through
   *  `migrateAutonomyKeys` (write-back on read in admin-agent-chat.ts) —
   *  short-circuits re-migration so a post-migration owner may legitimately
   *  set the canonical `search_artifacts` key. */
  keys_migrated: z.boolean().optional(),
});
export type AgentProfilesDoc = z.infer<typeof agentProfilesDocSchema>;

export interface AgentProfilesStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
}

const DEFAULT_SYSTEM_PROMPT = [
  `You are a CMS agent for the ${getSiteIdentity().brandName} site. You work on governed content objects through`,
  'contract-bound tools; a human approves every write unless a tool is configured autonomous.',
  'Refer to objects and people by display name, never raw ids (ids belong in tool args only).',
  'Read before you write: get_contract explains what a type allows; validate before publishing.',
  'Patch semantics: `fields` deep-merges — set a key to null to REMOVE it; switching a section',
  'variant requires explicitly nulling the keys the old variant used. Always checkout before',
  'patching, use the expected_record_version the checkout returned, and check in when done.',
  'Write replies in short paragraphs. Use Markdown lists for enumerations instead of inline bold runs.',
  'Reserve bold for genuine emphasis, and ask at most one question per turn.',
  // T8 (2026-08-25): this profile prompt is only live on `providerEngine`
  // (engine.ts's PF2.1 test-harness path — production admin chat is
  // permanently on `cmsAgentEngine`, which sends no system field at all, per
  // PF5). The real fix for this defect rides `engine.ts`'s APPROVAL_NOTE
  // (the one per-turn channel Platform controls into Client Manager). This
  // copy is kept in sync anyway so a `providerEngine` run — and any future
  // profile that DOES reach the wire — never regresses to the same bug: an
  // agent that told an editor "approved" / "published" with no proposed
  // privileged tool call, so no approval card ever rendered and nothing
  // actually happened.
  'Never say an approval, publish, or other privileged action is "registered", "recorded", or "done" unless you',
  'propose the matching privileged tool call in the SAME turn. When an editor approves or asks to publish/ship a',
  'workspace run, propose publish_workspace_run. When check_workspace_run_readiness reports no_go, show its',
  'checklist and blockers to the editor verbatim, never paraphrased or summarized.',
].join(' ');

/** Built-in defaults: seeded on first read so the resolver never comes up empty.
 *  Model values are Owner-editable data, not runtime constants. */
export const SEED_PROFILES: AgentProfile[] = [
  {
    profile_id: 'prof_site_default_anthropic',
    name: 'Site Agent (Claude)',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    status: 'active',
    created_by: 'system-seed',
    updated_at: '2026-07-19T00:00:00.000Z',
  },
  {
    profile_id: 'prof_site_default_openai',
    name: 'Site Agent (GPT)',
    provider: 'openai',
    model: 'gpt-5',
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    status: 'active',
    created_by: 'system-seed',
    updated_at: '2026-07-19T00:00:00.000Z',
  },
];

export const emptyProfilesDoc = (at: string): AgentProfilesDoc => ({
  schema_version: 'agent-profiles.v1',
  profiles: Object.fromEntries(SEED_PROFILES.map((profile) => [profile.profile_id, profile])),
  assignments: { objects: {}, types: {}, site_default: 'prof_site_default_anthropic' },
  updated_at: at,
});

/** Read + validate; a missing or corrupt doc resolves to the seeded defaults
 *  (never persisted implicitly — writes happen only through management verbs). */
export const getProfilesDoc = async (store: AgentProfilesStore, nowIso: string): Promise<AgentProfilesDoc> => {
  const raw = await store.get(AGENT_PROFILES_DOC_KEY);
  if (!raw) return emptyProfilesDoc(nowIso);
  try {
    return agentProfilesDocSchema.parse(JSON.parse(raw));
  } catch {
    return emptyProfilesDoc(nowIso);
  }
};

export const putProfilesDoc = async (store: AgentProfilesStore, doc: AgentProfilesDoc): Promise<void> => {
  await store.setJSON(AGENT_PROFILES_DOC_KEY, agentProfilesDocSchema.parse(doc));
};

/**
 * §4a resolution chain: object → type default → site default → first active
 * seed. Disabled profiles are skipped at every level (falling through to the
 * next), so disabling a profile can never strand an object without an agent.
 */
export const resolveProfile = (
  doc: AgentProfilesDoc,
  target: { objectId?: string; objectType?: string }
): AgentProfile => {
  const candidates: (string | undefined)[] = [
    target.objectId ? doc.assignments.objects[target.objectId] : undefined,
    target.objectType ? doc.assignments.types[target.objectType] : undefined,
    doc.assignments.site_default,
  ];
  for (const profileId of candidates) {
    if (!profileId) continue;
    const profile = doc.profiles[profileId];
    if (profile && profile.status === 'active') return profile;
  }
  const fallback = Object.values(doc.profiles).find((profile) => profile.status === 'active');
  return fallback ?? SEED_PROFILES[0]!;
};

export const getAgentProfilesBlobStore = (event: unknown): Promise<AgentProfilesStore> =>
  getNetlifyBlobStore(
    { name: 'agent-profiles', consistency: 'strong' },
    event
  ) as unknown as Promise<AgentProfilesStore>;
