/**
 * The legacy article surface is RETIRED (2026-07-29, ruling OQ-W11-6) and must
 * not come back on any site.
 *
 * This file began as W14 T14.4's guard, when the legacy tools still existed and
 * only had to be hidden from sites that lacked the legacy handlers: the T14.3
 * decoupling injected the handlers per site but left the tool DECLARATIONS
 * static, so `sites/platform` advertised all twelve and would have thrown on
 * any of them. The retirement deleted the tools outright, so the guard is now
 * absolute — no site advertises them, and the names must not reappear in the
 * server source at all.
 *
 * What DID survive the retirement is the injection SEAM, because
 * `verify_article_images` still uses it: it is a per-site function serving the
 * OBJECT path (post-release image verification). So the shrink-when-absent
 * behavior is still pinned below, just with the one tool that still needs it.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // registers providers — the core import chain resolves site identity at module load

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { configureMcp, visibleToolDefinitions, INTERNAL_ONLY_TOOLS } from '../../packages/core/server/functions/mcp.js';

/** Walk up to the repo root — this file runs from the COMPILED tree. */
const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'packages', 'core', 'server', 'functions', 'mcp.ts'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
  return dir;
};

const SOURCE = join(repoRoot(), 'packages', 'core', 'server', 'functions', 'mcp.ts');

const noop = async () => ({ statusCode: 200, body: '{}' });

const governedOnly = {
  saveArtifactHandler: noop,
  objectStoreHandler: noop,
  deployStatusHandler: noop,
};

const withVerifyArticleImages = {
  ...governedOnly,
  verifyArticleImagesHandler: noop,
};

/** The retired write pipeline: 11 save_json_blob_* tools + the 10 per-stage helpers. */
const RETIRED_TOOL_PATTERN =
  /^(save_json_blob_|(reader_insight|research|angle|draft|final_article)_(update_output|mark_complete)$)/;

test('no site advertises a retired legacy article tool', () => {
  for (const handlers of [governedOnly, withVerifyArticleImages]) {
    configureMcp(handlers);
    const names = visibleToolDefinitions().map((tool) => tool.name);
    const leaked = names.filter((name) => RETIRED_TOOL_PATTERN.test(name));
    assert.deepEqual(leaked, [], `retired legacy tools advertised: ${leaked.join(', ')}`);
    assert.ok(names.length > 30, 'the governed surface is still there');
  }
});

test('the retired tool names are gone from the server source entirely', () => {
  const source = readFileSync(SOURCE, 'utf8');
  // A prose mention in the retirement note is fine; a quoted tool name — the
  // shape a declaration or dispatch case takes — is not.
  const quotedNames = [...source.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
  const revived = [...new Set(quotedNames.filter((name) => RETIRED_TOOL_PATTERN.test(name)))].sort();
  assert.deepEqual(revived, [], `retired legacy tool names reappeared in mcp.ts: ${revived.join(', ')}`);
});

test('verify_article_images is omitted on a site that does not inject its handler', () => {
  configureMcp(withVerifyArticleImages);
  assert.ok(visibleToolDefinitions().some((tool) => tool.name === 'verify_article_images'));

  configureMcp(governedOnly);
  assert.ok(!visibleToolDefinitions().some((tool) => tool.name === 'verify_article_images'));
});

test('INTERNAL_ONLY_TOOLS (T16.5: capability_status joins this set) are callable but never advertised', () => {
  for (const handlers of [governedOnly, withVerifyArticleImages]) {
    configureMcp(handlers);
    const names = new Set(visibleToolDefinitions().map((tool) => tool.name));
    for (const internalToolName of INTERNAL_ONLY_TOOLS) {
      assert.ok(!names.has(internalToolName), `${internalToolName} must not appear in tools/list`);
    }
  }
});

test('omitting the optional handler hides only the tools that need it', () => {
  configureMcp(withVerifyArticleImages);
  const withNames = new Set(visibleToolDefinitions().map((tool) => tool.name));
  configureMcp(governedOnly);
  const withoutNames = new Set(visibleToolDefinitions().map((tool) => tool.name));
  const omitted = [...withNames].filter((name) => !withoutNames.has(name)).sort();

  assert.deepEqual(omitted, ['verify_article_images']);
});
