/**
 * Quick-action chip registry (T3.3, design decision D6) — T2.1 left the
 * `resolve` stub here and this fills it in without moving the contract.
 *
 * ## What a chip is allowed to be
 *
 * A chip is a one-click shortcut to a verb that ALREADY EXISTS. Every entry
 * in `QUICK_ACTIONS` names a verb from T0.1 §7's table and nothing else —
 * see `docs/plan/admin-audit.md` §7 for the verb → handler → call-site map
 * this file was written against. Where D6 asked for a chip whose verb does
 * not exist, there is no chip and a comment says why (§"Chips D6 asked for
 * that do not exist" below), because a button that cannot do the thing it
 * is labelled with is worse than an absent one.
 *
 * ## Execution mode follows the parameter count, not taste
 *
 * `executionFor(params)` is the whole rule:
 *
 *   0 params → 'immediate'      run it, toast the receipt
 *   1 param  → 'popover'        one field, then run it
 *   2+       → 'chat-handoff'   prefill the object's chat and let the agent
 *                               ask, offering its options as clickable CTAs
 *                               through the EXISTING controls protocol
 *                               (`chat-controls.ts`, spec in
 *                               `docs/cms-architecture/chat-controls-protocol.md`)
 *
 * "Params" means the values a HUMAN has to supply. Object identity, the lock
 * token and any value the verb documents a default for are machine-supplied
 * and are deliberately not counted — otherwise every lock-taking verb would
 * be a chat hand-off on a technicality.
 *
 * ## Rights: no rights, no chip (deliberately unlike the approval buttons)
 *
 * T2.1's contract, kept: `resolve` receives `roles` and simply omits a chip
 * the caller may not use. It is never built-then-disabled. This is the
 * OPPOSITE of `object-detail-actions.ts`'s rule for the approval controls
 * ("disabled with a reason, never silently absent") and the difference is
 * intended: a decision button is part of a record the reviewer is being
 * asked to act on, so its absence would read as "there is nothing to
 * decide", while a chip is an optional shortcut whose absence reads as
 * nothing at all. The state gates (`appliesTo`) work the same way — a
 * Publish chip on an object with nothing to publish is noise, not
 * information.
 *
 * `rights` here is display-only, exactly like `object-review-ui.ts` and
 * `verbs-client.ts`'s `canExecutePublish`: the server re-derives authority on
 * every call (`publish-gate.ts`, `review-state.ts`). A bug in this file can
 * hide a chip the caller was entitled to; it can never grant a write.
 *
 * ## Chips D6 asked for that do not exist in this repo
 *
 * - **brighten / crop** — there is no image-transform verb anywhere: not in
 *   `object-verbs.ts`'s action union, not in `mcp-tool-definitions.ts`, not
 *   in the admin agent's own registry (`server/lib/agent/tools.ts`). Not a
 *   chip, and not a chat hand-off either — the agent has no such tool, so a
 *   hand-off would just be a dead button with extra steps.
 * - **compress** — same answer, with one near-miss worth recording so the
 *   next reader does not re-derive it: `import_image_from_url` takes a
 *   `max_bytes` cap, and the edit-mode canvas has a browser-side
 *   `downscaleImage` helper (`lib/edit-mode/ui.ts`), but the first is a cap
 *   applied while importing a NEW image from a URL (and is MCP-only — the
 *   admin agent does not have it) and the second is a private closure bound
 *   to that surface's upload input. Neither is "compress the image this
 *   object already uses", and no verb re-encodes stored artifact bytes.
 * - **search / import images** (`search_images`, `import_images_from_url`) —
 *   real MCP tools, but T0.1 §7 records both as having no UI call site AND
 *   no admin-chat tool: "reachable only by an external MCP client with a
 *   scoped token". A chip cannot reach them and neither can the agent a
 *   hand-off would open.
 * - **verify images** (`verify_article_images`) — drlurie-only through the
 *   documented `OPTIONAL_HANDLER_TOOLS` exception (`server/functions/mcp.ts`).
 *   `packages/core` is fleet-shared by four sites (P1/P2): a chip for a tool
 *   that exists on one tenant would need either per-site config or a runtime
 *   capability probe, and both are forbidden here. So it is absent on all
 *   four rather than present-and-broken on three — which is also why this
 *   registry has no per-tenant branch at all.
 * - **retire** — the verb exists but has no admin path (T0.1 §7: "reachable
 *   only via raw MCP", no chat tool). Archiving stays where T2.1 put it:
 *   the bulk selection bar, which does checkout → retire → checkin
 *   explicitly (`bulk-object-ops.ts`).
 *
 * What survives for images is one honest action: **Replace image**, as a
 * chat hand-off, because swapping an image is `get_object` + `patch` and the
 * agent has both — with the approval card still in front of the write.
 */
