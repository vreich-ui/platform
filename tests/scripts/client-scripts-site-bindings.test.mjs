/**
 * W14 T14.0 — client-bundle site-binding lint (admin-login regression guard).
 *
 * W11 T11.5 made the GoTrue localStorage keys (and the edit-mode media policy)
 * resolve through the provider seams in `packages/core/lib/site-identity.ts` /
 * `media-policy.ts`. Those seams THROW until a site registers its providers via
 * the active site's `config/policy-bindings`. Every consumer of `goTrueClient`
 * wraps its storage access in `try/catch`, so an unregistered provider does not
 * surface as an error — it degrades silently to "always signed out": a valid
 * session is never read, and a successful sign-in is never persisted.
 *
 * Astro compiles each `<script>` block in a `.astro` file as its own client
 * entry. An entry only gets the registration if IT imports the bindings — being
 * on the same page as a React island that does is a hydration-order race, not a
 * guarantee (that race is exactly how `/admin` regressed: sign-in appeared to
 * work once, then every reload showed the signed-out gate again).
 *
 * The rule this locks in: a client `<script>` block that reaches an
 * identity-dependent core module must import the site policy bindings in the
 * same block. Frontmatter (server-side, `---` fenced) is out of scope — Astro
 * renders it in a Node context whose entry has already registered the
 * providers.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { realTenantNames } from './scratch-sites.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_APP = join(ROOT, 'packages', 'core', 'app');
const SITES = join(ROOT, 'sites');
const ISLANDS = join(CORE_APP, 'admin');

/** Core modules that resolve site identity / policy through a provider seam. */
const IDENTITY_DEPENDENT = ['@core/lib/admin/goTrueClient', '@core/lib/edit-mode/index', '@core/lib/site-identity'];

const BINDINGS = ['~/config/policy-bindings', '@site/config/policy-bindings'];

const walk = (dir, extension, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, extension, out);
    else if (name.endsWith(extension)) out.push(p);
  }
  return out;
};

/**
 * Core plus every real tenant's app. Scratch tenants are excluded: admin-parity.test.mjs
 * scaffolds them under `sites/` and node:test runs test FILES concurrently, so one can be
 * on disk mid-walk. See tests/scripts/scratch-sites.mjs.
 */
const appRoots = () => [
  CORE_APP,
  ...realTenantNames(SITES)
    .map((name) => join(SITES, name, 'app'))
    .filter(existsSync),
];

/** Everything after the closing frontmatter fence (or the whole file if none). */
const templateBody = (source) => {
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  return end === -1 ? '' : source.slice(end + 4);
};

/** The inner text of every `<script>` block that Astro bundles for the client. */
const clientScriptBlocks = (source) => {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(templateBody(source))) !== null) {
    const attrs = m[1];
    // `is:inline` scripts are emitted verbatim — Vite never bundles them, so
    // they cannot import anything and are not in scope for this rule.
    if (/\bis:inline\b/.test(attrs)) continue;
    if (/\bsrc=/.test(attrs)) continue;
    blocks.push(m[2]);
  }
  return blocks;
};

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const importIndex = (source, specifier) => {
  const cleaned = withoutComments(source);
  const escaped = escapeRegExp(specifier);
  const patterns = [
    new RegExp(`\\bimport\\s*\\(\\s*['"]${escaped}['"]`),
    new RegExp(`\\bimport\\s+(?:[^;]*?\\s+from\\s+)?['"]${escaped}['"]`),
  ];
  const indexes = patterns.map((pattern) => cleaned.search(pattern)).filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
};
const importsModule = (block, specifier) => importIndex(block, specifier) >= 0;
const importsBindings = (block) => BINDINGS.some((specifier) => importsModule(block, specifier));

const inspectClientScripts = (files) => {
  const offenders = [];
  let candidates = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    clientScriptBlocks(source).forEach((block, index) => {
      const reached = IDENTITY_DEPENDENT.filter((specifier) => importsModule(block, specifier));
      if (reached.length === 0) return;
      candidates += 1;
      if (importsBindings(block)) return;
      offenders.push(
        `${file.slice(ROOT.length + 1)} <script> #${index}: imports ${reached.join(', ')} without site bindings`
      );
    });
  }
  return { candidates, offenders };
};

