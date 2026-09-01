/**
 * D3 — repo-wide invariant: an object's own id, rendered as visible text
 * anywhere under `packages/core/admin/**\/*.tsx`, must be one click from
 * open. `RunReceipt` (`admin/chat.tsx`) already gets this right — every
 * created-object reference it renders carries its own `href`
 * (`createdObjectHref`/`createdObjectLabel`, `lib/admin/chat-liveness.ts`) —
 * this test is that same convention, enforced.
 *
 * Scope, deliberately narrow: the field name `object_id` (or its camelCase
 * spelling `objectId`) is unambiguous in this codebase — nothing outside the
 * object-record domain is ever called that (a user is `user_id`, a chat is
 * `chat_id`, an agent profile is `profile_id`). `display_name` was
 * considered too — it is what most object rows call their title — but it is
 * ALSO what a signed-in person's own name is called in this same admin
 * (`ProfilePage.tsx`'s `user.display_name`, rendered on the person's own
 * profile page, correctly with no link — there is nowhere to send it), so a
 * blanket scan on that field name would flag a real non-bug. `object_id`
 * carries no such collision, so the scan stays precise rather than guessing
 * which `display_name` is whose.
 *
 * TARGETED, not a substring grep, in the same spirit as
 * `no-title-on-disabled-actions.test.mjs` (read first — this file borrows
 * its `parseOpeningTag`/`skipBalancedBraces` machinery verbatim, then adds
 * ancestor tracking on top, since "does this element have an `href`" is not
 * enough here — "does ANY enclosing element" is the actual question):
 *
 *   - a JSX child expression like `{member.object_id}` is flagged only when
 *     no element on the stack of currently-open tags is an `<a href=...>` —
 *     `{member.object_id}` sitting right next to a sibling `<a href=...>`
 *     that links the SAME row is not inside it, and still gets flagged,
 *     which is correct: the id itself is still bare text.
 *   - `key={row.object_id}`, `objectId={record.object_id}` (a prop value)
 *     and a template string used to build a search index or a log line are
 *     never even visible to the scan — they live inside an attribute value
 *     or outside any JSX children position, both of which the tag-stack
 *     walker treats as opaque spans it does not read into for this check.
 *   - an expression that itself renders more JSX (contains `<`) is walked
 *     INTO rather than evaluated as a bare value — `{ok ? <a
 *     href={x}>{row.object_id}</a> : null}` correctly sees the `<a href>`
 *     push before it reaches the id.
 *   - a generic type instantiation (`useState<string>`, `Array<Foo>`) is
 *     never mistaken for a tag — a real JSX opening tag is never glued
 *     directly onto a preceding identifier with no separator; a generic
 *     always is. That one-character check is what keeps this parser's stack
 *     depth honest through a component's setup code, above its `return`.
 *
 * KNOWN_PENDING is the same escape hatch `no-title-on-disabled-actions`
 * establishes, for a file this task does not own. Two entries, both found by
 * this audit, both outside D2/D3/E3/C3b's file list:
 *   - `VariantsWorkspace.tsx` — a variant's own id sits bare under its
 *     (linked) display name, and the evaluation table's column header
 *     repeats the variant's display name with no link at all.
 *   - `KitGallery.tsx` — the "raw id" column of the naming-convention demo
 *     table renders the sample id as plain text on purpose (the column
 *     header says so: "Raw id (tooltip only)") — plausibly deliberate, but
 *     left for its own owner to confirm and either fix or annotate.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_DIR = join(ROOT, 'packages', 'core', 'admin');

/** Files this task does not own, with a REAL offender each — see the file header. */
const KNOWN_PENDING = new Set(['packages/core/admin/VariantsWorkspace.tsx', 'packages/core/admin/KitGallery.tsx']);

/** Files this task DOES own — zero escape hatch, same discipline `no-title-on-disabled-actions` holds T0's own files to. */
const OWNED_FILES = [
  'RequestsWorkspace.tsx',
  'AgentsHub.tsx',
  'AgentRail.tsx',
  'NeedsYouMenu.tsx',
  'RequestActivity.tsx',
];

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
};

