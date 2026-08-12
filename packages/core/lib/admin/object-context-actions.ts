export type ObjectFocusKind = 'object' | 'section' | 'new-section' | 'navigation-item' | 'pdf-template' | 'image';

export interface ObjectActionContext {
  focusKind: ObjectFocusKind;
  focusLabel: string;
  parentLabel?: string;
  itemCount?: number;
  repeatable?: boolean;
}

export interface ObjectContextAction {
  id: string;
  label: string;
  appliesTo: ObjectFocusKind[];
  choices?: string[];
  buildContext: (context: ObjectActionContext, choice?: string) => string;
  icon?: string;
  visible?: (context: ObjectActionContext) => boolean;
}

const focusedSection = (context: ObjectActionContext): string =>
  `the “${context.focusLabel}” section${context.parentLabel ? ` on ${context.parentLabel}` : ''}`;

export const SECTION_CONTEXT_ACTIONS: ObjectContextAction[] = [
  {
    id: 'add-cta',
    label: 'Add CTA',
    appliesTo: ['section'],
    buildContext: (context) =>
      `Add a clear call to action to ${focusedSection(context)}. Keep it consistent with the publication voice and the section’s purpose.`,
  },
  {
    id: 'remove-cta',
    label: 'Remove CTA',
    appliesTo: ['section'],
    buildContext: (context) =>
      `Remove the call to action from ${focusedSection(context)} while keeping the remaining content coherent.`,
  },
  {
    id: 'add-item',
    label: 'Add another item',
    appliesTo: ['section'],
    visible: (context) => context.repeatable === true,
    buildContext: (context) =>
      `Add one useful item to the repeatable collection in ${focusedSection(context)}. Match the existing structure and tone.`,
  },
  {
    id: 'reduce-items',
    label: 'Reduce items',
    appliesTo: ['section'],
    visible: (context) => context.repeatable === true && (context.itemCount ?? 0) > 1,
    buildContext: (context) =>
      `Reduce the repeatable collection in ${focusedSection(context)} from ${context.itemCount ?? 'its current number of'} items to ${Math.max(1, (context.itemCount ?? 2) - 1)}. Keep the strongest material.`,
  },
  {
    id: 'more-concise',
    label: 'More concise',
    appliesTo: ['section'],
    buildContext: (context) => `Make ${focusedSection(context)} more concise without losing essential meaning.`,
  },
  {
    id: 'more-educational',
    label: 'More educational',
    appliesTo: ['section'],
    buildContext: (context) =>
      `Make ${focusedSection(context)} more educational, clear, and useful for the intended reader.`,
  },
  {
    id: 'more-persuasive',
    label: 'More persuasive',
    appliesTo: ['section'],
    buildContext: (context) =>
      `Make ${focusedSection(context)} more persuasive while staying accurate and consistent with the publication voice.`,
  },
];

const focusedAsset = (context: ObjectActionContext): string => `“${context.focusLabel}”`;

export const PDF_TEMPLATE_CONTEXT_ACTIONS: ObjectContextAction[] = [
  {
    id: 'pdf-more-visual',
    label: 'More visual',
    appliesTo: ['pdf-template'],
    buildContext: (context) => `Make ${focusedAsset(context)} more visual while keeping the information clear.`,
  },
  {
    id: 'pdf-more-text',
    label: 'More text',
    appliesTo: ['pdf-template'],
    buildContext: (context) => `Give ${focusedAsset(context)} more room for useful explanatory text.`,
  },
  {
    id: 'pdf-stronger-branding',
    label: 'Stronger branding',
    appliesTo: ['pdf-template'],
    buildContext: (context) => `Strengthen the publication’s visual identity in ${focusedAsset(context)}.`,
  },
  {
    id: 'pdf-softer-branding',
    label: 'Softer branding',
    appliesTo: ['pdf-template'],
    buildContext: (context) => `Make the branding in ${focusedAsset(context)} quieter and more restrained.`,
  },
  {
    id: 'pdf-more-whitespace',
    label: 'More whitespace',
    appliesTo: ['pdf-template'],
    buildContext: (context) => `Add more whitespace to ${focusedAsset(context)} without losing essential content.`,
  },
  {
    id: 'pdf-shorten',
    label: 'Shorten',
    appliesTo: ['pdf-template'],
    buildContext: (context) => `Shorten ${focusedAsset(context)} and keep the strongest material.`,
  },
];

