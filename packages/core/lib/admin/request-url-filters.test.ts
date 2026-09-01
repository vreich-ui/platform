/**
 * W21.2 — the URL → filter parse, and the one thing the old code got wrong.
 *
 * ## What this can and cannot prove
 *
 * The BUG was a render-lifecycle bug, not a parsing bug: the component already
 * read `filter` from the URL, but it read it inside `useState` initializers, and
 * `requests.astro` mounts the island `client:load` — so the markup was painted
 * on the server, where `window` does not exist, with the default tab. React
 * does not repair a `className` mismatch during hydration, so the wrong tab
 * stayed lit while the rows, fetched afterwards, looked right.
 *
 * That half of the fix — defaults on both renders, the URL applied in an effect
 * — cannot be tested here: this repo has no DOM harness (`tsconfig.test.json`
 * excludes the admin `.tsx` tree) and pretending otherwise would be a hollow
 * test. It is asserted by construction instead: `RequestsBody` initializes
 * from `DEFAULT_REQUEST_URL_FILTERS` and calls `readRequestUrlFilters` only
 * inside a mount effect.
 *
 * What IS pure is pinned below: the parse itself, and — the property the old
 * code could not express — that the default is used ONLY when the address
 * genuinely carries no parameter, never as the answer to a question that could
 * not be asked.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_REQUEST_URL_FILTERS,
  isQuickFilter,
  readRequestUrlFilters,
  requestsAddress,
  urlFiltersToApply,
  type RequestUrlFilterField,
} from './request-url-filters.js';
import { DEFAULT_REQUEST_QUICK_FILTER, QUICK_FILTERS } from './request-logic.js';

describe('readRequestUrlFilters — the address, parsed', () => {
  it('reads the tab Wolf linked: ?filter=done is the Done tab', () => {
    assert.equal(readRequestUrlFilters('?filter=done').quickFilter, 'done');
    assert.equal(readRequestUrlFilters('filter=done').quickFilter, 'done', 'with or without the leading ?');
  });

  it('reads every tab the surface offers, so no filter is linkable-but-unreadable', () => {
    for (const tab of QUICK_FILTERS) {
      assert.equal(readRequestUrlFilters(`?filter=${tab.key}`).quickFilter, tab.key, tab.key);
    }
  });

  it('reads the other three filters, together and apart', () => {
    assert.deepEqual(readRequestUrlFilters('?filter=running&kind=article&mine=1&q=retinol'), {
      quickFilter: 'running',
      kind: 'article',
      mine: true,
      q: 'retinol',
    });
    assert.deepEqual(readRequestUrlFilters('?q=retinol%20after%2040'), {
      ...DEFAULT_REQUEST_URL_FILTERS,
      q: 'retinol after 40',
    });
  });

  it('`mine` is the flag the writer emits and nothing else', () => {
    assert.equal(readRequestUrlFilters('?mine=1').mine, true);
    for (const value of ['0', 'true', 'yes', '']) {
      assert.equal(readRequestUrlFilters(`?mine=${value}`).mine, false, value);
    }
  });
});

/**
 * FIX 7 — this block used to lean on `hasRequestUrlFilters`, a function
 * nothing in the app ever called. It read as coverage of the load-bearing
 * property and was coverage of a helper the component did not use. It is
 * deleted; what remains is asserted against the two functions `RequestsBody`
 * actually calls, which is where the property has to hold.
 */
