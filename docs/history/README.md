# docs/history — verbatim archives

These files are byte-for-byte copies of documents that were replaced on 2026-09-05 (`README.md`, `AGENTS.md`, `CLAUDE.md` as they stood at commit `6789644`). They are history, not law: paths, counts and rulings in them may be stale, and several sections contradict each other (that is why they were replaced). Read the current `AGENTS.md`, `CLAUDE.md` and `docs/AI_CONTEXT.md` instead.

## Known policy conflict (recorded, not silently resolved)

`AGENTS.md` §3.7 forbids committing the literal value of `GITHUB_REPOSITORY` (this repository's own `owner/name`, bare or inside a URL) because Netlify's secrets scanner fails the build on it. These archives predate that wording and contain:

- the current slug, verbatim, in `CLAUDE-2026-09-05.md` line 3 (it was already there at `6789644`);
- a full URL of the *former* slug in `CLAUDE-2026-09-05.md` line 366 (the gotcha that created the rule);
- links to the upstream template repository in `README-astrowind-template.md`.

"Verbatim archive" and "no slug anywhere" cannot both hold. The resolution recorded here: the archives stay verbatim, `tests/scripts/docs-invariants.test.mjs` excludes `docs/history/**` from the slug check, and the build depends on `SECRETS_SCAN_OMIT_KEYS = "GITHUB_REPOSITORY"` in every `netlify.toml` for these files exactly as it already does for `docs/cms-architecture/FLEET-STATUS.md`. If that dependency is ever removed, redact the slug in these files with a visible `[redacted: repo slug]` marker rather than rewriting them. Owner decision tracked as `docs/KNOWN_ISSUES.md` #64.
