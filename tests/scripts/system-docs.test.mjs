// docs/system/* invariants: every system document is pinned to the same four
// commits, every relative link resolves, and the literals the documents rely on
// still match the code (scripts/docs/system-contracts.mjs --check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'docs', 'system');
const lock = JSON.parse(readFileSync(join(dir, 'system-contracts.lock.json'), 'utf8'));
const docs = readdirSync(dir).filter((f) => f.endsWith('.md'));

test('docs/system exists and carries the fourteen system documents', () => {
  const required = [
    'AI-SYSTEM-CONTEXT.md', 'SYSTEM-ARCHITECTURE.md', 'SYSTEM-AUTHORITY-MATRIX.md', 'SYSTEM-CONTRACTS.md',
    'SYSTEM-DATA-FLOW.md', 'SYSTEM-IDENTIFIERS.md', 'SYSTEM-PUBLISHING.md', 'SYSTEM-ARTIFACTS.md',
    'SYSTEM-TRACKING-AND-ATTRIBUTION.md', 'SYSTEM-AGENT-ARCHITECTURE.md', 'SYSTEM-SECURITY-BOUNDARIES.md',
    'SYSTEM-OPERATIONS.md', 'SYSTEM-KNOWN-ISSUES.md', 'SYSTEM-FUTURE-EXTENSIONS.md', 'SYSTEM-CONFLICT-LEDGER.md',
  ];
  for (const f of required) assert.ok(docs.includes(f), `missing ${f}`);
});

test('every system document is pinned to the four commits in the lock', () => {
  for (const f of docs) {
    const head = readFileSync(join(dir, f), 'utf8').slice(0, 2000);
    for (const [name, sha] of Object.entries(lock.pins)) {
      assert.ok(head.includes(`${name}=${sha}`), `${f} does not carry ${name}=${sha} in its header`);
    }
  }
});

test('every relative link in docs/system resolves', () => {
  const broken = [];
  for (const f of docs) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue; // http(s), mailto
      if (!existsSync(resolve(dir, target))) broken.push(`${f} → ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('system-contracts.mjs --check passes (platform-local fields; sibling repos when present)', () => {
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'docs', 'system-contracts.mjs'), '--check'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
