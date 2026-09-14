/**
 * ASV2-W5 — the quick-action REGISTRY, as a leaf module.
 *
 * Split out of `quick-actions.ts` (which re-exports every name below, so no
 * call site changed) for the reason recorded as "THE CUT" in
 * `tests/netlify/function-bundle-budget.test.ts`'s header:
 * `ui-capabilities.ts` builds chat-controls protocol §7's manifest out of
 * `QUICK_ACTIONS`, and SERVER code (`server/lib/agent/engine.ts`) imports it.
 * The budget counts SOURCE bytes, so that one edge charged `admin-agent-chat`
 * the whole of `quick-actions.ts` — its execution half (`runQuickAction`,
 * `underLock`, the receipt copy), its chat-handoff prompt builders and its
 * prose — plus `inventory-chat.ts`, which the server never reaches.
 *
 * The alternative to the split is a second copy of the verb list on the
 * server, which is exactly the drift §6.4's offered-verb gate exists to
 * prevent. So: ONE registry, declared here, re-exported there.
 *
 * NOTHING WITH A RUNTIME IMPORT BELONGS IN THIS FILE. Every import below is
 * `import type`, which is what keeps it off the server's module graph
 * beyond its own bytes. Adding a value import here re-opens the edge.
 */
import type { ObjectType } from '../../schema/object-record-v1.js';
import type { LibraryRow } from './library-logic.js';
import type { UserRole } from './users-client.js';

/** Every verb a chip may name. `agent_chat` is the hand-off: no single verb,
 *  the agent picks its own under the normal approval pause. */
export type QuickActionVerb =
  | 'object_validate'
  | 'object_submit_review'
  | 'object_publish'
  | 'object_create_variant'
  | 'agent_chat';

/** Roles as `users-client.ts` reports them (server `roles.ts`), minus
 *  `viewer` — read-only, so it never appears in any chip's `rights`. Derived
 *  from that ONE source rather than re-typed, so a renamed tier breaks the
 *  build here instead of drifting quietly (B1). */
export type QuickActionRight = Exclude<UserRole, 'viewer'>;

/**
 * The popover's single field. Only `choice` exists because only one verb in
 * this repo takes exactly one human-supplied parameter and that parameter is
 * enumerable (`object_create_variant`'s `dry_run`). D6 also sketched a
 * slider for a level and a short text input; both are omitted rather than
 * written speculatively, since the verbs that would have used them
 * (image compression levels, a free-text single argument) do not exist —
 * see the header. Adding a kind is a two-line change when a verb earns it.
 */
export interface QuickActionChoiceField {
  kind: 'choice';
  options: ReadonlyArray<{ value: string; label: string; hint?: string }>;
  /** Pre-selected option value; must match one of `options`. */
  value: string;
}

export type QuickActionField = QuickActionChoiceField;

/**
 * One thing a human has to answer before the verb can run.
 *
 * `field` is present only when the answer is collectable in a popover. A
 * hand-off chip lists its params WITHOUT fields on purpose: they are the
 * record of why this action is ambiguous (and what the agent will have to
 * ask about), not a form nobody is going to render.
 */
export interface QuickActionParam {
  id: string;
  label: string;
  field?: QuickActionField;
}

/**
 * One registry entry. `objectType` omitted means "every governed type";
 * `appliesTo` is the state gate (a chip that cannot apply right now is
 * absent for the same reason a chip without rights is).
 */
export interface QuickActionDefinition {
  id: string;
  label: string;
  /** Tooltip — what this chip is about to do, in one line. */
  title: string;
  objectType?: readonly ObjectType[];
  verb: QuickActionVerb;
  rights: readonly QuickActionRight[];
  params: readonly QuickActionParam[];
  appliesTo: (row: LibraryRow) => boolean;
}

/** Types that carry images in their bodies — the only ones offered a replace. */
const IMAGE_BEARING: readonly ObjectType[] = ['content_item', 'page', 'product'];

