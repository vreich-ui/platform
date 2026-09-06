#!/usr/bin/env node
/**
 * docs/generated/INVENTORY.md generator.
 *
 * Mechanical enumeration of code-level facts the architecture docs make
 * claims about (function inventory, MCP tool surface, governed object
 * types, tracking event kinds, env-var names, tenants, blob namespaces,
 * diagrams, section components, patch ops). Every number here is derived
 * by reading the working tree with plain string/regex parsing — no
 * TypeScript compilation, no new dependencies.
 *
 * Usage:
 *   node scripts/docs/inventory.mjs            # render to stdout
 *   node scripts/docs/inventory.mjs --write    # write docs/generated/INVENTORY.md
 *
 * `renderInventory()` is exported so tests/scripts/docs-inventory-fresh.test.mjs
 * can call it in-process and diff it against the committed file without
 * shelling out. Only the header's git-sha and generated-at lines are
 * expected to change between runs; every other line is a deterministic
 * function of the working tree (sorted names, sorted tables).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, '..', '..');

const abs = (...parts) => path.join(ROOT, ...parts);
const relToRoot = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ─── low-level fs helpers ───

function readText(relPath) {
  try {
    return readFileSync(abs(relPath), 'utf8');
  } catch {
    return null;
  }
}

function dirExists(relPath) {
  return existsSync(abs(relPath));
}

function listDirNames(relPath) {
  if (!dirExists(relPath)) return [];
  return readdirSync(abs(relPath), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Non-recursive: *.ts files directly in a dir, optionally excluding *.test.ts. */
function listTsFiles(relPath, { excludeTest = true } = {}) {
  if (!dirExists(relPath)) return [];
  return readdirSync(abs(relPath))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !excludeTest || !f.endsWith('.test.ts'))
    .sort();
}

/** Recursive walk of a directory, returning repo-relative paths matching any of `exts`. */
function walkFiles(relPath, exts) {
  const out = [];
  const startAbs = abs(relPath);
  if (!existsSync(startAbs)) return out;
  const walk = (dirAbs) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && exts.some((ext) => e.name.endsWith(ext))) {
        out.push(relToRoot(full));
      }
    }
  };
  walk(startAbs);
  return out;
}

function gitHeadShort() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ─── source-block parsing helpers (no AST — plain line scanning) ───

/**
 * Extract the body lines of `export const NAME = [ ... ];` / `... ] as const;`,
 * given the opening line ends in `[`. Returns null if the pattern isn't found.
 */
function extractArrayBlock(text, constName) {
  if (!text) return null;
  const lines = text.split('\n');
  const startRe = new RegExp(`^export const ${constName}\\b.*\\[\\s*$`);
  const startIdx = lines.findIndex((l) => startRe.test(l.trim()));
  if (startIdx === -1) return null;
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '];' || t === '] as const;') return body;
    body.push(lines[i]);
  }
  return null;
}

/** Extract the body lines of `export const NAME[: Type] = { ... };`, opening line ends in `{`. */
function extractBraceBlock(text, constName) {
  if (!text) return null;
  const lines = text.split('\n');
  const startRe = new RegExp(`^export const ${constName}\\b.*\\{\\s*$`);
  const startIdx = lines.findIndex((l) => startRe.test(l.trim()));
  if (startIdx === -1) return null;
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '};') return body;
    body.push(lines[i]);
  }
  return null;
}

/** Pull single-quoted string literals out of an array block's lines, skipping comment lines. */
function quotedItemsFromBlock(bodyLines) {
  if (!bodyLines) return [];
  const items = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const m = line.match(/^'([^']+)'\s*,?\s*$/);
    if (m) items.push(m[1]);
  }
  return items;
}

/** Pull `key: [ 'a', 'b' ]` entries out of a brace block's lines (PLATFORM_ENV_NAMES shape). */
function keyToArrayFromBlock(bodyLines) {
  if (!bodyLines) return [];
  const out = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*')) continue;
    const m = line.match(/^(\w+):\s*\[([^\]]*)\]\s*,?\s*$/);
    if (m) {
      const names = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      out.push({ key: m[1], names });
    }
  }
  return out;
}