describe('readRequestUrlFilters — the default is an answer, not a shrug', () => {
  it('no address at all (the SERVER render) is exactly the defaults', () => {
    assert.deepEqual(readRequestUrlFilters(undefined), DEFAULT_REQUEST_URL_FILTERS);
    assert.deepEqual(readRequestUrlFilters(''), DEFAULT_REQUEST_URL_FILTERS);
    assert.deepEqual(readRequestUrlFilters('?'), DEFAULT_REQUEST_URL_FILTERS);
    assert.equal(DEFAULT_REQUEST_URL_FILTERS.quickFilter, DEFAULT_REQUEST_QUICK_FILTER);
  });

  it('the default tab is used ONLY where there is genuinely no `filter` parameter', () => {
    // The regression this pins: a `filter` that IS there must never come back
    // as the default, whatever else the address carries.
    for (const tab of QUICK_FILTERS) {
      if (tab.key === DEFAULT_REQUEST_QUICK_FILTER) continue;
      assert.notEqual(
        readRequestUrlFilters(`?filter=${tab.key}&kind=article&mine=1`).quickFilter,
        DEFAULT_REQUEST_QUICK_FILTER,
        tab.key
      );
    }
    // …and the same property through the function the mount effect calls: a
    // present parameter is applied, an absent one falls back, and only an
    // empty address falls back for everything.
    const none = new Set<RequestUrlFilterField>();
    assert.equal(urlFiltersToApply('?filter=done', none).quickFilter, 'done');
    assert.equal(urlFiltersToApply('?kind=article', none).quickFilter, DEFAULT_REQUEST_QUICK_FILTER);
    assert.equal(urlFiltersToApply('?kind=article', none).kind, 'article');
    assert.deepEqual(urlFiltersToApply('', none), DEFAULT_REQUEST_URL_FILTERS);
  });

  it('an unreadable `filter` falls back for itself alone, and never drags the rest down with it', () => {
    const parsed = readRequestUrlFilters('?filter=in_progress&kind=article&mine=1&q=retinol');
    assert.equal(parsed.quickFilter, DEFAULT_REQUEST_QUICK_FILTER, 'a tab that does not exist is not a tab');
    assert.equal(parsed.kind, 'article');
    assert.equal(parsed.mine, true);
    assert.equal(parsed.q, 'retinol');
  });

  it('isQuickFilter admits the tabs and nothing else', () => {
    for (const tab of QUICK_FILTERS) assert.equal(isQuickFilter(tab.key), true, tab.key);
    for (const value of [null, undefined, '', 'done ', 'DONE', 'needs_you', 'in_progress']) {
      assert.equal(isQuickFilter(value), false, String(value));
    }
  });
});

describe('W21.2 — the round trip with the URL writer', () => {
  /**
   * The writer omits a filter that is at its default, so a default view has a
   * bare `/admin/requests` address. Reading that back must land on the defaults
   * again — otherwise a link copied out of the address bar would open on a
   * different view than the one it was copied from.
   *
   * FIX 6: this drives `requestsAddress`, the writer the component actually
   * calls. It used to be a hand-copied reimplementation of it, which could
   * agree with a writer that had drifted.
   */
  const write = (filters: typeof DEFAULT_REQUEST_URL_FILTERS): string =>
    requestsAddress(filters).replace(/^\/admin\/requests\??/, '');

  it('every view survives being written to the address and read back', () => {
    const views = [
      DEFAULT_REQUEST_URL_FILTERS,
      { quickFilter: 'done' as const, kind: '', mine: false, q: '' },
      { quickFilter: 'archived' as const, kind: 'theme', mine: true, q: 'bakuchiol' },
      { quickFilter: DEFAULT_REQUEST_QUICK_FILTER, kind: 'article', mine: false, q: '' },
    ];
    for (const view of views) {
      assert.deepEqual(readRequestUrlFilters(write(view)), view, JSON.stringify(view));
    }
  });

  it('the default view writes a bare address, and a bare address reads the default view', () => {
    assert.equal(write(DEFAULT_REQUEST_URL_FILTERS), '');
    assert.deepEqual(readRequestUrlFilters(''), DEFAULT_REQUEST_URL_FILTERS);
  });
});

// ─── FIX 4: a filter the person touched survives the address ────────────────

/**
 * The defect W21.2 shipped: "untouched" was decided by comparing the value to
 * its default, so setting a filter TO its default inside the hydration window
 * was indistinguishable from never having touched it — and the address won.
 * These drive the exact function `RequestsBody`'s mount effect calls.
 */