/** Any role with standing to move a record along (server `roles.ts`'s REVIEW_ROLES). */
const EDITORIAL: readonly QuickActionRight[] = ['owner', 'admin', 'publisher', 'editor'];

/** Display-only mirror of `roles.ts`'s `canExecutePublish` (+ owner, who holds admin). */
const PUBLISHING: readonly QuickActionRight[] = ['owner', 'admin', 'publisher'];

export const QUICK_ACTIONS: readonly QuickActionDefinition[] = [
  {
    id: 'validate',
    label: 'Validate',
    title: 'Run the contract checks against this record and report blockers and warnings.',
    verb: 'object_validate',
    rights: EDITORIAL,
    // `object_validate` takes no lock and no human parameter (T0.1 §7;
    // `ObjectWorkspace.tsx` and `bulk-object-ops.ts` already call it bare).
    params: [],
    appliesTo: (row) => row.status === 'active',
  },
  {
    id: 'submit_review',
    label: 'Submit for review',
    title: 'Open a review on this revision so a reviewer can approve or ask for changes.',
    verb: 'object_submit_review',
    rights: EDITORIAL,
    // The lock token is machine-supplied and `requested_publish_action`
    // is fixed at `immediate` — the same pair `EditSession.submitReview()`
    // sends — so there is nothing for a human to fill in.
    params: [],
    appliesTo: (row) =>
      row.status === 'active' && (row.review_state === 'none' || row.review_state === 'changes_requested'),
  },
  {
    id: 'publish',
    label: 'Publish',
    title: 'Commit this draft to the export (a release is still a separate, explicit step).',
    verb: 'object_publish',
    rights: PUBLISHING,
    // `published_time` looks like a parameter and is not one: `object-publish.ts`
    // rejects a future stamp (OQ-2, "publish immediately or not at all") and
    // rejects `null` (no unpublish), which leaves "now" as the only honest
    // choice. A timing popover here would be a picker for one option.
    params: [],
    appliesTo: (row) =>
      row.status === 'active' && row.review_state !== 'open' && (!row.published_time || row.unpublished_changes),
  },
  {
    id: 'new_variant',
    label: 'New variant',
    title: 'Clone this article as a draft variant — preview it first, or create it now.',
    objectType: ['content_item'],
    verb: 'object_create_variant',
    rights: EDITORIAL,
    // The one genuinely single-parameter verb in the repo: `create_variant`
    // mints the slug itself (`<slug> variant`) and takes the lock-free create
    // path, so `dry_run` is the only thing left to ask — and it is
    // enumerable, which is what makes this the popover's canonical case.
    params: [
      {
        id: 'mode',
        label: 'Create the variant, or preview it first?',
        field: {
          kind: 'choice',
          value: 'create',
          options: [
            { value: 'create', label: 'Create the variant', hint: 'A new draft article, lineage back to this one.' },
            { value: 'preview', label: 'Preview only', hint: 'Validate the would-be variant; write nothing.' },
          ],
        },
      },
    ],
    appliesTo: (row) => row.status === 'active',
  },
  {
    id: 'replace_image',
    label: 'Replace image',
    title: 'Ask the agent to swap an image on this object for one already approved here.',
    objectType: IMAGE_BEARING,
    verb: 'agent_chat',
    rights: EDITORIAL,
    // Three answers are needed before anything can be patched — WHICH image,
    // WHAT to put there, and the replacement's alt text — and the second is
    // open-ended. That is the ambiguous case D6 sends to chat, where the
    // agent can enumerate candidates as clickable CTAs instead of making the
    // editor describe one in prose.
    params: [
      { id: 'image', label: 'Which image on this object' },
      { id: 'replacement', label: 'What to put there' },
      { id: 'alt', label: "The replacement's alt text" },
    ],
    appliesTo: (row) => row.status === 'active',
  },
];