import type { ObjectType } from '../../schema/object-record-v1.js';
import type { LibraryRow } from './library-logic.js';
import type { VerbCaller, VerbResult } from './bulk-object-ops.js';
import type { UserRole } from './users-client.js';

// ─── shape ──────────────────────────────────────────────────────────────────

export type QuickActionExecution = 'immediate' | 'popover' | 'chat-handoff';

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

/** Values collected from the popover, keyed by param id. */
export type QuickActionValues = Record<string, string>;

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

/** The D6 rule, executable — and the only place execution mode is decided. */
export const executionFor = (params: readonly QuickActionParam[]): QuickActionExecution =>
  params.length === 0 ? 'immediate' : params.length === 1 ? 'popover' : 'chat-handoff';

/**
 * A resolved chip. T2.1's three fields (`id`, `label`, `onSelect`) are
 * unchanged so both existing call sites keep compiling; everything else is
 * what D6 needs the surface to know in order to render the right affordance.
 */
export interface QuickActionChip {
  /** Stable id, unique within one row's chip set (e.g. "publish", "duplicate"). */
  id: string;
  label: string;
  /** Called with nothing else in scope — the resolver already closed over what it needs. */
  onSelect: () => void;
  title: string;
  verb: QuickActionVerb;
  execution: QuickActionExecution;
  rights: readonly QuickActionRight[];
  params: readonly QuickActionParam[];
  /** Set on `chat-handoff` chips only: the prompt the composer is seeded with. */
  prompt?: string;
}

/**
 * How a surface executes a chip. Supplied by the renderer
 * (`admin/QuickActions.tsx`), which owns the popover, the toast and the chat.
 * A context WITHOUT handlers resolves to no chips at all — same doctrine as
 * the rights gate: this module never hands back a button that cannot do
 * anything when it is clicked.
 */
export interface QuickActionHandlers {
  /** `immediate`: run now. `popover` calls this too, once its field is answered. */
  run: (chip: QuickActionChip, values: QuickActionValues) => void;
  /** `popover`: open the single field; the surface calls `run` on confirm. */
  openPopover: (chip: QuickActionChip) => void;
  /** `chat-handoff`: open this object's chat with `chip.prompt` prefilled. */
  handOff: (chip: QuickActionChip) => void;
}

export interface QuickActionContext {
  row: LibraryRow;
  /** The signed-in caller's roles, as `useCurrentUser()` resolves them — for the "no rights, no chip" gate. */
  roles: readonly string[];
  getToken: () => Promise<string>;
  /** Omitted by a surface that only wants to know WHETHER chips exist. */
  handlers?: QuickActionHandlers;
}

export type QuickActionResolver = (context: QuickActionContext) => QuickActionChip[];

export interface QuickActionRegistry {
  resolve: QuickActionResolver;
}

// ─── the chip sets ──────────────────────────────────────────────────────────

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

// ─── the chat hand-off prompt ───────────────────────────────────────────────

/**
 * The prefilled prompt for a `chat-handoff` chip.
 *
 * Two things it deliberately does. It names the object the way the rest of
 * the admin does (display name first, raw id in parentheses — the "no naked
 * ref" rule from `display-name.ts`), and it asks the agent for ONE `controls`
 * block. That last part is the whole reason follow-up options arrive as
 * buttons rather than prose: the block renders through the protocol this
 * repo already shipped (`chat-controls.ts` → `ControlsCard.tsx`), so nothing
 * new is invented here and the editor's pick posts back as an ordinary
 * `Selections [controls:…]` message.
 *
 * It also tells the agent what it CANNOT do. `search_images` /
 * `import_images_from_url` are MCP-only (T0.1 §7) and are not in the admin
 * agent's tool registry, so "find me a new stock photo" is not on the table;
 * the honest offer is media already approved for this publication.
 */
