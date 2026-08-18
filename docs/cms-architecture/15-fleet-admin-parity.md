# 15 — Fleet admin parity: what a tenant needs before `/admin` works, proven

> **Status (2026-08-04, W15 S2): SHIPPED as checked machinery.** Wolf's W15
> mandate (2026-08-03): _every tenant — current clients and all future ones —
> gets the full admin workspace and canvas editor, not just Dr. Lurie._ The
> admin surface itself was already fleet law (shell-routes injects `/admin/*`
> into every build; `create-site` emits every function shim), but the LAST
> MILE that makes admin usable was tribal knowledge. This doc is the complete
> requirement inventory, derived from code, with each requirement's
> provisioner named. The machine half is
> `packages/core/cli/admin-parity.mjs`; run it any time with
> `node scripts/audit-site-admin-parity.mjs --all` (read-only) and repair an
> older site with
> `node packages/core/cli/migrate-site.mjs --site sites/<slug> --admin-parity --write`
> (additive, idempotent). Keep this doc and that module in sync — the module
> is the enforced truth.

## How to read the checklist

**Provisioner vocabulary** (the audit prints the same labels):

- **core** — fleet law in `packages/core`; every tenant inherits it from the
  shared build with no per-site action. Drift here is a core bug, not a
  provisioning gap.
