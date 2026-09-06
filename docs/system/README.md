# Kugel system documentation (cross-repository)

This directory is the **system-level** documentation for the four Kugel repositories. It is owned by the `platform` repository (decision recorded in [SYSTEM-ARCHITECTURE.md §0](SYSTEM-ARCHITECTURE.md#0-where-this-documentation-lives-and-why)); the other three repositories carry a one-page pointer to it.

Every document here is pinned to the same four commits and must be re-validated when any of them moves ([SYSTEM-OPERATIONS.md §6](SYSTEM-OPERATIONS.md#6-revalidation-when-a-pin-moves)):

| Repository | Pin | Date |
|---|---|---|
| `vreich-ui/CMS-Agent` `main` | `CMS_AGENT_SHA=44acb04a1f54281761ab3c34219913198d117950` | 2026-09-06 |
| `platform` repository `main` | `PLATFORM_SHA=d5845dd6e855b434547430d6b0bb4d60b9f60a3c` | 2026-09-06 |
| `vreich-ui/pdf-tool` `main` | `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` | 2026-09-06 |
| `vreich-ui/kugel-data` `main` | `KUGEL_DATA_SHA=d9723664521c97be87934874927e9e4603da68ba` | 2026-09-06 (runtime identical to `6c9c712`, 2026-09-04) |

The four `main`s moved twice while this set was being written, and it was re-pinned both times. First move — CMS-Agent `4b618b7`→`0d1dfa4` (PR #267, docs + `scripts/repro/knownIssues.ts`), platform `420afbd`→`99fb369` (PR #694, W21 tracking), pdf-tool `60bdb98`→`2c28a4b` (PR #78, descriptions/annotations). Second move — CMS-Agent `0d1dfa4`→`44acb04` (PR #268, reconciler env contexts), platform `99fb369`→`d5845dd` (PR #695 docs corrections, PR #697 Dr. Lurie tool-surface parity, PR #696 = the first eight documents of this set, four content publishes), kugel-data `6c9c712`→`d972366` (PRs #9, #10, #11 — documentation only; every function, shared module and migration is byte-identical to `6c9c712`). Every claim the drift gate or the diffs touched was re-verified — the per-move list is in [SYSTEM-OPERATIONS.md §6.1](SYSTEM-OPERATIONS.md#61-what-moved-during-the-audit-and-what-was-revalidated). Still **not** part of the pinned system: the kugel-data branch `runner/w21-r116` (migrations 006–008, `/export`, the `from`/`to` `/stats`) that platform `main` codes against — it is not on GitHub.

Evidence labels used throughout: **VERIFIED-BOTH-SIDES** (producer and consumer code read), **VERIFIED-PRODUCER-ONLY**, **VERIFIED-CONSUMER-ONLY**, **CONTRADICTED** (the two sides disagree), **UNKNOWN** (not decidable from the four repositories). A repository's README is never evidence of another repository's behaviour.

## Reading order

| Question | Document |
|---|---|
| I am an agent about to change something — where do I start? | [AI-SYSTEM-CONTEXT.md](AI-SYSTEM-CONTEXT.md) |
| What are the systems and how do they fit? | [SYSTEM-ARCHITECTURE.md](SYSTEM-ARCHITECTURE.md) |
| Who owns which data? | [SYSTEM-AUTHORITY-MATRIX.md](SYSTEM-AUTHORITY-MATRIX.md) |
| Every cross-repository contract | [SYSTEM-CONTRACTS.md](SYSTEM-CONTRACTS.md) |
| One article, end to end, with every hop | [SYSTEM-DATA-FLOW.md](SYSTEM-DATA-FLOW.md) |
| Identifiers and what joins to what | [SYSTEM-IDENTIFIERS.md](SYSTEM-IDENTIFIERS.md) |
| What "publish" actually means | [SYSTEM-PUBLISHING.md](SYSTEM-PUBLISHING.md) |
| The seven things called "ArtifactReference" | [SYSTEM-ARTIFACTS.md](SYSTEM-ARTIFACTS.md) |
| Tracking, revenue, attribution, learning loop | [SYSTEM-TRACKING-AND-ATTRIBUTION.md](SYSTEM-TRACKING-AND-ATTRIBUTION.md) |
| Where agents reason and where tools execute | [SYSTEM-AGENT-ARCHITECTURE.md](SYSTEM-AGENT-ARCHITECTURE.md) |
| Credentials, trust boundaries | [SYSTEM-SECURITY-BOUNDARIES.md](SYSTEM-SECURITY-BOUNDARIES.md) |
| Deploy, env, jobs, revalidation | [SYSTEM-OPERATIONS.md](SYSTEM-OPERATIONS.md) |
| Confirmed cross-repository defects | [SYSTEM-KNOWN-ISSUES.md](SYSTEM-KNOWN-ISSUES.md) |
| Where the four audits disagreed and how code settled it | [SYSTEM-CONFLICT-LEDGER.md](SYSTEM-CONFLICT-LEDGER.md) |
| What must be preserved now for future learning/promotion | [SYSTEM-FUTURE-EXTENSIONS.md](SYSTEM-FUTURE-EXTENSIONS.md) |

Diagram sources are the Mermaid blocks inside the documents (GitHub renders them inline); `diagrams/` holds one `.mmd` file per block for local rendering.

Drift gate: `node scripts/docs/system-contracts.mjs --check` (in CI via `tests/scripts/system-docs.test.mjs`) compares the literals these documents rely on against the code; see [SYSTEM-OPERATIONS.md §7](SYSTEM-OPERATIONS.md#7-drift-prevention).