/** Pull `key: 'value'` entries out of a brace block's lines (PDF_TOOL_STORES shape). */
function keyToStringFromBlock(bodyLines) {
  if (!bodyLines) return [];
  const out = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*')) continue;
    const m = line.match(/^(\w+):\s*'([^']+)'\s*,?\s*$/);
    if (m) out.push({ key: m[1], value: m[2] });
  }
  return out;
}

/** Every `name: 'x'` at the start of a line — the shape every ToolDefinition/object-type entry uses. */
function toolNamesFromText(text) {
  if (!text) return [];
  const names = [];
  const re = /^\s*name:\s*'([^']+)'\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(text))) names.push(m[1]);
  return names;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|');
}

// ─── section builders ───

const TENANT_ORDER = ['drlurie', 'fernwell', 'platform', 'zilberman'];

function tenantFunctionDirs() {
  // (task spec) root netlify/functions/*.ts IS the drlurie shim set; sites/drlurie
  // itself carries no netlify/functions dir (verified against the working tree).
  const dirs = [{ tenant: 'drlurie', dir: 'netlify/functions' }];
  for (const site of listDirNames('sites')) {
    const candidate = `sites/${site}/netlify/functions`;
    if (dirExists(candidate)) dirs.push({ tenant: site, dir: candidate });
  }
  // Stable order: known tenants first in fixed order, then any unforeseen ones alphabetically.
  dirs.sort((a, b) => {
    const ia = TENANT_ORDER.indexOf(a.tenant);
    const ib = TENANT_ORDER.indexOf(b.tenant);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.tenant.localeCompare(b.tenant);
  });
  return dirs;
}

