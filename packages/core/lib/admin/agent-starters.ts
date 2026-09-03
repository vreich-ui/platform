/**
 * Contextual entry points all route through the existing governed CMS Agent
 * flow. They are prompts, not client-side creation or upload APIs: the agent
 * still proposes every write and the normal approval card remains in charge.
 */
export interface AgentStarter {
  key: 'article' | 'page' | 'section-template' | 'visual-identity' | 'media';
  label: string;
  description: string;
  prompt: string;
  ownerOnly?: boolean;
}

export const AGENT_STARTERS: readonly AgentStarter[] = [
  {
    key: 'article',
    label: 'New article',
    description: 'Draft a content item from an idea — outline, nodes, taxonomy from the registry.',
    prompt:
      'I want a new article. Ask me for the topic and angle, check the taxonomy registry for the right category and tags, then draft it as a content_item (create_object) with a clear node structure. Keep it as a draft — no publishing yet.',
  },
  {
    key: 'page',
    label: 'New page from template',
    description: 'REUSE-FIRST: browse the template recipes, preview, then instantiate.',
    prompt:
      'I want a new page. First list the template recipes in the inventory (REUSE FIRST) and recommend one based on its description/whenToUse. Then propose instantiate_template — I will see the dry-run preview on the approval card before anything is created.',
  },
  {
    key: 'section-template',
    label: 'New section template',
    description: 'Mint a reusable section recipe with the required metadata trio.',
    prompt:
      'I want a new section template (stpl_*). Check the existing recipes in the inventory first so we do not duplicate one. Then draft the blueprint and the REQUIRED description/whenToUse/scope metadata, and propose create_object.',
  },
  {
    // R8: replaces the old `retheme` starter — theme was one third of the
    // wave's one Visual identity surface (identity · imagery · PDF
    // templates, BRIEF §0/§4). `retheme` stays resolvable as an alias (see
    // `agentStarterByKey` below) so links minted before this rename don't die.
    key: 'visual-identity',
    label: 'Visual identity',
    description: 'Review theme, image style and PDF templates; propose changes as dry runs.',
    prompt:
      'I want to review this publication\'s visual identity — theme, image style and PDF templates. List the theme objects and the current visual_standard (house image style), and the PDF templates, then propose changes (apply_theme, brand_imagery_propose, or a PDF template change) as a dry run so I can see the exact diff before deciding. Do not apply anything without my approval.',
    ownerOnly: true,
  },
  {
    key: 'media',
    label: 'Plan media',
    description: 'Plan or generate an approved asset through the publication workflow.',
    prompt:
      'I need media for this publication. First ask what the asset is for and check existing media so we can reuse it where appropriate. If a new asset is needed, propose the governed artifact workflow and wait for approval before generating anything. Do not claim there is a direct browser upload.',
  },
];

export type AgentStarterKey = AgentStarter['key'];

/**
 * R8: `retheme` was renamed `visual-identity` — this keeps `?starter=retheme`
 * (bookmarks, the old `VISUAL_IDENTITY_STARTER_HREF` fallback) resolving to
 * the SAME starter rather than 404-ing into "no starter matched", without
 * showing `retheme` a second time in the starter list itself (`AGENT_STARTERS`
 * carries only the current key).
 */
const STARTER_KEY_ALIASES: Record<string, AgentStarterKey> = { retheme: 'visual-identity' };

export const agentStarterByKey = (key: string | null | undefined): AgentStarter | undefined => {
  if (!key) return undefined;
  const resolved = STARTER_KEY_ALIASES[key] ?? key;
  return AGENT_STARTERS.find((starter) => starter.key === resolved);
};

export const agentStarterHref = (key: AgentStarterKey): string => `/admin/agents?starter=${encodeURIComponent(key)}`;
