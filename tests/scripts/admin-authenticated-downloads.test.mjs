/**
 * Repo-wide invariant: an admin function URL is never handed to the browser to
 * navigate to.
 *
 * Every `/.netlify/functions/admin-*` endpoint authenticates with a bearer
 * token (or Netlify's injected clientContext). A top-level navigation —
 * `window.open(url)`, `location.href = url`, `<a href={url}>` — carries
 * neither, so the endpoint answers
 *
 *     {"ok":false,"status":401,"error":"Authentication is required."}
 *
 * and the browser renders that JSON. PluginsPage shipped exactly this for all
 * three of its export buttons (.plugin, OpenAI config, Gem instructions). It
 * looked like a broken download rather than a missing credential, which is why
 * it survived: nothing errors, nothing logs, a tab just opens with JSON in it.
 *
 * The admin surfaces are `.tsx`, which tsconfig.test.json excludes, so no unit
 * test can reach them — the same blind spot that let a missing CriterionStatus
 * tier reach CI. A source scan is what is available, so a source scan is what
 * this is.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ADMIN_DIR = join(process.cwd(), 'packages', 'core', 'admin');

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
  });

/** `window.open(X)` / `location.href = X` where X mentions an admin function. */
const NAVIGATION_TO_ADMIN_FUNCTION = [
  /window\.open\(\s*[^)]*(?:admin-[a-z-]+|downloadUrl|exportUrl)[^)]*\)/,
  /location\.href\s*=\s*[^;]*(?:admin-[a-z-]+|downloadUrl|exportUrl)/,
];

test('no admin page navigates the browser to an authenticated endpoint', () => {
  const offenders = [];

  for (const path of walk(ADMIN_DIR)) {
    const source = readFileSync(path, 'utf8');
    for (const pattern of NAVIGATION_TO_ADMIN_FUNCTION) {
      const match = source.match(pattern);
      if (match) offenders.push(`${path.replace(process.cwd() + '/', '')}: ${match[0].trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `A bearer-authenticated endpoint cannot be reached by navigation — it answers 401 and the browser shows the JSON:\n  ${offenders.join(
      '\n  '
    )}\nFetch it with the token and save the blob (see fetchPluginExport in lib/admin/plugins-client.ts).`
  );
});

test('the scan actually detects the shape it exists for', () => {
  // Guards the guard: the exact line PluginsPage shipped, and its replacement.
  const bad = `<Button onClick={() => window.open(card.downloadUrl!, '_blank')}>`;
  const good = `<Button onClick={() => void onDownload(card.downloadUrl!, card.downloadLabel)}>`;
  const flags = (source) => NAVIGATION_TO_ADMIN_FUNCTION.some((pattern) => pattern.test(source));

  assert.equal(flags(bad), true, 'the scan must flag a navigation to a download URL');
  assert.equal(flags(good), false, 'and must not flag an authenticated fetch');
});