function buildFunctionInventory() {
  const lines = [];
  const coreNames = listTsFiles('packages/core/server/functions');
  lines.push('### Core handler modules');
  lines.push('');
  lines.push(`\`packages/core/server/functions/*.ts\` (non-test): **${coreNames.length}**`);
  lines.push('');
  for (const n of coreNames) lines.push(`- ${n}`);
  lines.push('');

  const tenants = tenantFunctionDirs();
  const perTenantNames = new Map();
  for (const { tenant, dir } of tenants) perTenantNames.set(tenant, new Set(listTsFiles(dir)));

  lines.push('### Per-tenant shim inventory');
  lines.push('');
  lines.push('| Tenant | Shim dir | Count |');
  lines.push('|---|---|---|');
  for (const { tenant, dir } of tenants) {
    lines.push(`| ${tenant} | \`${dir}\` | ${perTenantNames.get(tenant).size} |`);
  }
  lines.push('');

  const allNames = new Set();
  for (const set of perTenantNames.values()) for (const n of set) allNames.add(n);
  const sortedAllNames = [...allNames].sort();

  lines.push('### Shim name x tenant matrix');
  lines.push('');
  lines.push(`| Function | ${tenants.map((t) => t.tenant).join(' | ')} |`);
  lines.push(`|---|${tenants.map(() => '---').join('|')}|`);
  for (const name of sortedAllNames) {
    const cells = tenants.map(({ tenant }) => (perTenantNames.get(tenant).has(name) ? '✓' : '—'));
    lines.push(`| ${mdEscape(name)} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  const coreSet = new Set(coreNames);
  const shimsWithNoCore = sortedAllNames.filter((n) => !coreSet.has(n));
  const coreWithNoShim = coreNames.filter((n) => !allNames.has(n));

  lines.push('### Shims with no core module');
  lines.push('');
  if (shimsWithNoCore.length === 0) {
    lines.push('(none)');
  } else {
    for (const n of shimsWithNoCore) {
      const owners = tenants.filter(({ tenant }) => perTenantNames.get(tenant).has(n)).map((t) => t.tenant);
      lines.push(`- ${n} (present in: ${owners.join(', ')})`);
    }
  }
  lines.push('');

  lines.push('### Core modules with no shim anywhere');
  lines.push('');
  if (coreWithNoShim.length === 0) {
    lines.push('(none)');
  } else {
    for (const n of coreWithNoShim) lines.push(`- ${n}`);
  }
  lines.push('');

  return { lines, coreCount: coreNames.length, tenants, perTenantNames };
}

function buildScheduledFunctions() {
  const lines = [];
  const tomlSources = [
    { tenant: 'drlurie', path: 'netlify.toml' },
    ...listDirNames('sites')
      .map((site) => ({ tenant: site, path: `sites/${site}/netlify.toml` }))
      .filter((s) => dirExists(s.path) || existsSync(abs(s.path))),
  ].filter((s) => existsSync(abs(s.path)));
  tomlSources.sort((a, b) => {
    const ia = TENANT_ORDER.indexOf(a.tenant);
    const ib = TENANT_ORDER.indexOf(b.tenant);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.tenant.localeCompare(b.tenant);
  });

  const perTenantSchedules = new Map();
  for (const { tenant, path: tomlPath } of tomlSources) {
    const text = readText(tomlPath) ?? '';
    const map = new Map();
    let current = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      const sectionMatch = line.match(/^\[functions\."([^"]+)"\]$/);
      if (sectionMatch) {
        current = sectionMatch[1];
        continue;
      }
      if (line.startsWith('[') && !sectionMatch) {
        current = null;
        continue;
      }
      const scheduleMatch = line.match(/^schedule\s*=\s*"([^"]+)"$/);
      if (scheduleMatch && current) {
        map.set(current, scheduleMatch[1]);
      }
    }
    perTenantSchedules.set(tenant, map);
  }

  const allNames = new Set();
  for (const map of perTenantSchedules.values()) for (const n of map.keys()) allNames.add(n);
  const sortedNames = [...allNames].sort();

  lines.push(`Sources: ${tomlSources.map((s) => `\`${s.path}\` (${s.tenant})`).join(', ')}.`);
  lines.push('');
  lines.push(`| Scheduled function | ${tomlSources.map((s) => s.tenant).join(' | ')} |`);
  lines.push(`|---|${tomlSources.map(() => '---').join('|')}|`);
  for (const name of sortedNames) {
    const cells = tomlSources.map(({ tenant }) => perTenantSchedules.get(tenant).get(name) ?? '—');
    lines.push(`| ${mdEscape(name)} | ${cells.map((c) => (c === '—' ? c : `\`${mdEscape(c)}\``)).join(' | ')} |`);
  }
  lines.push('');
  return lines;
}

function buildMcpToolSurface() {
  const lines = [];
  // Every `mcp-tool-definitions*.ts` module under server/lib (tests excluded) — the
  // set `packages/core/server/functions/mcp.ts` concatenates. Discovered, not listed,
  // so a new definitions file (e.g. the W21 analytics one) cannot be silently missed.
  const files = readdirSync(abs('packages/core/server/lib'))
    .filter((name) => /^mcp-tool-definitions.*\.ts$/.test(name) && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => ({ label: name, path: `packages/core/server/lib/${name}` }));
  const perFile = files.map((f) => ({ ...f, names: toolNamesFromText(readText(f.path)) }));
  const total = perFile.reduce((sum, f) => sum + f.names.length, 0);
  const allNames = perFile.flatMap((f) => f.names);
  const uniqueNames = new Set(allNames);

  const testPath = 'packages/core/server/lib/mcp-tool-definitions.test.ts';
  const testText = readText(testPath) ?? '';
  const pinnedMatch = testText.match(/TOOL_DEFINITIONS\.length,\s*(\d+)/);
  const pinnedCount = pinnedMatch ? Number(pinnedMatch[1]) : null;

  lines.push('| Source file | Tool count |');
  lines.push('|---|---|');
  for (const f of perFile) lines.push(`| \`${f.path}\` | ${f.names.length} |`);
  lines.push(`| **Total** | **${total}** |`);
  lines.push('');
  lines.push(
    `Duplicate names across files: ${allNames.length - uniqueNames.size === 0 ? 'none' : allNames.length - uniqueNames.size}.`
  );
  lines.push('');
  if (pinnedCount === null) {
    lines.push(`Test-pinned count: could not find a \`TOOL_DEFINITIONS.length, N\` assertion in \`${testPath}\`.`);
  } else if (pinnedCount === total) {
    lines.push(`Matches the count pinned by \`${testPath}\`: **${pinnedCount}**.`);
  } else {
    lines.push(
      `**MISMATCH**: this generator counted ${total} tool definitions, but \`${testPath}\` pins ${pinnedCount}. Investigate before trusting this section.`
    );
  }
  lines.push('');
  lines.push('### All tool names (sorted)');
  lines.push('');
  for (const n of [...uniqueNames].sort()) lines.push(`- ${n}`);
  lines.push('');
  return lines;
}

function buildGovernedObjectTypes() {
  const lines = [];
  const text = readText('packages/core/schema/object-record-v1.ts');
  const types = quotedItemsFromBlock(extractArrayBlock(text, 'objectTypes'));

  lines.push(`\`packages/core/schema/object-record-v1.ts\`'s \`objectTypes\`: **${types.length}**`);
  lines.push('');
  lines.push('| Object type | Body schema | Materializer |');
  lines.push('|---|---|---|');
  for (const type of types) {
    const bodyFile = `${type.replace(/_/g, '-')}-v1.ts`;
    const bodyPath = `packages/core/schema/bodies/${bodyFile}`;
    const bodyStatus = dirExists(bodyPath) ? 'present' : 'ABSENT';

    const materializerFile = `${type.replace(/_/g, '-')}.ts`;
    const materializerPath = `packages/core/server/lib/materializers/${materializerFile}`;
    const materializerStatus = dirExists(materializerPath) ? 'present' : 'absent';

    lines.push(`| ${type} | \`${bodyPath}\` (${bodyStatus}) | \`${materializerPath}\` (${materializerStatus}) |`);
  }
  lines.push('');
  return lines;
}

function buildTrackingEventKinds() {
  const lines = [];
  const text = readText('packages/core/schema/bodies/tracking-config-v1.ts');
  const kinds = quotedItemsFromBlock(extractArrayBlock(text, 'TRACKING_EVENT_KINDS'));
  lines.push(`\`TRACKING_EVENT_KINDS\`: **${kinds.length}**`);
  lines.push('');
  for (const k of kinds) lines.push(`- ${k}`);
  lines.push('');
  return lines;
}

const ENV_SCAN_ROOTS = ['packages/core/server', 'netlify', 'scripts'];

function envScanFileList() {
  const files = [];
  for (const root of ENV_SCAN_ROOTS) {
    files.push(...walkFiles(root, ['.ts', '.mjs', '.js']));
  }
  for (const site of listDirNames('sites')) {
    files.push(...walkFiles(`sites/${site}/netlify`, ['.ts', '.mjs', '.js']));
  }
  // Exclude this generator itself (scripts/docs/inventory.mjs): its own doc
  // comments illustrate the patterns being searched for (literally containing
  // text like "process.env.X"), which would otherwise self-pollute the scan.
  const selfPath = relToRoot(__filename);
  return files
    .filter((f) => f !== selfPath)
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.mjs') && !f.endsWith('.test.js'));
}

function buildEnvVars() {
  const lines = [];
  const bindingText = readText('packages/core/server/lib/site-binding.ts');
  const platformEnvEntries = keyToArrayFromBlock(extractBraceBlock(bindingText, 'PLATFORM_ENV_NAMES'));

  lines.push('### `PLATFORM_ENV_NAMES` (packages/core/server/lib/site-binding.ts)');
  lines.push('');
  lines.push('| Binding key | Env var names (first non-empty wins) |');
  lines.push('|---|---|');
  for (const { key, names } of platformEnvEntries) {
    lines.push(`| ${key} | ${names.map((n) => `\`${n}\``).join(', ')} |`);
  }
  lines.push('');

  const files = envScanFileList();
  const nameRe = /process\.env\.([A-Z_][A-Z0-9_]*)|\benv\.([A-Z_][A-Z0-9_]*)\b|env\.get\('([A-Z_][A-Z0-9_]*)'\)/g;
  const occurrencesByName = new Map(); // name -> Set(relPath)
  for (const relPath of files) {
    const text = readText(relPath) ?? '';
    let m;
    nameRe.lastIndex = 0;
    while ((m = nameRe.exec(text))) {
      const name = m[1] || m[2] || m[3];
      if (!name) continue;
      if (!occurrencesByName.has(name)) occurrencesByName.set(name, new Set());
      occurrencesByName.get(name).add(relPath);
    }
  }
  const sortedNames = [...occurrencesByName.keys()].sort();
  const scriptsOnly = sortedNames.filter((n) => [...occurrencesByName.get(n)].every((p) => p.startsWith('scripts/')));

  lines.push(
    `### Literal env-var names referenced (\`process.env.X\`, bare \`env.X\`, \`env.get('X')\`) across ${ENV_SCAN_ROOTS.join(', ')}, sites/*/netlify, excluding tests`
  );
  lines.push('');
  lines.push(`Count: **${sortedNames.length}** (scripts-only: ${scriptsOnly.length})`);
  lines.push('');
  lines.push('| Env var | Scripts-only |');
  lines.push('|---|---|');
  for (const n of sortedNames) {
    lines.push(`| ${n} | ${scriptsOnly.includes(n) ? 'yes' : '—'} |`);
  }
  lines.push('');
  return lines;
}

