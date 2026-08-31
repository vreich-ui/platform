import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSkillZip, buildCoworkPlugin, skillDirName } from '../../packages/core/server/lib/plugin/export-claude.js';
import { createZip } from '../../packages/core/server/lib/plugin/zip.js';
import { buildManifestBundle } from '../../packages/core/server/lib/plugin/build-manifest.js';
import { visibleToolDefinitions } from '../../netlify/functions/mcp.js';

const bundle = buildManifestBundle({
  origin: 'https://drluriescience.netlify.app',
  definitions: visibleToolDefinitions(),
  voice: {
    object_id: 'voice_drlurie',
    record_version: 14,
    body: {
      name: 'Dr. Lurie — evidence-led skin health',
      tone: ['warm'],
      lexicon: { prefer: ['barrier'], avoid: ['miracle'] },
    },
  },
  platform: 'claude',
  now: () => new Date('2026-08-31T12:00:00.000Z'),
  approval: { master: 'all-autonomous', overrides: { editorial_voice: 'require-approval' } },
});

/** The tenant slug comes from the site identity — never hardcode it in a test. */
const TENANT = bundle.connection.tenant;
const DIR = skillDirName(TENANT);
/** Unzip with the system `unzip` so the assertion is about a REAL archive. */
const listAndRead = (bytes: Buffer): { names: string[]; read: (p: string) => string } => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-zip-'));
  const archive = join(dir, 'a.zip');
  writeFileSync(archive, bytes);
  const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    names: listing,
    read: (p: string) => execFileSync('unzip', ['-p', archive, p], { encoding: 'utf8' }),
  };
};

test('the zip writer produces an archive real unzip can read', () => {
  const { names, read } = listAndRead(
    createZip([
      { path: 'b.txt', content: 'beta' },
      { path: 'a.txt', content: 'alpha' },
    ])
  );
  assert.deepEqual(names, ['a.txt', 'b.txt'], 'entries must be sorted, not iteration-ordered');
  assert.equal(read('a.txt'), 'alpha');
  assert.equal(read('b.txt'), 'beta');
});

test('the zip writer is deterministic — the same input is the same bytes', () => {
  const entries = [
    { path: 'x.md', content: '# x' },
    { path: 'y/z.md', content: '# z' },
  ];
  assert.ok(createZip(entries).equals(createZip([...entries].reverse())));
});

test('utf-8 content survives the round trip', () => {
  const { read } = listAndRead(createZip([{ path: 'u.md', content: 'Dr. Lurie — évidence ✓' }]));
  assert.equal(read('u.md'), 'Dr. Lurie — évidence ✓');
});

// ─── W2.1 — the skill zip ───────────────────────────────────────────────────

test('the skill zip carries SKILL.md and its references', () => {
  const { filename, bytes } = buildSkillZip(bundle);
  assert.equal(filename, `${DIR}-skill.zip`);
  const { names, read } = listAndRead(bytes);
  assert.deepEqual(
    [...names].sort(),
    [
      `${DIR}/SKILL.md`,
      `${DIR}/references/connection.md`,
      `${DIR}/references/provenance.md`,
      `${DIR}/references/tools.md`,
    ].sort()
  );
  // The installed skill must be byte-identical to the manifest's.
  assert.equal(read(`${DIR}/SKILL.md`), bundle.skill_md);
});

test('the SKILL.md in the zip has valid frontmatter with the manifest version', () => {
  const { read } = listAndRead(buildSkillZip(bundle).bytes);
  const skill = read(`${DIR}/SKILL.md`);
  assert.ok(skill.startsWith('---\n'), 'SKILL.md must open with YAML frontmatter');
  const frontmatter = skill.slice(4, skill.indexOf('\n---', 4));
  assert.match(frontmatter, new RegExp(`^name: ${DIR}$`, 'm'));
  assert.match(frontmatter, /^description: /m);
  assert.match(frontmatter, new RegExp(`^manifest_version: ${bundle.manifest_version}$`, 'm'));
});