// ─── borrowed verbatim from no-title-on-disabled-actions.test.mjs ──────────

/** Consumes one `{...}` expression starting at `source[i] === '{'`, tracking
 * nested braces and string/template literals so a `}` or a quote character
 * living inside a string can never end it early. Returns the index just
 * past the matching closing `}`. */
function skipBalancedBraces(source, i) {
  let depth = 0;
  let inString = null;
  while (i < source.length) {
    const c = source[i];
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Skips whitespace AND `//...`/`/* ... *\/` comments — this codebase writes
 * a `// why` line between an opening tag's own attributes constantly (see
 * this file's own edits under D2/D3/E3b), and the original
 * `no-title-on-disabled-actions` parser this is borrowed from never had to
 * skip one: a comment it failed to skip just made THAT tag unreadable, with
 * no further consequence. Here it would silently spill the rest of a real
 * attribute list into "children" and risk a false positive on whatever `{}`
 * came next — worth the extra handling this one function centralises.
 */
function skipTrivia(source, i) {
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, source.length);
      continue;
    }
    break;
  }
  return i;
}

/**
 * Parses ONE JSX opening tag starting at `source[tagStart] === '<'`. Returns
 * the tag name, its own top-level attribute names, whether it self-closes
 * (`/>`), and the index just past the tag. `null` for anything this simple
 * parser can't confidently read as a real opening tag — bailing out is
 * always safe: the occurrence is just skipped, never mis-flagged, and never
 * mis-pushed onto the ancestor stack below.
 */
function parseOpeningTag(source, tagStart) {
  let i = tagStart + 1;
  const nameStart = i;
  while (i < source.length && /[A-Za-z0-9_.:-]/.test(source[i])) i++;
  const tagName = source.slice(nameStart, i);
  if (!tagName) return null;

  const attrNames = new Set();

  while (i < source.length) {
    i = skipTrivia(source, i);
    if (i >= source.length) return null;
    if (source[i] === '/' && source[i + 1] === '>') return { tagName, attrNames, selfClosing: true, end: i + 2 };
    if (source[i] === '>') return { tagName, attrNames, selfClosing: false, end: i + 1 };
    if (source[i] === '{') {
      i = skipBalancedBraces(source, i);
      continue;
    }
    const attrNameStart = i;
    while (i < source.length && /[A-Za-z0-9_:-]/.test(source[i])) i++;
    if (i === attrNameStart) return null; // unexpected token — not a tag we can read
    attrNames.add(source.slice(attrNameStart, i));

    i = skipTrivia(source, i);
    if (source[i] === '=') {
      i++;
      i = skipTrivia(source, i);
      if (source[i] === '"' || source[i] === "'") {
        const quote = source[i];
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        i++; // closing quote
      } else if (source[i] === '{') {
        i = skipBalancedBraces(source, i);
      } else {
        return null; // not valid JSX attribute-value syntax — bail
      }
    }
    // else: boolean shorthand (e.g. bare `disabled`) — loop for the next attribute.
  }
  return null; // ran off the end without a closing `>` — malformed/unreadable
}

// ─── this test's own addition: ancestor-aware, id-specific ─────────────────

const ID_PATTERN = /\bobject_id\b|\bobjectId\b/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * Every `{...}` expression that (a) names `object_id`/`objectId`, (b) renders
 * no further JSX of its own (a bare value, not a branch that produces a
 * link), and (c) has no `<a href=...>` anywhere on its ancestor stack.
 */