function buildTenants() {
  const lines = [];
  lines.push('| Tenant dir | siteId | siteSlug | mcpServerName | canonicalHost |');
  lines.push('|---|---|---|---|---|');
  for (const site of listDirNames('sites')) {
    const identityText = readText(`sites/${site}/config/site-identity.ts`);
    const configText = readText(`sites/${site}/site.config.ts`);
    const pick = (text, key) => {
      if (!text) return '?';
      const m = text.match(new RegExp(`\\b${key}:\\s*'([^']+)'`));
      return m ? m[1] : '?';
    };
    const siteId = pick(identityText, 'siteId');
    const siteSlug = pick(identityText, 'siteSlug');
    const mcpServerName = pick(identityText, 'mcpServerName');
    const canonicalHost = pick(configText, 'canonicalHost');
    lines.push(`| sites/${site} | ${siteId} | ${siteSlug} | ${mcpServerName} | ${canonicalHost} |`);
  }
  lines.push('');
  return lines;
}

function buildBlobNamespaces() {
  const lines = [];
  const createSiteText = readText('packages/core/cli/create-site.mjs');
  const coreStores = quotedItemsFromBlock(extractArrayBlock(createSiteText, 'CORE_BLOB_STORES'));

  // Spec location is packages/core/cli/create-site.mjs; as of this commit
  // PDF_TOOL_STORES actually lives in scripts/provision-pdf-tool-stores.mjs
  // (true at 6789644 too — not something the 689-692 range moved). Look in
  // the spec location first, fall back, and say plainly where it was found.
  let pdfToolSource = 'packages/core/cli/create-site.mjs';
  let pdfToolBlock = extractBraceBlock(createSiteText, 'PDF_TOOL_STORES');
  if (!pdfToolBlock) {
    pdfToolSource = 'scripts/provision-pdf-tool-stores.mjs';
    pdfToolBlock = extractBraceBlock(readText(pdfToolSource), 'PDF_TOOL_STORES');
  }
  const pdfToolEntries = keyToStringFromBlock(pdfToolBlock);
  const pdfToolStores = pdfToolEntries.map((e) => e.value);

  lines.push(`\`CORE_BLOB_STORES\` (packages/core/cli/create-site.mjs): **${coreStores.length}**`);
  lines.push('');
  for (const s of [...coreStores].sort()) lines.push(`- ${s}`);
  lines.push('');
  lines.push(
    `\`PDF_TOOL_STORES\` — NOTE: not found in \`packages/core/cli/create-site.mjs\`; found in \`${pdfToolSource}\` instead: **${pdfToolStores.length}**`
  );
  lines.push('');
  for (const e of pdfToolEntries) lines.push(`- ${e.key} → \`${e.value}\``);
  lines.push('');

  const union = new Set([...coreStores, ...pdfToolStores]);
  lines.push(`Union of both sets: **${union.size}**`);
  lines.push('');
  for (const s of [...union].sort()) lines.push(`- ${s}`);
  lines.push('');
  return lines;
}

