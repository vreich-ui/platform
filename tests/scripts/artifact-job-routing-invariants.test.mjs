// S1 — repo-wide invariants for the artifact-job bridge's edit forwarding and
// its image-model routing default. These are cross-file facts no single pure
// module can assert about itself.
//
// Why they are pinned at all: both defects this wave fixed were invisible
// locally. The edit fields type-checked and shipped for months while every
// edit job failed at pdf-tool, and the routing default was a field the bridge
// simply never sent, so nothing in the repo mentioned OpenAI anywhere — the
// only evidence was the bill.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const HANDLERS = 'packages/core/server/lib/mcp-tool-handlers.ts';
const CLIENT = 'packages/core/server/lib/pdf-tool-client.ts';
const DEFINITIONS = 'packages/core/server/lib/mcp-tool-definitions.ts';
const DESCRIPTOR = 'packages/core/lib/pdf/artifact-job-descriptor.ts';
const BRAND_RESOLVE = 'packages/core/server/lib/brand-imagery-resolve.ts';

const EDIT_FIELDS = ['sourceArtifact', 'editMode', 'maskRef', 'editInstructions'];

test("pdf-tool-client forwards every one of pdf-tool's top-level edit fields", () => {
  const source = read(CLIENT);
  const payload = source.slice(source.indexOf('export const createPlatformArtifactJob'));
  const body = payload.slice(0, payload.indexOf('export const getPlatformArtifactJobStatus'));
  for (const field of EDIT_FIELDS) {
    assert.ok(
      new RegExp(`${field}:\\s*input\\.${field}`).test(body),
      `createPlatformArtifactJob must forward ${field} to pdf-tool — dropping it fails every edit job with "edit jobs require ${field}"`
    );
  }
  assert.ok(/descriptor:\s*input\.descriptor/.test(body), 'createPlatformArtifactJob must forward descriptor');
});

test('PlatformArtifactJobInput declares the edit fields and the descriptor', () => {
  const source = read(CLIENT);
  const type = source.slice(
    source.indexOf('export type PlatformArtifactJobInput'),
    source.indexOf('const projectPayload =')
  );
  for (const field of [...EDIT_FIELDS, 'descriptor']) {
    assert.ok(new RegExp(`\\b${field}\\?:`).test(type), `PlatformArtifactJobInput must declare ${field}`);
  }
});

test("create_agent_artifact_job's published input schema documents the edit fields top-level", () => {
  const source = read(DEFINITIONS);
  const start = source.indexOf("name: 'create_agent_artifact_job'");
  const end = source.indexOf("name: 'get_agent_artifact_job_status'", start);
  assert.ok(start > -1 && end > start, 'create_agent_artifact_job definition not found');
  const definition = source.slice(start, end);
  for (const field of EDIT_FIELDS) {
    assert.ok(
      new RegExp(`\\n\\s{8}${field}:`).test(definition),
      `${field} must be a TOP-LEVEL property of create_agent_artifact_job's inputSchema — a caller who cannot see it in the schema puts it under requirements, where pdf-tool never reads it`
    );
  }
});

test('the bridge builds a descriptor for image jobs and warns on a missing usageContext', () => {
  const handlers = read(HANDLERS);
  assert.ok(handlers.includes('buildArtifactJobDescriptor'), 'the bridge must build a project descriptor');
  assert.ok(handlers.includes('resolveRoutingWarnings'), 'the bridge must surface the routing warnings');
  assert.ok(
    /\.\.\.\(jobDescriptor \? \{ descriptor: jobDescriptor \} : \{\}\),/.test(handlers),
    'the descriptor must reach the pdf-tool job input'
  );
  assert.ok(/\.\.\.editFields,/.test(handlers), 'the mapped edit fields must reach the pdf-tool job input');
});

test('the routing default is read from the site policy, never hardcoded', () => {
  // Wolf's ruling: FAL is the default AND the model id comes from
  // get_image_model_policy at call time. A literal model id on this path is
  // the failure mode the ruling forbids.
  for (const file of [DESCRIPTOR, HANDLERS, CLIENT]) {
    const code = read(file)
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    assert.equal(/['"`]fal-ai\//.test(code), false, `${file} must not hardcode a FAL model id`);
    assert.equal(/['"`]gpt-image/.test(code), false, `${file} must not hardcode an OpenAI model id`);
  }
});

test('the descriptor fallback context agrees with the coercion default', () => {
  // A contextless job and a wrong-context job must route to the same model;
  // these are the two sources that decide it.
  const descriptor = /DESCRIPTOR_FALLBACK_USAGE_CONTEXT = '([^']+)'/.exec(read(DESCRIPTOR));
  const coercion = /DEFAULT_USAGE_CONTEXT = '([^']+)'/.exec(read(BRAND_RESOLVE));
  assert.ok(descriptor && coercion, 'both defaults must be declared as string literals');
  assert.equal(descriptor[1], coercion[1]);
});
