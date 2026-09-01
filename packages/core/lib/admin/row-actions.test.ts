/**
 * B1 — the row-actions model, as a matrix.
 *
 * `rowActions` IS the status → actions table, so the test is that table
 * written a second time, independently, and compared: the ordered list of
 * ids with their `kind` (which decides what sits in the row and what falls
 * into the overflow menu), then the `enabled` set for each of the five roles
 * `server/lib/roles.ts` defines. Every status the table names appears here,
 * including the `budget_exceeded` failure and both halves of `done`.
 *
 * Lives beside `request-logic.test.ts` rather than inside it — that file is
 * already 500 lines about filtering, sorting and notifications, and this is
 * one self-contained matrix.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NO_LIVE_PATH,
  publishPolicyFromApproval,
  publishTargetFor,
  PUBLISH_BLOCKED_REASON,
  rowActionRights,
  rowActions,
  type RowActionId,
  type RowActionRowLike,
} from './request-logic.js';
import { canDecideRunPublish } from './decisions.js';
import { runQuickAction } from './quick-actions.js';
import type { VerbCaller } from './bulk-object-ops.js';

type Kind = 'primary' | 'menu';

/** The five tiers, as `users-client.ts` reports them (owner already expanded). */
const ROLES = {
  viewer: ['viewer'],
  editor: ['editor'],
  publisher: ['publisher'],
  admin: ['admin'],
  owner: ['owner', 'admin', 'publisher'],
} as const satisfies Record<string, readonly string[]>;

type RoleName = keyof typeof ROLES;
const ROLE_NAMES = Object.keys(ROLES) as RoleName[];

/** A row with everything attached, so a disabled action is never about missing data. */
const row = (overrides: Partial<RowActionRowLike> & { status: RowActionRowLike['status'] }): RowActionRowLike => ({
  archived: false,
  chat_id: 'chat_1',
  object_id: 'obj_1',
  live_path: '/retinol-after-40',
  mine: true,
  ...overrides,
});

const READ_ONLY: RowActionId[] = ['open_chat', 'open_object'];
/** The read-only set on a published `done` row, which also offers the live page. */
const READ_ONLY_LIVE: RowActionId[] = [...READ_ONLY, 'view_live'];

