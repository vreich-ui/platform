import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  objectDisplayName,
  objectTypeLabel,
  deSlug,
  principalName,
  friendlyNameFromEmail,
  verbToPhrase,
  VERB_PHRASES,
  idTooltip,
  navigationTargetLabel,
  statusLabel,
} from './display-name.js';
import type { ObjectType } from '../../schema/object-record-v1.js';
import { patchOpUnionSchema } from '../../schema/object-patch-ops.js';

/**
 * Fixtures mirror the real seed bodies under sites/drlurie/data/site/*
 * (values copied verbatim from disk on 2026-07-17, before the W11 T11.6
 * relocation out of src/data/site) so the derivation is tested against the
 * shapes it will actually see, not invented ones.
 */
const fixture = (object_type: ObjectType, object_id: string, body: unknown) => ({ object_type, object_id, body });

describe('objectDisplayName — all ten object types', () => {
  it('page → body.title', () => {
    assert.strictEqual(
      objectDisplayName(fixture('page', 'page_404', { title: 'Page Not Found', route: '/404' })),
      'Page Not Found'
    );
  });

  it('page → de-slugged route when title missing', () => {
    assert.strictEqual(objectDisplayName(fixture('page', 'page_start', { route: '/start-here' })), 'Start Here');
  });

  it('section → first heading from stored HTML (no naked id)', () => {
    assert.strictEqual(
      objectDisplayName(
        fixture('section', 'sec_about_blog', {
          section: { id: 's_blog', data: { body: '<h2>Why This Blog Exists</h2><p>This site…</p>' } },
        })
      ),
      'Why This Blog Exists'
    );
  });

  it('navigation → role-based label', () => {
    assert.strictEqual(
      objectDisplayName(fixture('navigation', 'nav_footer', { role: 'footer', brand: {} })),
      'Footer navigation'
    );
  });

  it('taxonomy → kinds list', () => {
    assert.strictEqual(
      objectDisplayName(fixture('taxonomy', 'tax_drlurie', { kinds: { category: {}, tag: {} } })),
      'Taxonomy (category, tag)'
    );
  });

  it('site → body.name', () => {
    assert.strictEqual(
      objectDisplayName(fixture('site', 'site_drlurie', { name: 'Dr. Lurié Skincare' })),
      'Dr. Lurié Skincare'
    );
  });

  it('template → body.name', () => {
    assert.strictEqual(
      objectDisplayName(fixture('template', 'tpl_interior', { name: 'Interior page' })),
      'Interior page'
    );
  });

  it('section_template → body.name', () => {
    assert.strictEqual(
      objectDisplayName(fixture('section_template', 'stpl_audience_grid', { name: 'Audience grid' })),
      'Audience grid'
    );
  });

  it('theme → body.name', () => {
    assert.strictEqual(
      objectDisplayName(fixture('theme', 'thm_drlurie_default', { name: 'Dr. Lurié default' })),
      'Dr. Lurié default'
    );
  });

  it('product → presentation.title, else de-slugged slug', () => {
    assert.strictEqual(
      objectDisplayName(
        fixture('product', 'prod_barrier', {
          slug: 'barrier-repair-guide',
          presentation: { title: 'The Barrier Repair Guide' },
        })
      ),
      'The Barrier Repair Guide'
    );
    assert.strictEqual(
      objectDisplayName(fixture('product', 'prod_x', { slug: 'starter-checklist', presentation: {} })),
      'Starter Checklist'
    );
  });

  it('content_item → body.title', () => {
    assert.strictEqual(
      objectDisplayName(
        fixture('content_item', 'req_agent_minimal_routine_20260713_01', {
          title: 'The three-step routine that is genuinely enough',
          slug: 'the-three-step-routine',
        })
      ),
      'The three-step routine that is genuinely enough'
    );
  });

  it('never leaks a raw id — falls back to "Untitled <type>"', () => {
    assert.strictEqual(objectDisplayName(fixture('page', 'page_mystery', {})), 'Untitled page');
    assert.strictEqual(objectDisplayName(fixture('content_item', 'req_empty', {})), 'Untitled article');
    assert.strictEqual(objectDisplayName(fixture('theme', 'thm_empty', {})), 'Untitled theme');
  });
});

describe('objectTypeLabel', () => {
  it('maps the machine type to a human label', () => {
    assert.strictEqual(objectTypeLabel('content_item'), 'Article');
    assert.strictEqual(objectTypeLabel('section_template'), 'Section template');
  });
});

describe('deSlug', () => {
  it('title-cases and de-hyphenates', () => {
    assert.strictEqual(deSlug('barrier-repair-guide'), 'Barrier Repair Guide');
    assert.strictEqual(deSlug('/start-here/'), 'Start Here');
    assert.strictEqual(deSlug(''), undefined);
    assert.strictEqual(deSlug(undefined), undefined);
  });
});

describe('principalName', () => {
  it('humanizes a person email local-part', () => {
    assert.strictEqual(principalName({ kind: 'human', id: 'u1', email: 'alex.rivera@example.com' }), 'Alex Rivera');
  });
  it('labels an agent', () => {
    assert.strictEqual(
      principalName({ kind: 'agent', agent_name: 'reader_insight', auth: 'mcp_token' }),
      'Reader Insight (agent)'
    );
  });
  // D2(b): the 'unattributed-agent' sentinel (object-store.ts / mcp.ts —
  // agent_name: declared || 'unattributed-agent') must render as prose, not
  // as the title-cased-through sentinel "Unattributed-Agent (agent)".
  it('renders the unattributed-agent sentinel as prose, not a title-cased internal string', () => {
    assert.strictEqual(
      principalName({ kind: 'agent', agent_name: 'unattributed-agent', auth: 'publish_key' }),
      'An unnamed agent'
    );
  });
});