- **scaffold** — emitted by `packages/core/cli/create-site.mjs` at genesis.
  A site scaffolded today has it by construction (pinned by
  `tests/scripts/admin-parity.test.mjs`'s genesis test); an older site gets
  it retrofitted by `migrate-site --admin-parity --write`.
- **migrate-site** — the retrofit path for sites scaffolded before a wave
  landed. Additive and idempotent: adds what is missing, replaces only the
  one known-bad legacy form (the pre-S1 admin splat), never overwrites an
  existing file.
- **provisioning (auto)** — done by `create-site --netlify-token …` against
  the real Netlify account (site creation, blob-store probes, auto-minted
  secrets). Automatable, but needs account authority.
- **Netlify console (human)** — a click no CLI can perform on the operator's
  behalf. These are the true human gates; the runbook
  (`site-provisioning-runbook.md` §admin) has the exact steps.
- **env (human)** — a value only a human/secret-custodian can supply.

**Audit statuses:** `PASS`/`GAP` for everything repo-checkable; `HUMAN` for
requirements the repo cannot prove (console state, env values, live stores).
A tenant is admin-complete when the audit shows zero `GAP` and a human has
signed off the `HUMAN` rows.

## The checklist

### A. Routes and build wiring (who: core + scaffold)

1. **Shell routes injected** — `packages/core/app/shell-routes.ts` injects
   the full `/admin` surface into every site build: `/admin`,
   `/admin/agents`, `/admin/authorize` (the W14 F10 OAuth consent screen),
   `/admin/content`, `/admin/content/[objectId]`, `/admin/kit`,
   `/admin/maintenance`, `/admin/profile`, `/admin/settings/admins`,
   `/admin/settings/guardrails`, `/admin/studio`. Who: **core**. Audit:
   `shell-routes`.
2. **Thin build entry over the shell** — `sites/<slug>/astro.config.ts`
   calls `defineSiteAstroConfig` (`packages/core/app/site-astro-config.ts`),
   which is what actually wires `shellRoutes()`, the layouts (including the
   `EditMode` canvas include in `Layout.astro` — the edit-mode overlay on
   every public page), `admin-tokens.css` (imported by `AdminLayout.astro`),
   and the `_redirects` retirement integration. Who: **scaffold** (root
   drlurie: the repo-root `astro.config.ts` re-exports
   `sites/drlurie/astro.config`). Audit: `build-entry`.
3. **Reader route loaders for `content_item`** (W14 F11) — the four
   `app/pages/[...blog]/…` loaders. Without them published articles are
   unreachable, and so are their per-node canvas chips — the editor mandate
   includes editing articles ON the site. Who: **scaffold | migrate-site**
   (this wave's run repaired `sites/fernwell`, which predated F11). Audit:
   `reader-blog-loaders`.

### B. Functions (who: scaffold + migrate-site)

4. **One shim per core server function** — Netlify resolves
   `functions.directory` relative to the project's base directory, so each
   site carries `netlify/functions/<fn>.ts` for every factory
   `packages/core/server/functions/` exports (34 at this writing — the
   admin-critical ones include `admin-auth-state`, `admin-object`,
   `admin-users`, `admin-agent-chat` + its background runner,
   `admin-governance`, `admin-release`, `admin-taxonomy`, `admin-audit`,
   `admin-blob-manager`, `admin-ask-ai-object`, `admin-artifact-upload-intent`,
   `mcp`, `mcp-oauth`, `mcp-keepalive`, `object-store`, `deploy-status`).
   The list is discovered from the core directory at scaffold/repair time,
   never hand-maintained. Site-local extras (drlurie's
   `verify-article-images`) are legitimate. Who: **scaffold |
   migrate-site**. Audit: `function-shims`.
5. **Shims correctly wired** — each shim imports its core factory AND the
   site's `policy-bindings.js` side-effect (without which the shell cannot
   resolve site identity), and uses the export form its function generation
   requires: Functions-2.0 (`export const config` in core) → default
   export; v1 → named `handler` (the W14 F2 502-at-init lesson). The `mcp`
   shim is the composite wire (`configureMcp` + the governed trio). Who:
   **scaffold** (repair regenerates missing shims from the same templates;
   existing shims are never rewritten). Audit: `shim-wiring`.
6. **Functions config + keepalive** — `netlify.toml` declares
   `[functions] directory = "netlify/functions"` (esbuild) and the
   `[functions."mcp-keepalive"] schedule` block — a scheduled function only
   runs if its schedule is DECLARED in the deployed toml; shipping the
   function without the block is what leaves `/mcp` cold. Who: **scaffold |
   migrate-site**. Audit: `netlify-functions-config`.

### C. Routing: rewrites and the OAuth AS (who: scaffold + migrate-site)

7. **The canonical infra redirect table** — 14 rules every tenant's
   `netlify.toml` must carry: `/pdf/*` and `/img/*` (blob-served media, the
   images the canvas/artifact pipeline serves), `/mcp`, the nine W14 F10
   OAuth authorization-server rules (`/.well-known/oauth-protected-resource`
   ±splat, `/.well-known/oauth-authorization-server` ±splat,
   `/oauth/register|authorize|consent|token|revoke`), `/api/t` (tracking
   ingest), and the admin rewrite (next row). The table is
   `CANONICAL_INFRA_REDIRECTS` in `admin-parity.mjs`; content redirects
   (`/blog` → `/learn/library` …) are per-site editorial choices and NOT
   part of it. Who: **scaffold | migrate-site**. Audit: `infra-redirects`.
8. **The S1 admin-content rewrite, exactly** —
   `/admin/content/:objectId → /admin/content/__workspace`, status 200,
   **unforced**, ONE path segment. The pre-S1 splat+force form matched
   `/admin/content/` itself and swallowed the static library index (the
   "Back to library" dead-end). Any `/admin/content/*` rule is stale and is
   the one thing `--admin-parity --write` REPLACES in place. Who:
   **scaffold | migrate-site** (S1 fixed root + all three sites + the
   templates; parity keeps it fixed). Audit: `admin-rewrite-s1`.
9. **`site.config.ts` mirrors `netlify.toml`** — the committed redirect
   table (Wolf B2: routing authority stays a FILE) must equal the toml's
   rules in order (from/to/status; `force` is toml-only), the same
   drift-guard invariant `tests/netlify/site-config-drift.test.ts` pins for
   drlurie — the audit extends it to every tenant. Who: **scaffold |
   migrate-site**. Audit: `site-config-mirror`.

### D. Identity, roles, and config (who: scaffold + console + env)

10. **The per-site config bundle** — `config/site-identity.ts`,
    `config/site-binding.ts`, `config/approval-policy.ts`,
    `config/creation-policy.ts`, `config/media-policy.ts`,
    `config/policy-bindings.ts` (+ `site.config.ts`). Missing
    `policy-bindings.ts` means the shell cannot resolve site identity at
    all. Not synthesizable by repair (identity carries per-client facts) —
    a gap here means re-scaffold. Who: **scaffold**. Audit: `config-bundle`.
11. **Netlify Identity (GoTrue) ENABLED on the site** — `/admin` login is
    the hand-rolled GoTrue client (`lib/admin/goTrueClient.ts` → the site's
    `/.netlify/identity` GoTrue; the unused `netlifyIdentityLoader.ts` widget
    loader was deleted in W18 T18.8); server-side auth verifies tokens
    against the same endpoint (`admin-auth.ts`). No CLI can enable Identity. Who: **Netlify console
    (human)** — runbook §admin, step 1. Audit: `identity-enabled` (HUMAN).
12. **`ADMIN_EMAILS` set** — the bootstrap-Owner allowlist
    (`roles.ts`): members are implicit Owners forever, the env fallback
    that makes a wiped/empty `users` store unable to lock the operator out.
    Until an invite exists this is the ONLY way in. Who: **env (human)** —
    runbook §admin, step 2. Audit: named in `admin-env-values` (HUMAN);
    the NAME is pinned in create-site's checklist (`env-checklist`, PASS/GAP).
13. **First Owner invited** — `/admin/settings/admins` → invite (GoTrue
    admin API via the function's injected identity context; no new
    secrets), or rely on `ADMIN_EMAILS` alone. Who: **console/admin UI
    (human)** — runbook §admin, step 3. Audit: `identity-enabled` (HUMAN).
14. **`IDENTITY_URL`** — override only; functions fall back to
    `<site URL>/.netlify/identity`, correct once Identity is enabled. Who:
    **env (human, optional)**. Audit: named in `admin-env-values`.
15. **Role allowlists** (`ROLE_EMAILS_ADMIN/EDITOR/PUBLISHER`) — optional
    env vocabulary consumed by the publish gate; the two-tier workspace UI
    assigns owner/admin via the users store. Who: **env (human,
    optional)**.

### E. Stores and secrets (who: provisioning + env)

16. **Per-site blob stores round-trip** — the admin workspace reads/writes
    `users` (members/roles), `agent-chats` (the chat hub),
    `agent-profiles` (dedicated agents, W9 §4a), `governance` (guardrail
    overrides, agent keys, OAuth AS records — W14 F10 stores its clients/
    codes/tokens here), plus `site-objects`, `artifacts`/`artifact-index`,
    `workflows`, `commerce`, `opt-ins`, `commerce-events`,
    `tracking-events`. `create-site` provisioning probes ALL of them
    (write→read→delete). **W15 S2 finding:** the probe list previously
    covered 8 of 12 — `agent-profiles` (admin chat's dedicated-agent
    resolution), `opt-ins`, `commerce-events`, `tracking-events` were used
    by core but never probed; the list is now CHECKED against the store
    literals in core (`scanCoreBlobStoreNames`), so it cannot silently rot
    again. Who: **provisioning (auto)**. Audit: `blob-store-probe`
    (list coverage) + `store-provisioning-run` (HUMAN: needs a token).
17. **`NETLIFY_SITE_ID`** — set automatically by provisioning; blob runtime
    detection keys on it (without it functions fall back to the file-backed
    test store and the workspace looks empty in production). Who:
    **provisioning (auto)**.
18. **Auto-minted per-site secrets** — `PUBLISH_SECRET` (the object-store
    write gate every admin mutation ultimately crosses),
    `ARTIFACT_UPLOAD_TOKEN_SECRET` (image upload from workspace/canvas),
    `MCP_HTTP_AUTH_TOKEN`, `TRACKING_SALT`. Who: **provisioning (auto)**.
19. **AI provider keys** — `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`
    (fleet-shared): the agents hub and every per-object chat instantiate a
    provider adapter; both providers are v1 (Wolf 2026-07-16).
    (`OPENAI_CHATKIT_WORKFLOW_ID` was REMOVED from the checklist this wave:
    ChatKit retired at T9.24, no core code reads it.) Who: **env (human,
    fleet-shared)**. Audit: named in `admin-env-values`.
20. **Publish/release last mile** — `GITHUB_REPOSITORY`/`GITHUB_BRANCH`/
    `GITHUB_CONTENT_TOKEN`/`GITHUB_COMMIT_AUTHOR_*` (publish materializes
    committed exports through the git-write path) and
    `NETLIFY_BUILD_HOOK_URL` (the admin release flow's rebuild). Without
    these, /admin works up to publish and then dead-ends. Who: **env
    (human)**. Audit: named in `admin-env-values`.

### F. OAuth authorization server (who: scaffold — nothing to provision)

21. **The OAuth AS needs no per-site provisioning beyond rows 4/7/16** —
    `mcp-oauth` shim + the nine rewrites + the `governance` store + an
    enabled Identity (the consent screen `/admin/authorize` is approved by
    a signed-in admin). W14 F10's design goal was exactly "nothing to
    provision"; the audit verifies the three carriers it rides on.

## Using the machinery

```
# Prove a tenant (read-only, exit 1 on any GAP):
node scripts/audit-site-admin-parity.mjs --site sites/platform
node scripts/audit-site-admin-parity.mjs --root        # the drlurie root deploy
node scripts/audit-site-admin-parity.mjs --all         # whole fleet

# Repair an older site (additive, idempotent; dry-run first):
node packages/core/cli/migrate-site.mjs --site sites/<slug> --admin-parity
node packages/core/cli/migrate-site.mjs --site sites/<slug> --admin-parity --write
```

Standing regression guard: `tests/scripts/admin-parity.test.mjs` runs the
audit against every real tenant target on every `npm test`, and pins genesis
parity (a fresh scaffold audits gap-free) plus the repair loop (degrade →
repair → gap-free → second run is a no-op).

## Residual gaps that stay human

Enabling Identity, inviting the first Owner, setting `ADMIN_EMAILS` and the
other env VALUES, and running the credentialed provisioning probe are
account-authority acts (the R8-sanctioned halt class). The audit names them
(`HUMAN` rows) so they are visible in every run, and the runbook's §admin
carries the exact console steps. Everything else on this page is now checked
or generated — not remembered.