describe('urlFiltersToApply — the address yields to the person', () => {
  const none = new Set<RequestUrlFilterField>();
  const touched = (...fields: RequestUrlFilterField[]) => new Set<RequestUrlFilterField>(fields);

  it('applies everything when nothing has been touched (the ordinary load)', () => {
    assert.deepEqual(urlFiltersToApply('?filter=done&kind=article&mine=1&q=retinol', none), {
      quickFilter: 'done',
      kind: 'article',
      mine: true,
      q: 'retinol',
    });
  });

  it('THE REGRESSION: clicking the DEFAULT tab on a ?filter=done load is not undone', () => {
    // Before FIX 4 this returned `quickFilter: 'done'` — the address reverting
    // a click because the click happened to land on the default value.
    const apply = urlFiltersToApply('?filter=done', touched('quickFilter'));
    assert.equal('quickFilter' in apply, false, 'the tab they clicked is theirs, default or not');
  });

  it('holds for every filter that can be cleared back to its default', () => {
    assert.equal('kind' in urlFiltersToApply('?kind=article', touched('kind')), false);
    assert.equal('mine' in urlFiltersToApply('?mine=1', touched('mine')), false);
    assert.equal('q' in urlFiltersToApply('?q=retinol', touched('q')), false);
  });

  it('a touched filter never drags the untouched ones down with it', () => {
    assert.deepEqual(urlFiltersToApply('?filter=done&kind=article&mine=1&q=retinol', touched('quickFilter')), {
      kind: 'article',
      mine: true,
      q: 'retinol',
    });
  });

  it('touching everything leaves the address nothing to say', () => {
    assert.deepEqual(urlFiltersToApply('?filter=done&kind=article&mine=1&q=retinol', touched('quickFilter', 'kind', 'mine', 'q')), {});
  });

  it('an absent parameter still applies its default, so an untouched field is not left half-set', () => {
    assert.deepEqual(urlFiltersToApply('', none), DEFAULT_REQUEST_URL_FILTERS);
  });
});

// ─── FIX 6: the drawer must not eat the query string ────────────────────────

/**
 * The instance W21.2 left open. Opening a row pushed a bare
 * `/admin/requests/<id>` and closing it pushed a bare `/admin/requests`, so
 * two clicks left the Done tab lit over an address that said nothing about it
 * — and a link copied then would open somebody else on Needs you.
 */
describe('requestsAddress — the drawer keeps the filters', () => {
  const done = { quickFilter: 'done' as const, kind: 'article', mine: true, q: 'retinol' };

  it('carries the filters onto the drawer address and back off it', () => {
    assert.equal(requestsAddress(done, 'req_1'), '/admin/requests/req_1?filter=done&kind=article&mine=1&q=retinol');
    assert.equal(requestsAddress(done), '/admin/requests?filter=done&kind=article&mine=1&q=retinol');
  });

  it('open then close is the address it started from — the round trip the bug broke', () => {
    const before = requestsAddress(done);
    const opened = requestsAddress(done, 'req_1');
    assert.notEqual(opened, before);
    assert.equal(requestsAddress(done), before, 'closing restores it exactly');
    assert.deepEqual(readRequestUrlFilters(opened.split('?')[1]), done, 'and the drawer URL still reads back');
  });

  it('the default view still writes a bare address, drawer or not', () => {
    assert.equal(requestsAddress(DEFAULT_REQUEST_URL_FILTERS), '/admin/requests');
    assert.equal(requestsAddress(DEFAULT_REQUEST_URL_FILTERS, 'req_1'), '/admin/requests/req_1');
  });

  it('an id that needs escaping is escaped', () => {
    assert.equal(requestsAddress(DEFAULT_REQUEST_URL_FILTERS, 'a/b c'), '/admin/requests/a%2Fb%20c');
  });
});