const inspectIslandSource = (source, label = '<island>') => {
  const cleaned = withoutComments(source);
  const reExport = cleaned.match(/export\s*\{\s*default\s*\}\s*from\s*['"]@core\/admin\/[^'"]+['"]/);
  if (!reExport || reExport.index === undefined) return null;
  const bindingIndexes = BINDINGS.map((specifier) => importIndex(cleaned, specifier)).filter((index) => index >= 0);
  const bindingIndex = bindingIndexes.length > 0 ? Math.min(...bindingIndexes) : -1;
  return bindingIndex >= 0 && bindingIndex < reExport.index
    ? null
    : `${label}: must import site policy bindings before re-exporting its core admin component`;
};

test('client <script> blocks that reach identity-dependent core modules import the site policy bindings', () => {
  const files = appRoots().flatMap((root) => walk(root, '.astro'));
  const { candidates, offenders } = inspectClientScripts(files);
  assert.ok(candidates > 0, 'site-binding guard found zero identity-dependent client <script> candidates');
  assert.deepEqual(
    offenders,
    [],
    `client scripts reach site-identity without registering the site providers ` +
      `(silently degrades to "always signed out"):\n${offenders.join('\n')}`
  );
});

test('every React admin island imports the site bindings before re-exporting its core component', () => {
  const files = walk(ISLANDS, '.ts');
  const candidates = [];
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!/export\s*\{\s*default\s*\}\s*from\s*['"]@core\/admin\//.test(withoutComments(source))) continue;
    candidates.push(file);
    const offender = inspectIslandSource(source, file.slice(ROOT.length + 1));
    if (offender) offenders.push(offender);
  }
  assert.ok(candidates.length > 0, 'site-binding guard found zero React admin island candidates');
  assert.deepEqual(offenders, [], `admin islands missing an early site-binding import:\n${offenders.join('\n')}`);
});

test('the rule actually fires — a script importing goTrueClient with no bindings is an offence', () => {
  const bad = `---\n---\n<script>\n  import { currentUser } from '@core/lib/admin/goTrueClient';\n  currentUser();\n</script>\n`;
  const blocks = clientScriptBlocks(bad);
  assert.equal(blocks.length, 1);
  assert.ok(importsModule(blocks[0], '@core/lib/admin/goTrueClient'));
  assert.ok(!importsBindings(blocks[0]));

  const good = `---\n---\n<script>\n  import '~/config/policy-bindings';\n  import { currentUser } from '@core/lib/admin/goTrueClient';\n</script>\n`;
  assert.ok(importsBindings(clientScriptBlocks(good)[0]));

  const currentAlias = `---\n---\n<script>\n  import '@site/config/policy-bindings';\n  import { currentUser } from '@core/lib/admin/goTrueClient';\n</script>\n`;
  assert.ok(importsBindings(clientScriptBlocks(currentAlias)[0]));
});

test('the island rule fires when bindings are missing or imported after the re-export', () => {
  const missing = `export { default } from '@core/admin/AdminHome';\n`;
  const late = `export { default } from '@core/admin/AdminHome';\nimport '@site/config/policy-bindings';\n`;
  const good = `import '@site/config/policy-bindings';\nexport { default } from '@core/admin/AdminHome';\n`;
  const commented = `// import '@site/config/policy-bindings';\nexport { default } from '@core/admin/AdminHome';\n`;
  assert.match(inspectIslandSource(missing) ?? '', /must import/);
  assert.match(inspectIslandSource(late) ?? '', /before re-exporting/);
  assert.match(inspectIslandSource(commented) ?? '', /must import/);
  assert.equal(inspectIslandSource(good), null);
});

test('frontmatter imports are out of scope (server-side render path)', () => {
  const frontmatterOnly = `---\nimport { getSiteIdentity } from '@core/lib/site-identity';\n---\n<p>{getSiteIdentity().brandName}</p>\n`;
  assert.deepEqual(clientScriptBlocks(frontmatterOnly), []);
});

test('is:inline scripts are out of scope (never bundled, cannot import)', () => {
  const inline = `---\n---\n<script is:inline>\n  window.x = '@core/lib/admin/goTrueClient';\n</script>\n`;
  assert.deepEqual(clientScriptBlocks(inline), []);
});
