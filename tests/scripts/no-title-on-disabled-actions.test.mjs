/**
 * T0 — repo-wide invariant (BRIEF.md whole-patch acceptance item 2): no JSX
 * element under `packages/core/admin/**\/*.tsx` may carry BOTH a `disabled`
 * prop AND a `title=` attribute. Convention D3 requires a rights-gated
 * control to render disabled *with a reason*, but a native `title` tooltip
 * never reaches a touch user or a keyboard-focus user consistently —
 * `Popover` (`mode="hover"`, `overlays.tsx`) is built to fix exactly that,
 * and `approval.tsx`'s `ActionRow` (via its new `DecisionButton` helper) is
 * this task's conversion of the pattern the brief points at.
 *
 * This is a TARGETED scan, not a substring grep: it parses each JSX
 * element's own top-level attribute NAMES (a small hand-rolled parser,
 * `parseOpeningTag` below — tracks string/template-literal and `{...}`
 * expression boundaries so it never looks INSIDE an attribute's value).
 * That precision is what keeps the false-positive rate at zero against the
 * ~258 existing `title=` uses in admin today:
 *   - `title={idTooltip(id)}` alone on a table cell has no `disabled` on
 *     the same element, so it never matches the AND condition.
 *   - `<Dialog title="Edit summary">` — `title` here is Dialog's own
 *     heading PROP, not an HTML tooltip, and Dialog has no `disabled` prop
 *     to co-occur with, so it's excluded the same way.
 *   - a Tailwind class string like `"...disabled:opacity-50..."` is never
 *     even considered — quoted attribute VALUES are skipped as opaque
 *     spans, never scanned for attribute-name-shaped substrings.
 *   - a nested element's own `disabled`/`title` inside a `{...}` prop value
 *     (e.g. `footer={<Button disabled title="x">}`) is skipped along with
 *     the rest of that balanced expression — it is never misattributed to
 *     the OUTER element being parsed.
 *
 * KNOWN_PENDING is the escape hatch for a file that still carries a
 * genuine `disabled` + `title=` pair. It is EMPTY, and should stay that
 * way: every rights-gated control in the admin now states its reason in a
 * `Popover mode="hover"`, which a keyboard and a touch screen can both
 * reach. The third test below fails loudly on a stale entry, so adding
 * one here is a promise to come back and remove it.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_DIR = join(ROOT, 'packages', 'core', 'admin');

const KNOWN_PENDING = new Set([
  // Empty: every disabled admin control now carries its reason in a
  // `Popover mode="hover"` instead of a native `title=` (T0 + T0b + B1).
]);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
};

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
 * Parses ONE JSX opening tag starting at `source[tagStart] === '<'` and
 * returns its tag name, the SET of its own top-level attribute names (a
 * spread `{...rest}` is skipped rather than expanded — this scan is static
 * and cannot know what it carries), the source offset of each attribute
 * name's first occurrence (for line-number reporting), and the index just
 * past the tag's closing `>`/`/>`. Returns `null` for anything this simple
 * parser can't confidently read as a real opening tag (e.g. a TS generic
 * like `useState<Foo>` that superficially starts the same way) — bailing
 * out is always safe here: it just means this occurrence is skipped, never
 * mis-flagged.
 */
function parseOpeningTag(source, tagStart) {
  let i = tagStart + 1;
  const nameStart = i;
  while (i < source.length && /[A-Za-z0-9_.:-]/.test(source[i])) i++;
  const tagName = source.slice(nameStart, i);
  if (!tagName) return null;

  const attrNames = new Set();
  const attrPositions = new Map();

  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) return null;
    if (source[i] === '/' && source[i + 1] === '>') return { tagName, attrNames, attrPositions, end: i + 2 };
    if (source[i] === '>') return { tagName, attrNames, attrPositions, end: i + 1 };
    if (source[i] === '{') {
      i = skipBalancedBraces(source, i);
      continue;
    }
    const attrNameStart = i;
    while (i < source.length && /[A-Za-z0-9_:-]/.test(source[i])) i++;
    if (i === attrNameStart) return null; // unexpected token — not a tag we can read
    const attrName = source.slice(attrNameStart, i);
    attrNames.add(attrName);
    if (!attrPositions.has(attrName)) attrPositions.set(attrName, attrNameStart);

    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === '=') {
      i++;
      while (i < source.length && /\s/.test(source[i])) i++;
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

/** Every `disabled`+`title=` co-occurrence in `source`, as `{ line, tagName }`. */
function findOffenders(source) {
  const offenders = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '<' && source[i + 1] !== '/' && /[A-Za-z]/.test(source[i + 1] || '')) {
      const parsed = parseOpeningTag(source, i);
      if (parsed) {
        if (parsed.attrNames.has('disabled') && parsed.attrNames.has('title')) {
          const pos = parsed.attrPositions.get('title');
          const line = source.slice(0, pos).split('\n').length;
          offenders.push({ line, tagName: parsed.tagName });
        }
        i = parsed.end;
        continue;
      }
      i += 1; // not a readable tag (e.g. a generic-type false start) — move on
      continue;
    }
    i++;
  }
  return offenders;
}

test('no packages/core/admin/**/*.tsx element outside KNOWN_PENDING carries both disabled and title=', () => {
  const failures = [];
  for (const file of walk(ADMIN_DIR)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (KNOWN_PENDING.has(rel)) continue;
    const source = readFileSync(file, 'utf8');
    for (const offender of findOffenders(source)) {
      failures.push(`${rel}:${offender.line} — <${offender.tagName}> carries both disabled and title=`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `disabled+title= found (fix it, or add the file to KNOWN_PENDING with a reason):\n${failures.join('\n')}`
  );
});

test('T0 introduces zero new offenders in the files it owns (overlays.tsx, approval.tsx, KitGallery.tsx)', () => {
  for (const rel of ['overlays.tsx', 'approval.tsx', 'KitGallery.tsx']) {
    const source = readFileSync(join(ADMIN_DIR, rel), 'utf8');
    assert.deepEqual(
      findOffenders(source),
      [],
      `packages/core/admin/${rel} must have zero disabled+title= offenders (no KNOWN_PENDING escape hatch for T0's own files)`
    );
  }
});

test('every KNOWN_PENDING file still has a real offender (a stale entry means someone fixed it and forgot to shrink this list)', () => {
  for (const rel of KNOWN_PENDING) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(findOffenders(source).length > 0, `${rel} is in KNOWN_PENDING but has no offenders anymore — remove it`);
  }
});
