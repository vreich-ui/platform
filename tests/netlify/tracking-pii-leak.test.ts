import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

const repoRoot = (() => {
  const cwd = process.cwd();
  return basename(cwd) === 'ci-test' && basename(dirname(cwd)) === '.tmp' ? join(cwd, '..', '..') : cwd;
})();

const collectFiles = async (dir: string, predicate: (name: string) => boolean): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
};

test('tracking-event fixtures and client loader bundle do not carry member identity fields', async () => {
  const fixtureFiles = await collectFiles(join(repoRoot, 'tests/fixtures/tracking-events'), (name) =>
    name.endsWith('.json')
  );
  const loaderSourceFiles = await collectFiles(join(repoRoot, 'packages/core/lib/tracking/loader'), (name) =>
    name.endsWith('.ts')
  );
  const builtLoaderFiles = await collectFiles(join(repoRoot, 'dist/_astro'), (name) =>
    /^TrackingLoaderMount\..+\.js$/.test(name)
  );

  const targets = [...fixtureFiles, ...loaderSourceFiles, ...builtLoaderFiles];
  assert.ok(fixtureFiles.length > 0, 'tracking-event fixtures are covered by the leak grep');
  assert.ok(loaderSourceFiles.length > 0, 'client loader sources are covered by the leak grep');

  const leaks: string[] = [];
  for (const file of targets) {
    const text = await readFile(file, 'utf8');
    if (/\bmember_hash\b/i.test(text) || /\bemail\b/i.test(text)) leaks.push(file);
  }

  assert.deepEqual(leaks, []);
});