function findBareObjectIds(source) {
  const offenders = [];
  /** @type {Array<{ tagName: string, isLink: boolean }>} */
  const stack = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];

    // A comment's own text is never markup — a doc comment naming
    // `` `<SeverityIcon>` `` as prose, or a `// why` line between two real
    // tags, must not be read as an opening tag the way real JSX would be.
    // Skipped unconditionally, ahead of every other check: unlike the
    // `disabled`+`title` scan this is borrowed from, a phantom tag here
    // would push an ancestor frame that never finds its closing tag and
    // corrupts every "am I inside a link" answer for the rest of the file.
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, source.length);
      continue;
    }

    if (c === '<' && source[i + 1] === '/') {
      const m = /^<\/[A-Za-z0-9_.:-]*\s*>/.exec(source.slice(i));
      if (m) {
        stack.pop();
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }

    if (c === '<' && source[i + 1] === '>') {
      // Fragment shorthand — never a link.
      stack.push({ tagName: '', isLink: false });
      i += 2;
      continue;
    }

    if (c === '<' && /[A-Za-z]/.test(source[i + 1] || '')) {
      // A real JSX opening tag is never glued directly onto a preceding
      // identifier with no separator — a generic type instantiation
      // (`useState<string>`, `Array<Foo>`) always is. Rejecting that shape
      // up front is what keeps a `<T>` in a component's setup code from
      // being pushed as a phantom, never-closed ancestor.
      const precededByIdentifier = i > 0 && IDENTIFIER_CHAR.test(source[i - 1]);
      if (!precededByIdentifier) {
        const parsed = parseOpeningTag(source, i);
        if (parsed) {
          if (!parsed.selfClosing) {
            stack.push({ tagName: parsed.tagName, isLink: parsed.tagName === 'a' && parsed.attrNames.has('href') });
          }
          i = parsed.end;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === '{') {
      const end = skipBalancedBraces(source, i);
      const inner = source.slice(i + 1, end - 1);
      // Only a JSX CHILDREN position ever needs reading here — the same
      // brace inside an opening tag's own attribute value was already
      // consumed by `parseOpeningTag` above and never reaches this branch.
      // Gating on `stack.length > 0` additionally keeps a stray top-level
      // `{...}` in plain, non-rendering code (an object literal, a template
      // string building a search index) from ever being read as a child.
      if (stack.length > 0 && !inner.includes('<')) {
        if (ID_PATTERN.test(inner)) {
          const insideLink = stack.some((frame) => frame.isLink);
          if (!insideLink) {
            const line = source.slice(0, i).split('\n').length;
            offenders.push({ line, expr: inner.trim() });
          }
        }
        i = end; // a bare value — nothing nested worth walking into.
        continue;
      }
      if (!inner.includes('<')) {
        i = end; // no id concern and no nested JSX — skip past it wholesale.
        continue;
      }
      // Contains JSX of its own (a conditional render, a `.map`, …) — walk
      // INTO it char-by-char so any tags/expressions nested inside are seen
      // by the same stack logic, rather than jumping over them.
      i++;
      continue;
    }

    i++;
  }
  return offenders;
}

test('no bare `object_id`/`objectId` renders anywhere in packages/core/admin/**/*.tsx outside KNOWN_PENDING', () => {
  const failures = [];
  for (const file of walk(ADMIN_DIR)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (KNOWN_PENDING.has(rel)) continue;
    const source = readFileSync(file, 'utf8');
    for (const offender of findBareObjectIds(source)) {
      failures.push(`${rel}:${offender.line} — {${offender.expr}} renders with no enclosing <a href>`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `bare object id found (give it an href, or add the file to KNOWN_PENDING with a reason):\n${failures.join('\n')}`
  );
});

test('D3’s own files (RequestsWorkspace, AgentsHub, AgentRail, NeedsYouMenu, RequestActivity) carry zero offenders — no escape hatch for the files this task owns', () => {
  for (const name of OWNED_FILES) {
    const source = readFileSync(join(ADMIN_DIR, name), 'utf8');
    assert.deepEqual(findBareObjectIds(source), [], `packages/core/admin/${name} must have zero bare object id renders`);
  }
});

test('every KNOWN_PENDING file still has a real offender (a stale entry means someone fixed it and forgot to shrink this list)', () => {
  for (const rel of KNOWN_PENDING) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(findBareObjectIds(source).length > 0, `${rel} is in KNOWN_PENDING but has no offenders anymore — remove it`);
  }
});