// D3: the email → friendly-name derivation, shared by principalName() and
// the server-side default-display-name sites (admin-users.ts,
// user-invite.ts). Covers the awkward local-parts the brief called out.
describe('friendlyNameFromEmail', () => {
  it('title-cases a name-like local part', () => {
    assert.strictEqual(friendlyNameFromEmail('alex.rivera@example.com'), 'Alex Rivera');
  });
  it('handles a generic local part', () => {
    assert.strictEqual(friendlyNameFromEmail('admin@example.com'), 'Admin');
  });
  it('handles a hyphenated service-account-style local part', () => {
    assert.strictEqual(friendlyNameFromEmail('no-reply@example.com'), 'No Reply');
  });
  it('handles a dotted initial+surname local part', () => {
    assert.strictEqual(friendlyNameFromEmail('v.reich@kugelbrands.com'), 'V Reich');
  });
  it('strips a plus-tag rather than leaking it into the name', () => {
    // Without stripping, titleCase's \w\S* word-matcher treats "wolf+test"
    // as one token and would produce "Wolf+test" — the raw tag leaking
    // through. Gmail-style plus-addressing is common enough to guard.
    assert.strictEqual(friendlyNameFromEmail('wolf+test@kugelbrands.com'), 'Wolf');
  });
});

describe('verbToPhrase', () => {
  it('renders a person action as a sentence', () => {
    assert.strictEqual(
      verbToPhrase({ action: 'checkout', actor: { kind: 'human', id: 'u1', email: 'wolf@kugelbrands.com' } }),
      'Wolf checked out'
    );
  });
  it('renders an agent publish', () => {
    assert.strictEqual(
      verbToPhrase({ action: 'publish', actor: { kind: 'agent', agent_name: 'final_article', auth: 'publish_key' } }),
      'Final Article (agent) published'
    );
  });
  it('refines review_decide by the decision detail', () => {
    assert.strictEqual(
      verbToPhrase({
        action: 'review_decide',
        actor: { kind: 'human', id: 'u1', email: 'wolf@kugelbrands.com' },
        details: { decision: 'approve' },
      }),
      'Wolf approved the changes'
    );
  });
  it('falls back to a humanized action for unknown verbs', () => {
    assert.strictEqual(
      verbToPhrase({ action: 'some_new_verb', actor: { kind: 'human', id: 'u1', email: 'a.b@x.com' } }),
      'A B some new verb'
    );
  });
});

describe('idTooltip', () => {
  it('frames the raw id for a tooltip', () => {
    assert.strictEqual(
      idTooltip('req_agent_object_model_demo_20260713_01'),
      'Internal id: req_agent_object_model_demo_20260713_01'
    );
    assert.strictEqual(idTooltip(undefined), 'No id assigned');
  });
});

describe('admin UI labels', () => {
  it('uses human labels for stored status and navigation target values', () => {
    assert.strictEqual(statusLabel('changes_requested'), 'Changes requested');
    assert.strictEqual(statusLabel('unknown_status'), 'Unknown Status');
    assert.strictEqual(navigationTargetLabel('route'), 'Site route');
    assert.strictEqual(navigationTargetLabel('external'), 'External link');
  });
});

// D2(a) regression guard: every `patch` op name lands verbatim as
// `history[].action` (object-patch-apply.ts: `action: op.op`), so every op
// in the real grammar (schema/object-patch-ops.ts's patchOpUnionSchema) MUST
// have a VERB_PHRASES entry — otherwise it falls through to verbToPhrase's
// naive humanization (raw_action.replace(/[_.]+/g, ' ')) and an internal
// action name leaks into the activity feed exactly like `retire`,
// `move_section`, and `remove_section` did before this fix. Introspects the
// real zod union (not a hand-copied list) so a NEW op added to the grammar
// without a matching phrase fails this test immediately, instead of
// silently reaching production the way the original gap did.
describe('VERB_PHRASES coverage', () => {
  it('has an entry for every object-patch-ops.ts op name', () => {
    const opNames = patchOpUnionSchema.options.map((option) => option.shape.op.value);
    assert.ok(opNames.length > 0, 'sanity: the patch op union should not be empty');
    const missing = opNames.filter((name) => !(name in VERB_PHRASES));
    assert.deepStrictEqual(missing, [], `VERB_PHRASES is missing an entry for: ${missing.join(', ')}`);
  });

  // The lock/publish/review lifecycle actions aren't part of the patch-op
  // union above, so they're pinned here by their real history-writing site
  // (not the verb-level REQUEST action name, which can differ — see
  // `refresh` vs `refresh_lock` below).
  it('has an entry for every non-patch history action the system writes', () => {
    const lifecycleActions = [
      'create', // object-verbs.ts case 'create'
      'checkout', // object-lock.ts checkoutObjectLock
      'checkin', // object-lock.ts checkinObjectLock
      'refresh', // object-lock.ts refreshObjectLock — NOT 'refresh_lock' (that's the request action)
      'force_release', // object-lock.ts forceReleaseObjectLock
      'publish', // object-publish.ts publishObject
      'retire', // object-retire.ts retireObject (W14 F6)
      'submit_review', // review-state.ts submitReview
      'review_decide', // review-state.ts decideReview
    ];
    const missing = lifecycleActions.filter((name) => !(name in VERB_PHRASES));
    assert.deepStrictEqual(missing, [], `VERB_PHRASES is missing an entry for: ${missing.join(', ')}`);
  });
});