export function buildQuickActionPrompt(definition: QuickActionDefinition, row: LibraryRow): string {
  const subject = `"${row.display_name}" (${row.object_type} ${row.object_id})`;
  if (definition.id === 'replace_image') {
    return [
      `I want to replace an image on ${subject}.`,
      '',
      'Read the object first and list the images it currently references, with where each one sits.',
      'Then offer replacements from media already approved for this publication — you do not have an',
      'image search or import tool, so do not offer to source a new picture from the web.',
      '',
      'Give me the choice as a single `controls` block (one radio field, one option per candidate, stable ids)',
      'so I can pick by clicking. Once I pick, propose the patch that swaps the image and its alt text —',
      'I will see the approval card before anything is written.',
    ].join('\n');
  }
  /* c8 ignore next 2 — unreachable while `replace_image` is the only hand-off. */
  return `I want to ${definition.label.toLowerCase()} on ${subject}. Ask me what you need as a \`controls\` block rather than in prose.`;
}

// ─── resolution ─────────────────────────────────────────────────────────────

const hasRight = (roles: readonly string[], rights: readonly QuickActionRight[]): boolean =>
  rights.some((right) => roles.includes(right));

/** Every definition that this row's type and state admit — before rights. */
export const definitionsForRow = (row: LibraryRow): QuickActionDefinition[] =>
  QUICK_ACTIONS.filter(
    (definition) =>
      (definition.objectType === undefined || definition.objectType.includes(row.object_type)) &&
      definition.appliesTo(row)
  );

/**
 * The registry, filled in. Both call sites (`ObjectsPlane.tsx`,
 * `ObjectWorkspace.tsx`) call this exactly as T2.1 wrote them.
 */
export const DEFAULT_QUICK_ACTION_REGISTRY: QuickActionRegistry = {
  resolve: ({ row, roles, handlers }) => {
    if (!handlers) return [];
    return definitionsForRow(row)
      .filter((definition) => hasRight(roles, definition.rights))
      .map((definition) => {
        const execution = executionFor(definition.params);
        const chip: QuickActionChip = {
          id: definition.id,
          label: definition.label,
          title: definition.title,
          verb: definition.verb,
          execution,
          rights: definition.rights,
          params: definition.params,
          ...(execution === 'chat-handoff' ? { prompt: buildQuickActionPrompt(definition, row) } : {}),
          onSelect: () => {
            if (execution === 'immediate') handlers.run(chip, {});
            else if (execution === 'popover') handlers.openPopover(chip);
            else handlers.handOff(chip);
          },
        };
        return chip;
      });
  },
};

// ─── execution ──────────────────────────────────────────────────────────────

export type QuickActionFailure = 'unsupported' | 'locked' | 'rejected_by_server' | 'transport';

export interface QuickActionResult {
  ok: boolean;
  /** One sentence: what was done, and what changed because of it. */
  receipt: string;
  code?: QuickActionFailure;
  error?: string;
}

const verbError = (result: VerbResult, fallback: string): string => {
  const error = result.body.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (result.status === 423) return 'Someone else holds the edit lock.';
  return fallback;
};

const failed = (code: QuickActionFailure, error: string): QuickActionResult => ({
  ok: false,
  receipt: error,
  code,
  error,
});

/**
 * Take the lock, do the thing, give the lock back.
 *
 * The checkin runs on BOTH paths on purpose. A chip is fired from a row the
 * editor is not sitting in, so a lock left behind after a failed publish is
 * a lock nobody knows to release — the same reasoning (and the same
 * best-effort checkin) as `bulk-object-ops.ts`'s archive. On success the
 * object is likewise handed back: submitting for review or publishing ends
 * the work the lock was protecting.
 */
async function underLock(
  callVerb: VerbCaller,
  row: LibraryRow,
  act: (lockToken: string) => Promise<VerbResult>
): Promise<VerbResult> {
  const checkout = await callVerb({ action: 'checkout', object_type: row.object_type, object_id: row.object_id });
  if (checkout.status !== 200) return checkout;
  const lockToken = checkout.body.lockToken;
  if (typeof lockToken !== 'string' || !lockToken) {
    return { status: 500, body: { error: 'Checkout did not return a lock token.' } };
  }
  try {
    return await act(lockToken);
  } finally {
    await callVerb({
      action: 'checkin',
      object_type: row.object_type,
      object_id: row.object_id,
      lock_token: lockToken,
    }).catch(() => undefined);
  }
}

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * Runs an `immediate` chip, or a `popover` chip once its field is answered.
 * `callVerb` is injected exactly as `bulk-object-ops.ts` injects it, so this
 * whole path is unit-testable with a fake caller — no network, no DOM.
 *
 * Never throws: a transport failure comes back as `{ok: false, code:'transport'}`
 * so the caller always has a receipt to show.
 */
