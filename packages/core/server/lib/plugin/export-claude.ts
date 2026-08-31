/**
 * Claude exports (W2.1, W2.2) — the two artifacts a human installs.
 *
 *   SKILL ZIP    skills/<tenant>-publisher/{SKILL.md,references/*}
 *                Uploaded to org skills. The cheapest way to prove the loop:
 *                it needs no plugin machinery, only the custom connector.
 *
 *   .plugin      A Cowork plugin bundle carrying the SAME skill plus an
 *                `.mcp.json` pointing at the tenant endpoint, so installing one
 *                file wires both halves.
 *
 * Both are rendered from the manifest bundle — never hand-assembled — so the
 * skill a human installs is byte-identical to the one the manifest holds, and
 * `manifest_version` travels with it. That is the plan's answer to skill drift:
 * an export whose version no longer matches the active manifest is stale, and
 * the admin can say so.
 */
import { createZip, type ZipEntry } from './zip.js';
import type { ManifestBundle } from './manifest-types.js';

export const skillDirName = (tenant: string): string => `${tenant}-publisher`;

/** Human-facing setup card. The operator steps that cannot be automated. */
const connectionReference = (bundle: ManifestBundle): string => {
  const c = bundle.connection;
  return `# Connecting to ${c.tenant}

This skill writes articles. It can only PUBLISH them once the connector below is
attached, because every publishing tool lives on the tenant's own MCP endpoint.

## The connector

| field | value |
|---|---|
| Remote MCP URL | \`${c.mcp_url}\` |
| OAuth | required (the endpoint refuses anonymous calls) |
| Authorization URL | \`${c.oauth.authorization_url}\` |
| Token URL | \`${c.oauth.token_url}\` |
| Dynamic client registration | \`${c.oauth.registration_url}\` |

Discovery documents, if the client asks for them:

- \`${c.oauth.authorization_server_metadata_url}\`
- \`${c.oauth.protected_resource_metadata_url}\`

## When authorization fails

Audience pinning is the most common cause and it is invisible from the client
side: a token minted through a host that is not in the deploy's accepted list is
refused permanently, and the error looks exactly like a bad credential.

Open **\`${c.mcp_auth_health_url}\`** — it needs no authentication and answers
both questions at once: which audiences this deploy accepts, and whether it can
read its own token store at all (a store outage refuses every token while
looking like a wrong password).

## Suggested first week

Set the publishing tools to **Ask** rather than Allow — \`object_create\`,
\`object_patch\`, \`object_publish\`, \`release_to_production\`. The plugin is
human-driven by design and the per-tool controls give you a manual mode with no
code change. Loosen once you trust the output.

---

Rendered from manifest \`${bundle.manifest_version}\` on ${bundle.rendered_at}.
`;
};

/** The tool table, kept beside the skill so SKILL.md stays about the work. */
const toolsReference = (bundle: ManifestBundle): string => {
  const rows = bundle.tools
    .map((t) => `| \`${t.name}\` | ${t.tool_class} | ${t.consequential ? 'writes' : 'read-only'} | ${t.summary} |`)
    .join('\n');
  return `# Tools this plugin uses

Derived from the tenant's live tool surface at render time — not hand-maintained.
\`class\` is the tool's own governance class; \`writes\` is computed from it.

**This list is advisory.** The endpoint will answer tools that are not on it. It
describes the job, not a permission boundary — the human driving the session is
the gate.

| tool | class | effect | what it is for |
|---|---|---|---|
${rows}

---

Rendered from manifest \`${bundle.manifest_version}\`. Tool-surface digest
\`${bundle.sources.tool_surface_digest}\` — if this no longer matches the tenant,
the export is stale and should be re-downloaded.
`;
};

/** What the bundle was rendered from, so a stale install is diagnosable. */
const provenanceReference = (bundle: ManifestBundle): string =>
  `# Provenance

| | |
|---|---|
| manifest_version | \`${bundle.manifest_version}\` |
| rendered_at | ${bundle.rendered_at} |
| voice object | ${bundle.sources.voice_object_id ?? '(none readable at render time)'} |
| voice record_version | ${bundle.sources.voice_record_version ?? '—'} |
| approval posture | ${bundle.sources.approval_posture} |
| tool-surface digest | \`${bundle.sources.tool_surface_digest}\` |

Aggression ceiling this skill was rendered against:

${Object.entries(bundle.sources.aggression_ceiling)
  .map(([dial, value]) => `- ${dial}: ${value}`)
  .join('\n')}

${bundle.warnings.length ? `## Warnings at render time\n\n${bundle.warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}
Pass \`${bundle.manifest_version}\` as \`producer.prompt_version\` on every
\`object_publish\`. That is how a published article points back at the exact
skill revision that wrote it.
`;

const skillFiles = (bundle: ManifestBundle, prefix: string): ZipEntry[] => {
  const dir = `${prefix}${skillDirName(bundle.connection.tenant)}`;
  return [
    { path: `${dir}/SKILL.md`, content: bundle.skill_md },
    { path: `${dir}/references/connection.md`, content: connectionReference(bundle) },
    { path: `${dir}/references/tools.md`, content: toolsReference(bundle) },
    { path: `${dir}/references/provenance.md`, content: provenanceReference(bundle) },
  ];
};

/** W2.1 — the skill zip, for org skills. */
export const buildSkillZip = (bundle: ManifestBundle): { filename: string; bytes: Buffer } => ({
  filename: `${skillDirName(bundle.connection.tenant)}-skill.zip`,
  bytes: createZip(skillFiles(bundle, '')),
});

/** W2.2 — the Cowork `.plugin` bundle: the same skill plus the connector. */
export const buildCoworkPlugin = (bundle: ManifestBundle): { filename: string; bytes: Buffer } => {
  const tenant = bundle.connection.tenant;
  const name = `${tenant}-publisher`;

  const pluginJson = {
    name,
    version: '0.1.0',
    description: `Write and publish articles to ${bundle.connection.origin} in its own editorial voice.`,
    author: { name: 'Kugel Brands' },
  };

  // Streamable HTTP with OAuth: the endpoint mints and refreshes its own tokens
  // through the connector flow, so no credential is written into the bundle.
  const mcpJson = {
    mcpServers: {
      [`${tenant}-cms`]: { type: 'http', url: bundle.connection.mcp_url },
    },
  };

  const readme = `# ${name}

Writes articles in the ${tenant} editorial voice and publishes them to
${bundle.connection.origin}.

Installing this plugin adds two things: the publishing skill, and a connector
pointing at the tenant CMS (\`${bundle.connection.mcp_url}\`). The connector uses
OAuth — you will be asked to sign in the first time a tool runs. **No credential
is stored in this file.**

Set the publishing tools to *Ask* for the first week. See
\`skills/${skillDirName(tenant)}/references/connection.md\` for the full setup
card and for what to do when authorization fails.

Rendered from manifest \`${bundle.manifest_version}\` on ${bundle.rendered_at}.
Re-export from the tenant admin whenever the voice or the tool surface changes.
`;

  return {
    filename: `${name}.plugin`,
    bytes: createZip([
      { path: '.claude-plugin/plugin.json', content: `${JSON.stringify(pluginJson, null, 2)}\n` },
      { path: '.mcp.json', content: `${JSON.stringify(mcpJson, null, 2)}\n` },
      { path: 'README.md', content: readme },
      ...skillFiles(bundle, 'skills/'),
    ]),
  };
};
