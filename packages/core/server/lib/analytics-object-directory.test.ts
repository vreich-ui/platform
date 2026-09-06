import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveAnalyticsObjectDirectory, __resetAnalyticsObjectDirectoryMemo } from './analytics-object-directory.js';

const withFixtureRoot = async (fn: (dataRoot: string) => Promise<void>) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'analytics-object-dir-'));
  __resetAnalyticsObjectDirectoryMemo();
  try {
    await fn(dataRoot);
  } finally {
    __resetAnalyticsObjectDirectoryMemo();
    await rm(dataRoot, { recursive: true, force: true });
  }
};

const writeExport = async (dataRoot: string, subdir: string, fileName: string, body: Record<string, unknown>) => {
  const dir = path.join(dataRoot, subdir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), JSON.stringify(body), 'utf8');
};

test('resolveAnalyticsObjectDirectory: resolves a page by its `route` field', async () => {
  await withFixtureRoot(async (dataRoot) => {
    await writeExport(dataRoot, 'pages', 'page_about.json', {
      __generated: { from: 'objects/page/by-id/page_about.json', at: '2026-01-01T00:00:00Z', record_version: 1 },
      title: 'About Dr. Leonid Lurie',
      route: '/about',
    });
    const directory = await resolveAnalyticsObjectDirectory(dataRoot, ['page_about']);
    assert.deepEqual(directory, { page_about: { title: 'About Dr. Leonid Lurie', route: '/about', objectType: 'page' } });
  });
});

test('resolveAnalyticsObjectDirectory: resolves an article by `/${slug}`, ignoring `route` entirely', async () => {
  await withFixtureRoot(async (dataRoot) => {
    await writeExport(dataRoot, 'articles', 'req_agent_x.json', {
      __generated: { from: 'objects/content_item/by-id/req_agent_x.json', at: '2026-01-01T00:00:00Z', record_version: 1 },
      title: 'The three-step routine',
      slug: 'the-three-step-routine',
      route: '/should-be-ignored',
    });
    const directory = await resolveAnalyticsObjectDirectory(dataRoot, ['req_agent_x']);
    assert.deepEqual(directory, {
      req_agent_x: { title: 'The three-step routine', route: '/the-three-step-routine', objectType: 'content_item' },
    });
  });
});

test('resolveAnalyticsObjectDirectory: an id not present in the export tree resolves to null, not omitted (D6: visible, never hidden)', async () => {
  await withFixtureRoot(async (dataRoot) => {
    const directory = await resolveAnalyticsObjectDirectory(dataRoot, ['ghost_object']);
    assert.deepEqual(directory, { ghost_object: null });
  });
});

test('resolveAnalyticsObjectDirectory: an id never asked for is absent from the result', async () => {
  await withFixtureRoot(async (dataRoot) => {
    await writeExport(dataRoot, 'pages', 'page_home.json', {
      __generated: { from: 'objects/page/by-id/page_home.json', at: '2026-01-01T00:00:00Z', record_version: 1 },
      title: 'Home',
      route: '/',
    });
    const directory = await resolveAnalyticsObjectDirectory(dataRoot, ['page_home']);
    assert.equal('page_about' in directory, false);
  });
});

test('resolveAnalyticsObjectDirectory: a missing export tree (ENOENT) degrades to every id unresolved, never throws', async () => {
  await withFixtureRoot(async (dataRoot) => {
    const directory = await resolveAnalyticsObjectDirectory(path.join(dataRoot, 'does-not-exist'), ['anything']);
    assert.deepEqual(directory, { anything: null });
  });
});

test('resolveAnalyticsObjectDirectory: an unparsable export file is skipped, not fatal to the rest of the directory', async () => {
  await withFixtureRoot(async (dataRoot) => {
    const dir = path.join(dataRoot, 'pages');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'page_broken.json'), '{ not json', 'utf8');
    await writeExport(dataRoot, 'pages', 'page_ok.json', {
      __generated: { from: 'objects/page/by-id/page_ok.json', at: '2026-01-01T00:00:00Z', record_version: 1 },
      title: 'OK',
      route: '/ok',
    });
    const directory = await resolveAnalyticsObjectDirectory(dataRoot, ['page_ok']);
    assert.deepEqual(directory, { page_ok: { title: 'OK', route: '/ok', objectType: 'page' } });
  });
});

test('resolveAnalyticsObjectDirectory: no ids requested short-circuits to an empty directory without touching the filesystem', async () => {
  await withFixtureRoot(async (dataRoot) => {
    const directory = await resolveAnalyticsObjectDirectory(path.join(dataRoot, 'never-created'), []);
    assert.deepEqual(directory, {});
  });
});

test('resolveAnalyticsObjectDirectory: a title-less export falls back to the object id as its own title', async () => {
  await withFixtureRoot(async (dataRoot) => {
    await writeExport(dataRoot, 'pages', 'page_notitle.json', {
      __generated: { from: 'objects/page/by-id/page_notitle.json', at: '2026-01-01T00:00:00Z', record_version: 1 },
      route: '/notitle',
    });
    const directory = await resolveAnalyticsObjectDirectory(dataRoot, ['page_notitle']);
    assert.deepEqual(directory, { page_notitle: { title: 'page_notitle', route: '/notitle', objectType: 'page' } });
  });
});
