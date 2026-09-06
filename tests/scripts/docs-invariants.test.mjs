import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const abs = (relPath) => path.join(ROOT, relPath);

// The new (2026-09-05/06) reverse-engineered doc set. docs/history/** is
// deliberately excluded — those are verbatim dated archives, not live docs.
const DOC_PATHS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/AI_CONTEXT.md',
  'docs/ARCHITECTURE.md',
  'docs/OVERVIEW.md',
  'docs/CONTENT_ARCHITECTURE.md',
  'docs/CMS_INTEGRATION.md',
  'docs/TRACKING_ARCHITECTURE.md',
  'docs/DEPLOYMENT.md',
  'docs/DATA_CONTRACTS.md',
  'docs/GLOSSARY.md',
  'docs/KNOWN_ISSUES.md',
  'docs/diagrams/README.md',
  'docs/generated/INVENTORY.md',
];

function loadDocs() {
  return DOC_PATHS.map((relPath) => ({
    relPath,
    absPath: abs(relPath),
    text: existsSync(abs(relPath)) ? readFileSync(abs(relPath), 'utf8') : null,
  }));
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// ─── (a) relative markdown links resolve ───

test('(a) every relative Markdown link resolves to an existing file', () => {
  const docs = loadDocs();
  const failures = [];
  // Matches [text](path) and ![alt](path), optionally followed by a "title".
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const doc of docs) {
    if (doc.text === null) {
      failures.push(`${doc.relPath}: file listed in DOC_PATHS does not exist`);
      continue;
    }
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(doc.text))) {
      const rawTarget = m[1];
      if (/^(https?:)?\/\//.test(rawTarget)) continue; // http(s) (and protocol-relative)
      if (rawTarget.startsWith('mailto:')) continue;
      if (rawTarget.startsWith('#')) continue; // same-page anchor
      const withoutFragment = rawTarget.split('#')[0];
      if (withoutFragment === '') continue; // pure "#anchor" already skipped above; guard anyway
      const resolved = path.resolve(path.dirname(doc.absPath), decodeURIComponent(withoutFragment));
      if (!existsSync(resolved)) {
        const line = lineNumberAt(doc.text, m.index);
        failures.push(
          `${doc.relPath}:${line}: link target does not exist: \`${rawTarget}\` (resolved: ${path.relative(ROOT, resolved)})`
        );
      }
    }
  }

  assert.equal(failures.length, 0, `${failures.length} broken relative link(s):\n${failures.join('\n')}`);
});

// ─── (b) no /root/work or /root/platform leaked into docs ───

test('(b) docs do not contain /root/work or /root/platform', () => {
  const docs = loadDocs();
  const failures = [];
  for (const doc of docs) {
    if (doc.text === null) continue;
    for (const needle of ['/root/work', '/root/platform']) {
      let idx = doc.text.indexOf(needle);
      while (idx !== -1) {
        const line = lineNumberAt(doc.text, idx);
        failures.push(`${doc.relPath}:${line}: contains literal \`${needle}\``);
        idx = doc.text.indexOf(needle, idx + needle.length);
      }
    }
  }
  assert.equal(failures.length, 0, `${failures.length} occurrence(s):\n${failures.join('\n')}`);
});

// ─── (c) no repo-slug leakage ───

function getRepoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    // fall through
  }
  return null;
}

test('(c) docs do not leak the repo slug', (t) => {
  const slug = getRepoSlug();
  if (!slug) {
    t.skip(
      'could not determine repo slug: GITHUB_REPOSITORY is unset and `git remote get-url origin` could not be parsed'
    );
    return;
  }
  const docs = loadDocs();
  const failures = [];
  const needles = [slug, `https://github.com/${slug}`];
  for (const doc of docs) {
    if (doc.text === null) continue;
    for (const needle of needles) {
      let idx = doc.text.indexOf(needle);
      while (idx !== -1) {
        const line = lineNumberAt(doc.text, idx);
        failures.push(`${doc.relPath}:${line}: contains literal \`${needle}\``);
        idx = doc.text.indexOf(needle, idx + needle.length);
      }
    }
  }
  assert.equal(failures.length, 0, `repo slug "${slug}" leaked ${failures.length} time(s):\n${failures.join('\n')}`);
});