function buildDiagrams() {
  const lines = [];
  if (!dirExists('docs/diagrams')) {
    lines.push('(no docs/diagrams directory)');
    lines.push('');
    return lines;
  }
  const mmdFiles = readdirSync(abs('docs/diagrams'))
    .filter((f) => f.endsWith('.mmd'))
    .sort();
  lines.push(`\`docs/diagrams/*.mmd\`: **${mmdFiles.length}**`);
  lines.push('');
  lines.push('| Diagram | .mmd | .svg |');
  lines.push('|---|---|---|');
  for (const f of mmdFiles) {
    const base = f.slice(0, -4);
    const svgExists = dirExists(`docs/diagrams/${base}.svg`);
    lines.push(`| ${base} | yes | ${svgExists ? 'yes' : 'MISSING'} |`);
  }
  lines.push('');
  return lines;
}

function buildSectionsAndPatchOps() {
  const lines = [];
  const sectionFiles = dirExists('packages/core/components/sections')
    ? readdirSync(abs('packages/core/components/sections'))
        .filter((f) => f.endsWith('.astro'))
        .sort()
    : [];
  lines.push(`\`packages/core/components/sections/*.astro\`: **${sectionFiles.length}**`);
  lines.push('');

  const patchOpsText = readText('packages/core/schema/object-patch-ops.ts');
  if (patchOpsText) {
    const opNames = [];
    const re = /op:\s*z\.literal\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(patchOpsText))) opNames.push(m[1]);
    if (opNames.length > 0) {
      lines.push(
        `\`packages/core/schema/object-patch-ops.ts\` patch ops (\`op: z.literal(...)\`): **${opNames.length}**`
      );
      lines.push('');
      for (const n of [...opNames].sort()) lines.push(`- ${n}`);
      lines.push('');
    } else {
      lines.push(
        'Patch-op list in `packages/core/schema/object-patch-ops.ts` was not easily parsable by regex — omitted.'
      );
      lines.push('');
    }
  } else {
    lines.push('`packages/core/schema/object-patch-ops.ts` not found.');
    lines.push('');
  }
  return lines;
}