export const IMAGE_CONTEXT_ACTIONS: ObjectContextAction[] = [
  {
    id: 'image-editorial',
    label: 'More editorial',
    appliesTo: ['image'],
    buildContext: (context) => `Make ${focusedAsset(context)} feel more editorial and publication-led.`,
  },
  {
    id: 'image-product',
    label: 'More product-focused',
    appliesTo: ['image'],
    buildContext: (context) => `Make the product the clearer focus in ${focusedAsset(context)}.`,
  },
  {
    id: 'image-clinical',
    label: 'More clinical',
    appliesTo: ['image'],
    buildContext: (context) => `Make ${focusedAsset(context)} feel more clinical, credible, and restrained.`,
  },
  {
    id: 'image-lifestyle',
    label: 'More lifestyle',
    appliesTo: ['image'],
    buildContext: (context) => `Make ${focusedAsset(context)} feel more natural and lifestyle-oriented.`,
  },
];

export const OBJECT_CONTEXT_ACTIONS: ObjectContextAction[] = [
  ...SECTION_CONTEXT_ACTIONS,
  ...PDF_TEMPLATE_CONTEXT_ACTIONS,
  ...IMAGE_CONTEXT_ACTIONS,
];

export const contextActionsFor = (
  context: ObjectActionContext,
  registry: readonly ObjectContextAction[] = OBJECT_CONTEXT_ACTIONS
): ObjectContextAction[] =>
  registry.filter(
    (action) => action.appliesTo.includes(context.focusKind) && (action.visible ? action.visible(context) : true)
  );

const REPEATABLE_KEYS = ['items', 'cards', 'milestones', 'logos', 'columns', 'rows', 'stats'] as const;

/** Count only known editor-facing collections; arbitrary arrays are not assumed to be repeatable content. */
export const repeatableItemCount = (section: unknown): number | undefined => {
  if (!section || typeof section !== 'object') return undefined;
  const bag = section as Record<string, unknown>;
  const data = bag.data && typeof bag.data === 'object' ? (bag.data as Record<string, unknown>) : bag;
  for (const key of REPEATABLE_KEYS) {
    if (Array.isArray(data[key])) return data[key].length;
  }
  const source = data.source && typeof data.source === 'object' ? (data.source as Record<string, unknown>) : undefined;
  if (source) {
    if (Array.isArray(source.items)) return source.items.length;
    if (Array.isArray(source.cards)) return source.cards.length;
  }
  return undefined;
};

export const NEW_SECTION_COMPOSER_SEED = 'Add a new section to this page. What should this section accomplish?';
export const NEW_NAV_ITEM_COMPOSER_SEED =
  'Add a new navigation item. Where should this item lead, and what should it say?';

export interface PendingProposalLike {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export const isNewPageSectionProposal = (
  pending: PendingProposalLike | undefined,
  pageId: string,
  existingSectionIds: ReadonlySet<string>
): boolean => {
  if (!pending) return false;
  if (pending.tool === 'instantiate_section_template') {
    const target = pending.args.target as Record<string, unknown> | undefined;
    return target?.kind === 'page' && target.page_id === pageId;
  }
  if (pending.tool !== 'patch' || pending.args.object_type !== 'page' || pending.args.object_id !== pageId)
    return false;
  const ops = Array.isArray(pending.args.ops) ? pending.args.ops : [];
  return ops.some((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const op = raw as Record<string, unknown>;
    if (op.op !== 'upsert_section' || !op.section || typeof op.section !== 'object') return false;
    const id = (op.section as Record<string, unknown>).id;
    return typeof id === 'string' && !existingSectionIds.has(id);
  });
};

/** Local double-submit guard; the server remains authoritative and also consumes a pending call only once. */
export const createApprovalClaim = () => {
  const claimed = new Set<string>();
  return {
    claim(callId: string): boolean {
      if (claimed.has(callId)) return false;
      claimed.add(callId);
      return true;
    },
    release(callId: string): void {
      claimed.delete(callId);
    },
    /** Read-only membership check — does not claim. Drives UI interactivity without mutating state. */
    has(callId: string): boolean {
      return claimed.has(callId);
    },
  };
};