// ─── (d) doc-embedded mermaid blocks vs docs/diagrams/*.mmd ───

function normalizeForMatching(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

test('(d) mermaid blocks that have a docs/diagrams/*.mmd copy match it byte-for-byte', () => {
  const diagramsDir = abs('docs/diagrams');
  const mmdFiles = existsSync(diagramsDir) ? readdirSync(diagramsDir).filter((f) => f.endsWith('.mmd')) : [];
  const mmdContents = new Map(mmdFiles.map((f) => [f, readFileSync(path.join(diagramsDir, f), 'utf8')]));

  const docs = loadDocs();
  const blockRe = /```mermaid\n([\s\S]*?)\n```/g;
  const mismatches = [];
  const unmatchedInfo = [];
  let checkedPairs = 0;

  for (const doc of docs) {
    if (doc.text === null) continue;
    let m;
    blockRe.lastIndex = 0;
    let blockIndex = 0;
    while ((m = blockRe.exec(doc.text))) {
      blockIndex++;
      const rawBlock = m[1] + '\n'; // matches how a .mmd file is normally saved (trailing newline)
      const line = lineNumberAt(doc.text, m.index);

      // Exact byte match already found — this pair is fine, nothing to report.
      const exactFile = [...mmdContents.entries()].find(([, content]) => content === rawBlock);
      if (exactFile) {
        checkedPairs++;
        continue;
      }

      // No exact match: look for a normalized match (the "this IS meant to be
      // a copy of that file, but they've drifted" case) — build the mapping
      // by comparing normalized content, then assert real equality on it.
      const normBlock = normalizeForMatching(rawBlock);
      const normMatchFile = [...mmdContents.entries()].find(
        ([, content]) => normalizeForMatching(content) === normBlock
      );
      if (normMatchFile) {
        mismatches.push(
          `${doc.relPath}:${line} (mermaid block #${blockIndex}) normalizes to match docs/diagrams/${normMatchFile[0]} but is not byte-identical to it`
        );
      } else {
        unmatchedInfo.push(`${doc.relPath}:${line} (mermaid block #${blockIndex}) has no docs/diagrams/*.mmd copy`);
      }
    }
  }

  if (unmatchedInfo.length > 0) {
    // Informational only — not a failure. A doc is free to carry a
    // bespoke/simplified diagram with no dedicated .mmd twin.
    console.log(`[info] mermaid blocks with no .mmd copy (${unmatchedInfo.length}):\n${unmatchedInfo.join('\n')}`);
  }
  console.log(`[info] mermaid blocks byte-identical to a docs/diagrams/*.mmd file: ${checkedPairs}`);

  assert.equal(
    mismatches.length,
    0,
    `${mismatches.length} mermaid block(s) drifted from their docs/diagrams/*.mmd twin:\n${mismatches.join('\n')}`
  );
});

// ─── (e) KNOWN_ISSUES.md has no duplicate "## N." numbers ───

test('(e) docs/KNOWN_ISSUES.md has no duplicate numbered "## N." headings', () => {
  const text = readFileSync(abs('docs/KNOWN_ISSUES.md'), 'utf8');
  const re = /^## (\d+)\./gm;
  const seen = new Map(); // number -> first line
  const dupes = [];
  let m;
  while ((m = re.exec(text))) {
    const n = m[1];
    const line = lineNumberAt(text, m.index);
    if (seen.has(n)) {
      dupes.push(`## ${n}. appears at line ${line} (first seen at line ${seen.get(n)})`);
    } else {
      seen.set(n, line);
    }
  }
  assert.equal(dupes.length, 0, `duplicate "## N." numbers in docs/KNOWN_ISSUES.md:\n${dupes.join('\n')}`);
});