test('the connection reference carries the real endpoint and the auth-health probe', () => {
  const { read } = listAndRead(buildSkillZip(bundle).bytes);
  const connection = read(`${DIR}/references/connection.md`);
  assert.ok(connection.includes('https://drluriescience.netlify.app/mcp'));
  assert.ok(connection.includes('/oauth/authorize'));
  assert.ok(connection.includes('/oauth/token'));
  // W0.1: audience pinning is the top connector failure mode and is invisible
  // client-side, so the probe has to be in the operator's hands.
  assert.ok(connection.includes('mcp?health=auth'));
  assert.match(connection, /Ask/, 'the first-week manual-mode advice must survive');
});

test('the provenance reference names what the bundle was rendered from', () => {
  const { read } = listAndRead(buildSkillZip(bundle).bytes);
  const provenance = read(`${DIR}/references/provenance.md`);
  assert.ok(provenance.includes(bundle.manifest_version));
  assert.ok(provenance.includes('voice_drlurie'));
  assert.ok(provenance.includes(bundle.sources.tool_surface_digest));
  assert.ok(provenance.includes('producer.prompt_version'));
});

test('the tools reference is honest that the list is advisory', () => {
  const { read } = listAndRead(buildSkillZip(bundle).bytes);
  const tools = read(`${DIR}/references/tools.md`);
  assert.match(tools, /advisory/i);
  assert.match(tools, /not a permission boundary/i);
  assert.ok(tools.includes('object_publish'));
});

// ─── W2.2 — the Cowork .plugin bundle ───────────────────────────────────────

test('the .plugin bundle has the required Cowork layout', () => {
  const { filename, bytes } = buildCoworkPlugin(bundle);
  assert.equal(filename, `${DIR}.plugin`);
  const { names } = listAndRead(bytes);
  assert.ok(names.includes('.claude-plugin/plugin.json'), 'the manifest is required');
  assert.ok(names.includes('.mcp.json'));
  assert.ok(names.includes('README.md'));
  assert.ok(names.includes(`skills/${DIR}/SKILL.md`), 'the skill must live under skills/');
});

test('plugin.json is valid JSON with a kebab-case name and semver version', () => {
  const { read } = listAndRead(buildCoworkPlugin(bundle).bytes);
  const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as Record<string, unknown>;
  assert.equal(manifest.name, DIR);
  assert.match(String(manifest.name), /^[a-z0-9]+(-[a-z0-9]+)*$/, 'name must be kebab-case');
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/);
  assert.ok(String(manifest.description).length > 0);
});

test('.mcp.json points at the tenant endpoint over streamable HTTP and carries NO credential', () => {
  const { read } = listAndRead(buildCoworkPlugin(bundle).bytes);
  const raw = read('.mcp.json');
  const mcp = JSON.parse(raw) as { mcpServers: Record<string, { type: string; url: string; headers?: unknown }> };
  const server = mcp.mcpServers[`${TENANT}-cms`];
  assert.equal(server.type, 'http');
  assert.equal(server.url, 'https://drluriescience.netlify.app/mcp');
  assert.equal(server.headers, undefined, 'OAuth mints the token; no header credential belongs in the bundle');
  assert.ok(!/authorization|bearer|token|secret|key/i.test(raw), 'the bundle must never carry a credential');
});

test('the same skill ships in both artifacts, byte for byte', () => {
  const fromZip = listAndRead(buildSkillZip(bundle).bytes).read(`${DIR}/SKILL.md`);
  const fromPlugin = listAndRead(buildCoworkPlugin(bundle).bytes).read(`skills/${DIR}/SKILL.md`);
  assert.equal(fromZip, fromPlugin);
  assert.equal(fromZip, bundle.skill_md);
});

test('neither export leaks a secret-shaped string', () => {
  for (const artifact of [buildSkillZip(bundle), buildCoworkPlugin(bundle)]) {
    const text = artifact.bytes.toString('utf8');
    assert.ok(!/PUBLISH_SECRET|MCP_HTTP_AUTH_TOKEN|NETLIFY_[A-Z_]*TOKEN|client_secret/i.test(text));
  }
});