interface Scenario {
  name: string;
  row: RowActionRowLike;
  /** The full ordered list: id + where it renders. */
  shape: ReadonlyArray<readonly [RowActionId, Kind]>;
  /** Which ids are enabled, per role. Anything not listed must be disabled with a reason. */
  enabled: Record<RoleName, RowActionId[]>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'needs_you',
    row: row({ status: 'needs_you' }),
    shape: [
      ['approve', 'primary'],
      ['reject', 'primary'],
      ['open_chat', 'menu'],
      ['open_object', 'menu'],
      ['mute', 'menu'],
      ['cancel', 'menu'],
      ['archive', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      // Approve/Reject stay on the `publish` tier in the pure model — they
      // answer to the RUN gate, a different endpoint. The component narrows
      // them further via `canDecideRunPublish`; see the last test in this file.
      publisher: ['approve', 'reject', ...READ_ONLY],
      admin: ['approve', 'reject', ...READ_ONLY, 'mute', 'cancel'],
      owner: ['approve', 'reject', ...READ_ONLY, 'mute', 'cancel', 'archive'],
    },
  },
  {
    name: 'failed, no operator action',
    row: row({ status: 'failed' }),
    shape: [
      ['retry', 'primary'],
      ['open_chat', 'primary'],
      ['open_object', 'menu'],
      ['cancel', 'menu'],
      ['archive', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      publisher: READ_ONLY,
      admin: ['retry', ...READ_ONLY, 'cancel'],
      owner: ['retry', ...READ_ONLY, 'cancel', 'archive'],
    },
  },
  {
    name: 'stalled, no operator action',
    row: row({ status: 'stalled' }),
    shape: [
      ['retry', 'primary'],
      ['open_chat', 'primary'],
      ['open_object', 'menu'],
      ['cancel', 'menu'],
      ['archive', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      publisher: READ_ONLY,
      admin: ['retry', ...READ_ONLY, 'cancel'],
      owner: ['retry', ...READ_ONLY, 'cancel', 'archive'],
    },
  },
  {
    name: 'failed, budget_exceeded',
    row: row({ status: 'failed', failure_code: 'budget_exceeded' }),
    shape: [
      ['raise_budget', 'primary'],
      ['open_chat', 'primary'],
      ['open_object', 'menu'],
      ['cancel', 'menu'],
      ['archive', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      // Raising a spend ceiling is Owner-only — a publisher gets the button,
      // disabled, with "Ask an owner" rather than no button at all.
      publisher: READ_ONLY,
      admin: [...READ_ONLY, 'cancel'],
      owner: ['raise_budget', ...READ_ONLY, 'cancel', 'archive'],
    },
  },
  {
    name: 'queued',
    row: row({ status: 'queued' }),
    shape: [
      ['open_chat', 'primary'],
      ['open_object', 'menu'],
      ['mute', 'menu'],
      ['cancel', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      publisher: READ_ONLY,
      admin: [...READ_ONLY, 'mute', 'cancel'],
      owner: [...READ_ONLY, 'mute', 'cancel'],
    },
  },
  {
    name: 'running',
    row: row({ status: 'running' }),
    shape: [
      ['open_chat', 'primary'],
      ['open_object', 'menu'],
      ['mute', 'menu'],
      ['cancel', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      publisher: READ_ONLY,
      admin: [...READ_ONLY, 'mute', 'cancel'],
      owner: [...READ_ONLY, 'mute', 'cancel'],
    },
  },
  {
    name: 'done, object unpublished',
    row: row({ status: 'done', object_published: false }),
    shape: [
      ['publish', 'primary'],
      ['open_object', 'primary'],
      ['open_chat', 'menu'],
      ['archive', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      // Publish is the one mutating row action that does NOT go through the
      // request registry — it dispatches `object_publish`, whose gate is
      // `checkPublishGate` (admin OR publisher). So a publisher keeps it.
      publisher: ['publish', ...READ_ONLY],
      admin: ['publish', ...READ_ONLY],
      owner: ['publish', ...READ_ONLY, 'archive'],
    },
  },
  {
    // C1: the branch that never ran before — nothing supplied `object_published`,
    // so a live article always took the unpublished branch above.
    name: 'done, published',
    row: row({ status: 'done', object_published: true }),
    shape: [
      ['open_object', 'primary'],
      ['view_live', 'primary'],
      ['open_chat', 'menu'],
      ['archive', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY_LIVE,
      editor: READ_ONLY_LIVE,
      publisher: READ_ONLY_LIVE,
      admin: READ_ONLY_LIVE,
      owner: [...READ_ONLY_LIVE, 'archive'],
    },
  },
  {
    name: 'cancelled',
    row: row({ status: 'cancelled' }),
    shape: [
      ['restore', 'primary'],
      ['open_chat', 'menu'],
      ['open_object', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      publisher: READ_ONLY,
      admin: READ_ONLY,
      owner: ['restore', ...READ_ONLY],
    },
  },
  {
    name: 'archived',
    row: row({ status: 'archived', archived: true }),
    shape: [
      ['restore', 'primary'],
      ['open_chat', 'menu'],
      ['open_object', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      publisher: READ_ONLY,
      admin: READ_ONLY,
      owner: ['restore', ...READ_ONLY],
    },
  },
];

const ids = (actions: ReturnType<typeof rowActions>) => actions.map((action) => action.id);

describe('rowActions — the status → actions table', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: offers the right actions, in the right places`, () => {
      // The list does not change with the role — only what is enabled does (D3).
      for (const role of ROLE_NAMES) {
        const actions = rowActions(scenario.row, ROLES[role]);
        assert.deepEqual(
          actions.map((action) => [action.id, action.kind]),
          scenario.shape.map(([id, kind]) => [id, kind]),
          `${scenario.name} / ${role}`
        );
      }
    });

    it(`${scenario.name}: at most two primaries, and one overflow menu's worth of the rest`, () => {
      const actions = rowActions(scenario.row, ROLES.owner);
      assert.ok(
        actions.filter((action) => action.kind === 'primary').length <= 2,
        `${scenario.name} renders more than two primary actions`
      );
      // Primaries come first, so a surface can slice rather than re-sort.
      const firstMenu = actions.findIndex((action) => action.kind === 'menu');
      if (firstMenu >= 0) {
        assert.ok(
          actions.slice(firstMenu).every((action) => action.kind === 'menu'),
          `${scenario.name} interleaves primaries and menu items`
        );
      }
    });

    for (const role of ROLE_NAMES) {
      it(`${scenario.name} / ${role}: exactly the expected actions are enabled`, () => {
        const actions = rowActions(scenario.row, ROLES[role]);
        assert.deepEqual(
          actions.filter((action) => action.enabled).map((action) => action.id).sort(),
          [...scenario.enabled[role]].sort(),
          `${scenario.name} / ${role}`
        );
      });
    }
  }
});

describe('rowActions — D3: a disabled action stays visible, and says why', () => {
  it('every disabled action carries a reason, and no enabled one does', () => {
    for (const scenario of SCENARIOS) {
      for (const role of ROLE_NAMES) {
        for (const action of rowActions(scenario.row, ROLES[role])) {
          if (action.enabled) {
            assert.equal(action.reason, undefined, `${scenario.name}/${role}/${action.id} is enabled but has a reason`);
          } else {
            assert.ok(
              action.reason && action.reason.length > 0,
              `${scenario.name}/${role}/${action.id} is disabled with no reason`
            );
          }
        }
      }
    }
  });

  /**
   * The ladder points a viewer one rung up. The registry seam does not sit
   * on the ladder at all (FIX 3), so an action gated on it says "Ask an
   * admin" to EVERY tier below admin — including a viewer, for whom "Ask an
   * editor" would be a lie: an editor cannot do it either.
   */
  it('a viewer is pointed one rung up, except at the registry seam', () => {
    for (const scenario of SCENARIOS) {
      for (const action of rowActions(scenario.row, ROLES.viewer)) {
        if (action.enabled) continue;
        const expected = action.rightRequired === 'registry' ? 'Ask an admin' : 'Ask an editor';
        assert.equal(action.reason, expected, `${scenario.name}/${action.id}`);
      }
    }
  });

  /**
   * FIX 3 — the seam, stated once. `admin-requests.ts` gates EVERY action it
   * serves on `roles.includes('admin')`, so B1's ladder cannot be the whole
   * truth for anything that posts there. These are the actions that do, and
   * the tiers that used to get a live button that 403'd on the click.
   */
  it('every registry-backed action is admin-or-above, and says "Ask an admin" below that', () => {
    const REGISTRY_BACKED: RowActionId[] = ['retry', 'mute', 'cancel'];
    for (const scenario of SCENARIOS) {
      for (const action of rowActions(scenario.row, ROLES.editor)) {
        if (!REGISTRY_BACKED.includes(action.id)) continue;
        assert.equal(action.rightRequired, 'registry', `${scenario.name}/${action.id}`);
        assert.equal(action.enabled, false, `an editor must not get a live ${action.id} — the endpoint 403s it`);
        assert.equal(action.reason, 'Ask an admin');
      }
      for (const action of rowActions(scenario.row, ROLES.publisher)) {
        if (!REGISTRY_BACKED.includes(action.id)) continue;
        assert.equal(action.enabled, false, `a publisher must not get a live ${action.id} either`);
      }
      // …and an admin does get them, so this is a narrowing, not a blanket ban.
      for (const action of rowActions(scenario.row, ROLES.admin)) {
        if (!REGISTRY_BACKED.includes(action.id)) continue;
        assert.equal(action.enabled, true, `${scenario.name}/${action.id} must stay live for an admin`);
      }
    }
  });

  /**
   * Archive/Restore answer to TWO gates that intersect: the module's `admin`
   * line and `canArchive` (`isOwner || publisher`). A publisher fails the
   * first, a plain admin fails the second — only an Owner clears both.
   */
  it('archive and restore are Owner-only, because two server gates intersect there', () => {
    for (const scenario of SCENARIOS) {
      for (const role of ROLE_NAMES) {
        for (const action of rowActions(scenario.row, ROLES[role])) {
          if (action.id !== 'archive' && action.id !== 'restore') continue;
          assert.equal(action.rightRequired, 'owner', `${scenario.name}/${action.id}`);
          assert.equal(action.enabled, role === 'owner', `${scenario.name}/${role}/${action.id}`);
        }
      }
    }
  });

  it('an editor denied a publish-tier action is told to ask a publisher', () => {
    const actions = rowActions(row({ status: 'needs_you' }), ROLES.editor);
    const approve = actions.find((action) => action.id === 'approve');
    assert.equal(approve?.enabled, false);
    assert.equal(approve?.reason, 'Ask a publisher');
    assert.equal(approve?.rightRequired, 'publish');
  });

  it('a publisher denied the Owner-only budget raise is told to ask an owner', () => {
    const raise = rowActions(row({ status: 'failed', failure_code: 'budget_exceeded' }), ROLES.publisher).find(
      (action) => action.id === 'raise_budget'
    );
    assert.equal(raise?.enabled, false);
    assert.equal(raise?.reason, 'Ask an owner');
    assert.equal(raise?.rightRequired, 'owner');
  });

  it('no role, no roles at all — read stays, everything else is gated', () => {
    const actions = rowActions(row({ status: 'needs_you' }), []);
    assert.deepEqual(
      actions.filter((action) => action.enabled).map((action) => action.id),
      READ_ONLY
    );
  });
});

describe('rowActions — the data, not the rights, can also block an action', () => {
  it('an owner still cannot open a chat or an object that is not there', () => {
    const actions = rowActions(
      { status: 'running', archived: false, mine: true },
      ROLES.owner
    );
    const chat = actions.find((action) => action.id === 'open_chat');
    const object = actions.find((action) => action.id === 'open_object');
    assert.equal(chat?.enabled, false);
    assert.equal(chat?.reason, 'No chat is attached to this request yet.');
    assert.equal(object?.enabled, false);
    assert.equal(object?.reason, 'No object is attached to this request yet.');
  });

  it('a done request with no object offers Publish, disabled, rather than hiding it', () => {
    const publish = rowActions({ status: 'done', archived: false, chat_id: 'c' }, ROLES.owner).find(
      (action) => action.id === 'publish'
    );
    assert.equal(publish?.enabled, false);
    assert.equal(publish?.reason, 'No object is attached to this request yet.');
  });

  /**
   * Cancel has TWO gates. The registry seam is the first (admins only), and
   * the endpoint's own second line is "the creator of this request, or an
   * Owner" — not the publish tier this used to mirror. So an admin who did
   * not start the run and is not an Owner is refused, and must be told so.
   */
  it('an admin may cancel their own run but not someone else’s', () => {
    const own = rowActions(row({ status: 'running', mine: true }), ROLES.admin).find(
      (action) => action.id === 'cancel'
    );
    const theirs = rowActions(row({ status: 'running', mine: false }), ROLES.admin).find(
      (action) => action.id === 'cancel'
    );
    assert.equal(own?.enabled, true);
    assert.equal(theirs?.enabled, false);
    assert.equal(theirs?.reason, 'Only the editor who asked for this, or an Owner');
  });

  it('an Owner may cancel anyone’s run', () => {
    const theirs = rowActions(row({ status: 'running', mine: false }), ROLES.owner).find(
      (action) => action.id === 'cancel'
    );
    assert.equal(theirs?.enabled, true);
  });

  it('an unknown owner (`mine` absent) fails closed for an admin, and never for an Owner', () => {
    const admin = rowActions({ status: 'running', archived: false, chat_id: 'c' }, ROLES.admin).find(
      (action) => action.id === 'cancel'
    );
    const owner = rowActions({ status: 'running', archived: false, chat_id: 'c' }, ROLES.owner).find(
      (action) => action.id === 'cancel'
    );
    assert.equal(admin?.enabled, false);
    assert.equal(owner?.enabled, true);
  });

  it('the rights seam beats the ownership one: an editor’s OWN run still cannot be cancelled from here', () => {
    const own = rowActions(row({ status: 'running', mine: true }), ROLES.editor).find(
      (action) => action.id === 'cancel'
    );
    assert.equal(own?.enabled, false, 'the registry endpoint 403s an editor whatever the row says');
    assert.equal(own?.reason, 'Ask an admin');
  });

  it('archived wins over the status it was archived at', () => {
    assert.deepEqual(ids(rowActions(row({ status: 'needs_you', archived: true }), ROLES.owner)), [
      'restore',
      'open_chat',
      'open_object',
    ]);
  });

  it('Mute reads Unmute once this person has muted the row', () => {
    const label = (muted: boolean) =>
      rowActions(row({ status: 'running', muted }), ROLES.editor).find((action) => action.id === 'mute')?.label;
    assert.equal(label(false), 'Mute');
    assert.equal(label(true), 'Unmute');
  });
});

// ─── C1: the row knows whether its object is published ───────────────────────

/**
 * The three shapes a finished row can have, and what each offers. The inputs
 * come from the index row now (`object_published`, `live_path`, projected from
 * the run's own publish receipts in `server/lib/requests/store.ts`); before C1
 * nothing supplied them, so every `done` row — published or not — rendered the
 * unpublished branch, and a live article's Open object sat disabled with "No
 * object attached".
 */
describe('C1 — a finished row, in its three states', () => {
  const actionsFor = (over: Partial<RowActionRowLike>) =>
    rowActions({ status: 'done', archived: false, chat_id: 'chat_1', ...over }, ROLES.owner);
  const find = (over: Partial<RowActionRowLike>, id: RowActionId) =>
    actionsFor(over).find((action) => action.id === id);

  it('published, live: Open object and View live, both enabled, and no Publish', () => {
    const over = { object_id: 'obj_1', object_published: true, live_path: '/retinol-after-40' };
    assert.deepEqual(ids(actionsFor(over)), ['open_object', 'view_live', 'open_chat', 'archive']);
    assert.equal(find(over, 'open_object')?.enabled, true);
    assert.equal(find(over, 'view_live')?.enabled, true);
    assert.equal(find(over, 'publish'), undefined, 'a published article is not owed a Publish');
  });

  it('published, go-live unconfirmed: View live stays, disabled, and says why (D3)', () => {
    const over = { object_id: 'obj_1', object_published: true };
    assert.deepEqual(ids(actionsFor(over)), ['open_object', 'view_live', 'open_chat', 'archive']);
    assert.equal(find(over, 'open_object')?.enabled, true);
    assert.equal(find(over, 'view_live')?.enabled, false);
    assert.equal(find(over, 'view_live')?.reason, NO_LIVE_PATH);
  });

  it('unpublished: Publish is the primary and Open object still opens the record', () => {
    const over = { object_id: 'obj_1', object_published: false };
    assert.deepEqual(ids(actionsFor(over)), ['publish', 'open_object', 'open_chat', 'archive']);
    assert.equal(find(over, 'publish')?.enabled, true);
    assert.equal(find(over, 'open_object')?.enabled, true);
    assert.equal(find(over, 'view_live'), undefined, 'nothing is live, so there is nothing to view');
  });

  it('no object at all: both stay visible, disabled, with the honest reason', () => {
    const over = {};
    assert.deepEqual(ids(actionsFor(over)), ['publish', 'open_object', 'open_chat', 'archive']);
    for (const id of ['publish', 'open_object'] as const) {
      assert.equal(find(over, id)?.enabled, false, id);
      assert.equal(find(over, id)?.reason, 'No object is attached to this request yet.', id);
    }
  });

  it('an unknown publication state is treated as unpublished, never as live', () => {
    // Guardrail 5 at the row: a server deployed before C1 sends no
    // `object_published`, and the honest read of "we cannot tell" is the
    // branch that offers the action, not the one that claims the state.
    assert.deepEqual(ids(actionsFor({ object_id: 'obj_1' })), ['publish', 'open_object', 'open_chat', 'archive']);
  });

  it('the publish gate is untouched by any of this: an editor still cannot publish', () => {
    const publish = rowActions(
      { status: 'done', archived: false, chat_id: 'chat_1', object_id: 'obj_1', object_published: false },
      ROLES.editor,
      { publishPolicy: 'auto' }
    ).find((action) => action.id === 'publish');
    assert.equal(publish?.enabled, false);
    assert.equal(publish?.reason, 'Ask a publisher');
  });
});


describe('rowActionRights — the ladder', () => {
  it('is additive: publish implies edit, owner implies publish', () => {
    for (const role of ROLE_NAMES) {
      const rights = rowActionRights(ROLES[role]);
      assert.equal(rights.read, true, `${role} must always be able to read`);
      if (rights.owner) assert.equal(rights.publish, true, `${role}: owner must imply publish`);
      if (rights.publish) assert.equal(rights.edit, true, `${role}: publish must imply edit`);
    }
  });

  it('maps each tier to what the table says it may do', () => {
    const r = (over: Partial<ReturnType<typeof rowActionRights>>) => ({
      read: true,
      edit: false,
      publish: false,
      registry: false,
      owner: false,
      ...over,
    });
    assert.deepEqual(rowActionRights(ROLES.viewer), r({}));
    assert.deepEqual(rowActionRights(ROLES.editor), r({ edit: true }));
    assert.deepEqual(rowActionRights(ROLES.publisher), r({ edit: true, publish: true }));
    // The seam: a publisher may publish but may not reach the registry; an
    // admin may reach the registry but is not an Owner.
    assert.deepEqual(rowActionRights(ROLES.admin), r({ edit: true, publish: true, registry: true }));
    assert.deepEqual(rowActionRights(ROLES.owner), r({ edit: true, publish: true, registry: true, owner: true }));
  });
});


// ─── B3: the publish posture ─────────────────────────────────────────────────

/**
 * The row's Publish gate, which has three inputs and only three: the caller's
 * tier, whether an object is attached, and the client's publish posture.
 * (Whether the object is already live is the fourth, and `rowActions` already
 * answers it by not offering Publish at all — the `done, published` scenario
 * in the matrix above.)
 */
describe('B3 — Publish on a finished run', () => {
  const done = row({ status: 'done', object_published: false });
  const publishOf = (roles: readonly string[], policy?: Parameters<typeof rowActions>[2]) =>
    rowActions(done, roles, policy).find((action) => action.id === 'publish');

  it('a publisher gets it, live', () => {
    const publish = publishOf(ROLES.publisher, { publishPolicy: 'auto' });
    assert.equal(publish?.enabled, true);
    assert.equal(publish?.kind, 'primary');
    assert.equal(publish?.rightRequired, 'publish');
  });

  it('an editor gets it disabled, with the reason', () => {
    const publish = publishOf(ROLES.editor, { publishPolicy: 'auto' });
    assert.equal(publish?.enabled, false);
    assert.equal(publish?.reason, 'Ask a publisher');
  });

  it('a blocked client disables it for everyone, with the policy reason', () => {
    for (const role of ['publisher', 'admin', 'owner'] as const) {
      const publish = publishOf(ROLES[role], { publishPolicy: 'block' });
      assert.equal(publish?.enabled, false, role);
      assert.equal(publish?.reason, PUBLISH_BLOCKED_REASON, role);
    }
  });

  it('a blocked client still tells an editor the nearer truth — the tier they lack', () => {
    assert.equal(publishOf(ROLES.editor, { publishPolicy: 'block' })?.reason, 'Ask a publisher');
  });

  it('a manual client still offers it — the record’s approval lives on the object, and the server gate decides', () => {
    assert.equal(publishOf(ROLES.publisher, { publishPolicy: 'manual' })?.enabled, true);
  });

  it('no options at all means `auto` — a caller with no policy never blanks a publisher’s action', () => {
    assert.equal(publishOf(ROLES.publisher)?.enabled, true);
    assert.equal(publishOf(ROLES.publisher, {})?.enabled, true);
  });

  it('a blocked client cannot resurrect Publish on a row that is already live', () => {
    const published = rowActions(row({ status: 'done', object_published: true }), ROLES.owner, {
      publishPolicy: 'block',
    });
    assert.equal(
      published.find((action) => action.id === 'publish'),
      undefined
    );
  });

  it('maps the approval policy’s one boolean onto the posture — and never onto `block`', () => {
    assert.equal(publishPolicyFromApproval(false), 'auto');
    assert.equal(publishPolicyFromApproval(true), 'manual');
  });

  /**
   * B1 flagged the mismatch; B3 resolves it by SCOPING the mirror rather than
   * widening it. `canDecideRunPublish` mirrors one server line — the run
   * gate's `can_approve` (`roles.includes('admin')`) — so it narrows
   * Approve/Reject only. The row's Publish answers to a different server gate
   * (`checkPublishGate`: admin OR publisher), which is exactly the `publish`
   * tier `rowActions` applies. A publisher must therefore see a live Publish
   * and a disabled Approve at the same time, both truthfully.
   */
  it('a publisher gets a live Publish and no run-gate decision — two gates, not one', () => {
    assert.equal(canDecideRunPublish(ROLES.publisher), false, 'the run gate is admin-only server-side');
    assert.equal(publishOf(ROLES.publisher, { publishPolicy: 'auto' })?.enabled, true);
    assert.equal(canDecideRunPublish(ROLES.admin), true);
  });
});


/**
 * The one integration-style proof this repo's stack supports for B3: no DOM,
 * a faked verb caller, and the REAL `runQuickAction` publish path the inbox
 * dispatches into — over the SAME `publishTargetFor` row the component
 * builds, so this cannot pass while the surface drifts. What that path does
 * with the lock (checkout → publish_by_time → checkin, given back on both
 * paths) is `quick-actions.test.ts`'s subject and is not re-proved here.
 */
describe('B3 — the row publishes through the existing object path', () => {
  const inboxRow = { object_id: 'art_retinol', title: 'Retinol after 40', updated_at: '2026-08-22T12:00:00.000Z' };

  it('names the request’s own object, as an article, and takes the lock path', async () => {
    const target = publishTargetFor(inboxRow);
    assert.ok(target);
    assert.equal(target.object_type, 'content_item');
    assert.equal(target.object_id, 'art_retinol');

    const calls: Array<Record<string, unknown>> = [];
    const callVerb: VerbCaller = async (body) => {
      calls.push(body);
      if (body.action === 'checkout') return { status: 200, body: { lockToken: 'lock_1' } };
      return { status: 200, body: { published: true } };
    };

    const result = await runQuickAction(callVerb, { id: 'publish', verb: 'object_publish', label: 'Publish' }, target);
    assert.equal(result.ok, true);
    assert.deepEqual(
      calls.map((call) => call.action),
      ['checkout', 'publish_by_time', 'checkin']
    );
    assert.equal(calls[1]?.object_id, 'art_retinol');
    assert.equal(calls[1]?.object_type, 'content_item');
    // OQ-2: nothing on this surface can schedule a publish.
    assert.equal('published_time' in (calls[1] ?? {}), false);
    assert.match(result.receipt, /Retinol after 40/);
  });

  it('a request with no object attached has nothing to publish', () => {
    assert.equal(publishTargetFor({ title: 'No object yet', updated_at: '2026-08-22T12:00:00.000Z' }), undefined);
  });
});
