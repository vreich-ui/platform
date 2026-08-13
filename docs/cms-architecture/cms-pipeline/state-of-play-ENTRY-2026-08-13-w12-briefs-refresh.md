# state-of-play ENTRY — 2026-08-13 — fold below the file header (newest-first)

> Sidecar entry per the standing convention (see HANDOFF-2026-08-10 §4).
> Fold into `state-of-play.md` directly below the header, above the current
> newest entry, then delete this file.

## 2026-08-13 — W12 capture briefs refreshed against post-W14/W16 reality (docs-only)

Per the 2026-08-10 handoff §8 (stale backlog triage), the six site-capture
briefs `T12.1`–`T12.6` were verified against `main` and brought current before
anyone executes them. Triage verdict: **W12 is a real gap** — no
`packages/core/cli/capture/` exists, so the rows stay queued in `queue.tsv`
(none commented out). What was stale was the briefs themselves, all written
pre-relocation:

- **Paths (W11/W14 relocation):** `src/schema/bodies/section-v1.ts`,
  `src/lib/registry/{components,theme-tokens.ts}`, `src/schema/bodies/theme-v1.ts`,
  `netlify/lib/object-verbs.ts`, `netlify/functions/mcp.ts` -> their
  `packages/core/...` counterparts (the per-site `netlify/functions/mcp.ts` is
  a shim, noted as such in T12.4).
- **Landing zone (OQ-W12-3):** the conditional "T11.11 staging client when
  W11 is in place, else ..." language replaced — the fleet is live
  (drlurie/platform/fernwell, per-site `/mcp` over one core), and the genesis
  line (`create-site.mjs` + provisioning runbook) can mint a fresh staging
  tenant. T12.4/T12.6 headers + scope updated accordingly.
- **T12.3 hardening since writing:** `site_apply_theme` totality rule (a
  non-total theme is REJECTED — extractor must fill unseen roles from
  `FALLBACK_COLORS`, flagged low-confidence); font keys now
  sans/serif/heading + optional mono; new non-goal fencing off
  `site.brandImagery` (W16 C1 — privileged writer only; imagery style goes to
  the gap report).
- **T12.4 discipline since writing:** recipe metadata trio + REUSE-FIRST +
  `creation_policy` on `section_template` minting; `idempotency_key` on every
  create with same-key retry (QA-W16-1); media bullet names the real tools
  (`create_artifact_from_url` / upload-intent; W16 `import_images_from_url`
  noted as content_item-request-scoped only) + portability hard constraints.
- **T12.6:** publish-vs-release two-gate reality spelled out in the
  disposition step.

Substance (rulings OQ-W12-1/-2/-3, scope, non-goals, acceptance) unchanged —
this was a reference refresh, not a re-plan. No code, no store writes.
