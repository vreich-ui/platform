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
  NOT_IN_LIBRARY,
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

/**
 * A row with everything attached, so a disabled action is never about missing
 * data. W21.1: "everything" now includes the probe having CONFIRMED the
 * platform record — `object_id` alone is what the Open object bug was built
 * on, and a fixture that stopped at it would quietly re-file every `done`
 * scenario below as a data problem.
 */
const row = (overrides: Partial<RowActionRowLike> & { status: RowActionRowLike['status'] }): RowActionRowLike => ({
  archived: false,
  chat_id: 'chat_1',
  object_id: 'obj_1',
  object_in_library: true,
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
    // W21.3: the live symptom — published, and the release never confirmed a
    // URL. View live stays disabled with its reason (C1), and the row now also
    // offers the thing that would produce one.
    name: 'done, published, go-live unconfirmed',
    row: {
      status: 'done',
      archived: false,
      chat_id: 'chat_1',
      object_id: 'obj_1',
      object_in_library: true,
      object_published: true,
      mine: true,
    },
    shape: [
      ['open_object', 'primary'],
      // W21.3: Release takes the slot, because View live is dead until it runs
      // — the action belongs in the same row as the problem (Wave 1).
      ['release', 'primary'],
      ['view_live', 'menu'],
      ['open_chat', 'menu'],
      ['archive', 'menu'],
    ],
    enabled: {
      viewer: READ_ONLY,
      editor: READ_ONLY,
      // The release endpoint's gate is `roles.includes('admin')`, which the
      // publish tier does not reach — so a publisher gets it disabled, not a
      // live button that 403s.
      publisher: READ_ONLY,
      admin: [...READ_ONLY, 'release'],
      owner: [...READ_ONLY, 'release', 'archive'],
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
  it('a viewer is pointed one rung up, except at the admin-gated seams', () => {
    for (const scenario of SCENARIOS) {
      for (const action of rowActions(scenario.row, ROLES.viewer)) {
        if (action.enabled) continue;
        // `read` is unconditional, so anything blocked there is blocked by a
        // FACT about the row (no live URL yet, not in the library) — true
        // whoever is looking, and never a rung to climb.
        if (action.rightRequired === 'read') continue;
        // W21.3 adds a second seam of the same shape (`admin`, the release
        // endpoint) — neither sits on the ladder, so neither may be answered
        // with a rung.
        const offLadder = action.rightRequired === 'registry' || action.rightRequired === 'admin';
        assert.equal(action.reason, offLadder ? 'Ask an admin' : 'Ask an editor', `${scenario.name}/${action.id}`);
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
    rowActions(
      // W21.1: these cases are about PUBLICATION, so library presence is held
      // confirmed throughout and varied on its own below.
      { status: 'done', archived: false, chat_id: 'chat_1', object_in_library: true, ...over },
      ROLES.owner
    );
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
    // W21.3 trades the two places: see that block below.
    assert.deepEqual(ids(actionsFor(over)), ['open_object', 'release', 'view_live', 'open_chat', 'archive']);
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


// ─── W21.1: Open object may only believe the probe ──────────────────────────

/**
 * The bug: two `done` rows offered an ENABLED Open object that landed on
 * "Couldn't open this object — not found". `sweep.ts` writes `object_id` when
 * `article_body` completes — but that draft is a CMS-Agent stage output and
 * the platform record only exists after a publish, so the field the action was
 * gated on proves the run named an object, never that the library holds one.
 *
 * The matrix is the three answers the probe can give, crossed with the two
 * halves of `done`. `publish` is in every case on purpose: it is the step that
 * MAKES the record, so it must never be taken away by the same doubt that
 * disables the link.
 */
describe('W21.1 — a finished row opens its object only when the library was checked', () => {
  const done = (over: Partial<RowActionRowLike>) =>
    rowActions({ status: 'done', archived: false, chat_id: 'chat_1', object_id: 'obj_1', ...over }, ROLES.owner);
  const find = (over: Partial<RowActionRowLike>, id: RowActionId) => done(over).find((action) => action.id === id);

  /** probe answer → what `open_object` must do, on each half of `done`. */
  const PROBE = [
    { name: 'confirmed', over: { object_in_library: true }, opens: true },
    { name: 'says absent', over: { object_in_library: false }, opens: false },
    { name: 'never probed', over: {}, opens: false },
  ] as const;

  for (const probe of PROBE) {
    for (const published of [false, true]) {
      const over = { ...probe.over, object_published: published };
      const half = published ? 'published' : 'unpublished';

      it(`${half}, probe ${probe.name}: Open object is ${probe.opens ? 'live' : 'disabled with the reason'}`, () => {
        const openObject = find(over, 'open_object');
        assert.equal(openObject?.enabled, probe.opens);
        assert.equal(openObject?.reason, probe.opens ? undefined : NOT_IN_LIBRARY);
        // D3: never dropped, whatever the answer — an operator must be able to
        // see that opening it is a thing that exists, and why it cannot.
        assert.equal(openObject?.kind, 'primary');
      });
    }

    it(`unpublished, probe ${probe.name}: Publish is untouched — it is what creates the record`, () => {
      const publish = find({ ...probe.over, object_published: false }, 'publish');
      assert.equal(publish?.enabled, true);
      assert.equal(publish?.kind, 'primary');
    });
  }

  it('unconfirmed leaves Publish the only live primary, which is the next step the reason names', () => {
    const live = done({ object_published: false })
      .filter((action) => action.kind === 'primary' && action.enabled)
      .map((action) => action.id);
    assert.deepEqual(live, ['publish']);
  });

  it('"no object attached" still wins over it — that absence is the earlier, smaller truth', () => {
    const openObject = rowActions({ status: 'done', archived: false, chat_id: 'chat_1' }, ROLES.owner).find(
      (action) => action.id === 'open_object'
    );
    assert.equal(openObject?.reason, 'No object is attached to this request yet.');
  });

  it('is never inferred from `object_id` or `object_published` — the two fields that caused the bug', () => {
    for (const over of [{}, { object_published: true }, { object_published: false }]) {
      assert.equal(find(over, 'open_object')?.enabled, false, JSON.stringify(over));
    }
  });

  /**
   * The probe answers only for `done` rows (`objectBackfillCandidates`), so
   * every other status keeps the presence gate: with no probe there is no
   * fact, and "not in the library" would be its own unproven claim.
   */
  it('leaves the statuses the probe never covers exactly as they were', () => {
    for (const status of ['queued', 'running', 'needs_you', 'failed', 'stalled'] as const) {
      const openObject = rowActions(
        { status, archived: false, chat_id: 'chat_1', object_id: 'obj_1' },
        ROLES.owner
      ).find((action) => action.id === 'open_object');
      assert.equal(openObject?.enabled, true, status);
    }
  });
});


// ─── W21.3: published, unreleased, and now with a way out ───────────────────

/**
 * The bug: the retinol row showed View live disabled with the correct reason
 * (`NO_LIVE_PATH` — the release never confirmed a URL) and then nothing an
 * operator could do about it, even though the release exists.
 *
 * Two things the spec got wrong and this pins, both read off the endpoint:
 *
 *  1. The right is `admin`, not publisher+. `server/functions/admin-release.ts`
 *     gates on `roles.includes('admin')`; the agent tool is stricter still
 *     (owner-only, `generated-tools.ts`). A publisher-enabled button would 403
 *     on the click — the same lie as the Open object bug in the same patch.
 *  2. It is site-wide, not per-object. `parseOptions` accepts `commit`,
 *     `force_build` and `timeout_seconds` — there is no object id — so the
 *     LABEL must not claim to release one article.
 */
describe('W21.3 — the release, offered exactly where it is the next step', () => {
  const doneRow = (over: Partial<RowActionRowLike>): RowActionRowLike => ({
    status: 'done',
    archived: false,
    chat_id: 'chat_1',
    object_id: 'obj_1',
    object_in_library: true,
    ...over,
  });
  const releaseIn = (over: Partial<RowActionRowLike>, roles: readonly string[] = ROLES.owner) =>
    rowActions(doneRow(over), roles).find((action) => action.id === 'release');

  /** The four states a finished row can be in, and whether a release is the next step. */
  const PRESENCE = [
    { name: 'published, no confirmed live URL', over: { object_published: true }, offered: true },
    {
      name: 'published and live',
      over: { object_published: true, live_path: '/retinol-after-40' },
      offered: false,
    },
    { name: 'not published', over: { object_published: false }, offered: false },
    { name: 'publication unknown', over: {}, offered: false },
  ] as const;

  for (const state of PRESENCE) {
    it(`${state.name}: ${state.offered ? 'offers a release' : 'offers none'}`, () => {
      assert.equal(releaseIn(state.over) !== undefined, state.offered);
    });
  }

  it('nothing but a finished row offers it — no other status can be released FROM', () => {
    for (const status of ['queued', 'running', 'needs_you', 'failed', 'stalled', 'cancelled', 'archived'] as const) {
      const found = rowActions(
        { ...doneRow({ object_published: true }), status, archived: status === 'archived' },
        ROLES.owner
      ).find((action) => action.id === 'release');
      assert.equal(found, undefined, status);
    }
  });

  it('is admin-gated: an owner and an admin get it live, everyone below gets the reason (D3)', () => {
    const over = { object_published: true };
    for (const role of ['admin', 'owner'] as const) {
      const release = releaseIn(over, ROLES[role]);
      assert.equal(release?.enabled, true, role);
      assert.equal(release?.reason, undefined, role);
    }
    for (const role of ['viewer', 'editor', 'publisher'] as const) {
      const release = releaseIn(over, ROLES[role]);
      assert.equal(release?.enabled, false, role);
      assert.equal(release?.reason, 'Ask an admin', role);
      assert.equal(release?.rightRequired, 'admin', role);
    }
  });

  it('a publisher gets it DISABLED, not hidden — the endpoint would 403 the click', () => {
    // Stated on its own because it is the correction to the spec: "publisher+"
    // would have shipped exactly the class of bug W21.1 removes.
    const release = releaseIn({ object_published: true }, ROLES.publisher);
    assert.equal(release?.enabled, false);
    assert.ok(release, 'and it is still in the list, so a publisher can see who to ask');
  });

  /**
   * FIX 3 — the property, tested as BEHAVIOUR rather than as a string.
   *
   * W21.3 asserted `rightRequired === 'admin'`, which cannot fail however the
   * predicate is wired; the code behind it was `admin: registry`, so the very
   * change this guards against — the fleet widening the request endpoint to
   * publishers — would have widened Release too. Here the registry seam is
   * widened IN THE FIXTURE and Release is required to stay shut.
   */
  it('widening the request-registry seam does not widen the release seam', () => {
    const widened = { registry: ['owner', 'admin', 'publisher'], admin: ['owner', 'admin'] };
    const over = { object_published: true };

    // The premise: the widened seam really does reach a publisher.
    assert.equal(rowActionRights(ROLES.publisher, widened).registry, true, 'registry widened');
    assert.equal(rowActionRights(ROLES.publisher, widened).admin, false, 'and release did not');

    const actions = rowActions(doneRow(over), ROLES.publisher, { seams: widened });
    const release = actions.find((action) => action.id === 'release');
    assert.equal(release?.enabled, false, 'a publisher still cannot reach a release the endpoint would 403');
    assert.equal(release?.reason, 'Ask an admin');
    // …while a registry-gated action on the same row DID widen, which is what
    // makes the previous assertion about the seam and not about the roles.
    const registryAction = rowActions({ ...doneRow({}), status: 'failed' }, ROLES.publisher, {
      seams: widened,
    }).find((action) => action.id === 'retry');
    assert.equal(registryAction?.enabled, true, 'the seam that moved, moved');
  });

  it('the label names a SITE release, never this article', () => {
    const release = releaseIn({ object_published: true });
    assert.equal(release?.label, 'Release site');
    assert.doesNotMatch(
      release!.label,
      /\b(article|this|it)\b/i,
      'the endpoint takes no object id — the label must not imply one'
    );
  });

  /**
   * Wave 1's governing line: attention goes only where a human must act, and
   * there the action button sits in the same row as the problem. On this row
   * the problem is "published, not live", so the primary slot belongs to the
   * one control that can change it — not to a View live that stays dead until
   * it does. The trade reverses the moment the release confirms a URL.
   */
  it('takes the primary slot from View live, which keeps its reason in the overflow (D3)', () => {
    const actions = rowActions(doneRow({ object_published: true }), ROLES.owner);
    assert.deepEqual(ids(actions), ['open_object', 'release', 'view_live', 'open_chat', 'archive']);
    assert.equal(actions.find((action) => action.id === 'release')?.kind, 'primary');
    const viewLive = actions.find((action) => action.id === 'view_live');
    assert.equal(viewLive?.kind, 'menu');
    assert.equal(viewLive?.enabled, false);
    assert.equal(viewLive?.reason, NO_LIVE_PATH, 'still visible, still saying why — it is just not the next step');
  });

  it('gives it straight back once the release confirms a URL', () => {
    const live = rowActions(doneRow({ object_published: true, live_path: '/retinol-after-40' }), ROLES.owner);
    assert.deepEqual(ids(live), ['open_object', 'view_live', 'open_chat', 'archive']);
    assert.equal(live.find((action) => action.id === 'view_live')?.kind, 'primary');
    assert.equal(live.find((action) => action.id === 'view_live')?.enabled, true);
    assert.equal(live.find((action) => action.id === 'release'), undefined, 'nothing left to release for this row');
  });

  it('the trade never costs the row its two-primary budget, on either side of it', () => {
    for (const over of [{ object_published: true }, { object_published: true, live_path: '/retinol-after-40' }]) {
      const primaries = rowActions(doneRow(over), ROLES.owner).filter((action) => action.kind === 'primary');
      assert.equal(primaries.length, 2, JSON.stringify(over));
      // …and primaries still come first, so a surface can slice rather than sort.
      const actions = rowActions(doneRow(over), ROLES.owner);
      assert.deepEqual(actions.slice(0, 2), primaries, JSON.stringify(over));
    }
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
      admin: false,
      owner: false,
      ...over,
    });
    assert.deepEqual(rowActionRights(ROLES.viewer), r({}));
    assert.deepEqual(rowActionRights(ROLES.editor), r({ edit: true }));
    assert.deepEqual(rowActionRights(ROLES.publisher), r({ edit: true, publish: true }));
    // The seam: a publisher may publish but may not reach the registry; an
    // admin may reach the registry but is not an Owner. FIX 3: `admin` is an
    // independent seam that happens to answer the same today — the widening
    // test above is what pins the independence.
    assert.deepEqual(rowActionRights(ROLES.admin), r({ edit: true, publish: true, registry: true, admin: true }));
    assert.deepEqual(
      rowActionRights(ROLES.owner),
      r({ edit: true, publish: true, registry: true, admin: true, owner: true })
    );
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