// ─── top-level render ───

export function renderInventory() {
  const out = [];
  out.push('# Docs Inventory (generated)');
  out.push('');
  out.push('Generated by `node scripts/docs/inventory.mjs`. Do not hand-edit — regenerate with');
  out.push('`node scripts/docs/inventory.mjs --write` and see `tests/scripts/docs-inventory-fresh.test.mjs`.');
  out.push('');
  out.push(`- Git HEAD: \`${gitHeadShort()}\``);
  out.push(`- Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push('---');
  out.push('');

  out.push('## 1. Netlify function inventory');
  out.push('');
  out.push(...buildFunctionInventory().lines);

  out.push('## 2. Scheduled functions');
  out.push('');
  out.push(...buildScheduledFunctions());

  out.push('## 3. MCP tool surface');
  out.push('');
  out.push(...buildMcpToolSurface());

  out.push(
    '## 4. Object types (`objectTypes`; the publish-gate subset is `governedObjectTypes` in `packages/core/lib/approval-policy.ts`)'
  );
  out.push('');
  out.push(...buildGovernedObjectTypes());

  out.push('## 5. Tracking event kinds');
  out.push('');
  out.push(...buildTrackingEventKinds());

  out.push('## 6. Environment variable names');
  out.push('');
  out.push(...buildEnvVars());

  out.push('## 7. Tenants');
  out.push('');
  out.push(...buildTenants());

  out.push('## 8. Blob namespaces');
  out.push('');
  out.push(...buildBlobNamespaces());

  out.push('## 9. Diagrams');
  out.push('');
  out.push(...buildDiagrams());

  out.push('## 10. Section components and patch ops');
  out.push('');
  out.push(...buildSectionsAndPatchOps());

  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

// ─── CLI entry point ───

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === __filename;
}

if (isMainModule()) {
  const md = renderInventory();
  if (process.argv.includes('--write')) {
    const outPath = abs('docs/generated/INVENTORY.md');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, md);
    console.error(`Wrote ${relToRoot(outPath)}`);
  } else {
    process.stdout.write(md);
  }
}