export async function runQuickAction(
  callVerb: VerbCaller,
  chip: Pick<QuickActionChip, 'id' | 'verb' | 'label'>,
  row: LibraryRow,
  values: QuickActionValues = {}
): Promise<QuickActionResult> {
  try {
    switch (chip.verb) {
      case 'object_validate': {
        const result = await callVerb({ action: 'validate', object_type: row.object_type, object_id: row.object_id });
        if (result.status !== 200) return failed('rejected_by_server', verbError(result, 'Validation could not run.'));
        const summary = result.body.summary as { blockers?: unknown; warnings?: unknown } | undefined;
        const blockers = countOf(summary?.blockers ?? result.body.blockers);
        const warnings = countOf(summary?.warnings ?? result.body.warnings);
        return {
          ok: true,
          receipt: blockers
            ? `Validated — ${blockers} blocker${blockers === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'}. It cannot publish until the blockers clear.`
            : warnings
              ? `Validated — no blockers, ${warnings} warning${warnings === 1 ? '' : 's'}.`
              : 'Validated — no blockers and no warnings.',
        };
      }

      case 'object_submit_review': {
        const result = await underLock(callVerb, row, (lockToken) =>
          callVerb({
            action: 'submit_review',
            object_type: row.object_type,
            object_id: row.object_id,
            lock_token: lockToken,
            requested_publish_action: { published_time: 'immediate' },
          })
        );
        if (result.status !== 200) {
          return failed(
            result.status === 423 ? 'locked' : 'rejected_by_server',
            verbError(result, 'The review could not be opened.')
          );
        }
        return {
          ok: true,
          receipt: `Submitted — a review is open on ${row.display_name} and the edit lock is released for the reviewer.`,
        };
      }

      case 'object_publish': {
        // `published_time` is omitted, which the verb reads as "now"
        // (verbs-client.ts's own note). Nothing here can schedule.
        const result = await underLock(callVerb, row, (lockToken) =>
          callVerb({
            action: 'publish_by_time',
            object_type: row.object_type,
            object_id: row.object_id,
            lock_token: lockToken,
          })
        );
        if (result.status !== 200) {
          return failed(
            result.status === 423 ? 'locked' : 'rejected_by_server',
            verbError(result, 'The publish was refused.')
          );
        }
        return {
          ok: true,
          receipt: `Published — ${row.display_name} is committed to the export. It goes live on the next release.`,
        };
      }

      case 'object_create_variant': {
        const dryRun = values.mode === 'preview';
        const result = await callVerb({
          action: 'create_variant',
          object_type: 'content_item',
          source_object_id: row.object_id,
          ...(dryRun ? { dry_run: true } : {}),
        });
        if (result.status !== 200) {
          return failed('rejected_by_server', verbError(result, 'The variant could not be created.'));
        }
        const newId = typeof result.body.object_id === 'string' ? result.body.object_id : 'the new article';
        if (dryRun) {
          const summary = result.body.summary as { blockers?: unknown } | undefined;
          const blockers = countOf(summary?.blockers);
          const available = result.body.id_available !== false;
          return {
            ok: true,
            receipt: blockers
              ? `Previewed — the variant would have ${blockers} blocker${blockers === 1 ? '' : 's'}. Nothing was created.`
              : `Previewed — the variant validates cleanly as ${newId}${available ? '' : ' (that id is already taken)'}. Nothing was created.`,
          };
        }
        return {
          ok: true,
          receipt: `Created — ${newId} is a draft variant of ${row.display_name}. It publishes on its own schedule.`,
        };
      }

      case 'agent_chat':
        // A hand-off is opened, never run. Reaching here means a surface
        // called `run` on a chat chip; say so rather than doing something
        // adjacent.
        return failed('unsupported', `${chip.label} is a conversation with the agent, not a direct verb.`);
    }
  } catch (error) {
    return failed('transport', error instanceof Error ? error.message : 'The action could not be sent.');
  }
}
