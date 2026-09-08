# 21 — Site-binding threading

**Status:** landed on `fix/site-binding-threading` (W22).
**Seam:** `packages/core/server/lib/site-binding.ts`.

## What the seam guarantees now

A `SiteBinding` carries the site's identity and the env-var **names** its
credentials are read from — never values. Before this work, 25 core function
modules accepted a binding and threw it away (`createHandler = (_binding) =>
handlerImpl`), and ~145 store calls across `packages/core/server` fell back to
`PLATFORM_ENV_NAMES`. Because all four sites bind exactly that name set, the
fallback resolved identically and the defect was invisible at runtime — it
would have surfaced the first time a site rebound its names (staging, an
unusual topology, a test harness) as **cross-tenant reads**.

After this change, every store handle opened in `packages/core/server` is
opened with the binding of the site whose handler is running:

- every `get…BlobStore(event, binding)` / `getNetlifyBlobStore(name, event, binding)`
- `getManagedBlobStore` / `listManagedBlobStores` / the blob-store diagnostics
- `resolveRolesFromEvent` / `resolveAdminAccessFromEvent` — the admin auth gate,
  which itself reads the `users` store
- `netlify-deploys` and `production-release`, which take `envNames` rather than
  a whole binding because they already spoke env names
- the three previously hardcoded `PLATFORM_ENV_NAMES.publishSecret` reads
  (`admin-get-blob-pdf`, `deploy-status`, `save-artifact`) → `binding.env.publishSecret`

Behaviour on the live fleet is unchanged **by construction**: every new
parameter is optional with today's default, and every site binds
`PLATFORM_ENV_NAMES`. `functions/site-binding-threading.test.ts` pins both
halves — a rebound name set reaches `@netlify/blobs`, and a platform binding
still resolves `NETLIFY_SITE_ID` / `NETLIFY_BLOBS_TOKEN`.

## The MCP composite

`functions/mcp.ts` is a composite: its sibling handlers are injected once per
process by each site's shim through `configureMcp`. That input now carries a
required `binding: SiteBinding`, published through `lib/mcp-binding.ts`:

- `requireMcpBinding()` — fail-closed; used inside `mcp.ts`, whose siblings are
  guaranteed injected.
- `getMcpBinding()` — undefined-tolerant; used by the shared tool libraries
  (`mcp-tool-handlers`, `mcp-artifact-admin`, `mcp-analytics-handlers`,
  `whoami`, `agent/context`), which are also reachable from lambdas that may not
  have configured the composite. `undefined` reproduces today's default exactly,
  so this can never turn a working path into a throw.

This module holds env-var **names**, not resolved values — the
"never cache at module scope" rule in `site-binding.ts` is about values.

## The lint rule

`eslint.config.js` carries a `no-restricted-syntax` block scoped to
`packages/core/server/**/*.ts` (tests excluded) that fails any store getter,
`getNetlifyBlobStore`, managed-store call, blob-store diagnostic or role
resolver invoked without the binding. It runs in `npm run check:eslint` and in
the editor. It is a **code-shape** rule, which is why it lives here and not in
`scripts/audit-site-admin-parity.mjs` — that audit is per-site _provisioning_
(netlify.toml, shims, env presence) and never touches core code shape.

A rule on the `_binding` parameter was rejected: it would miss unbound calls
made inside lib code or inside a handler that already has a binding in scope,
and would wrongly flag a future handler that genuinely needs nothing.

## How to add a new store getter

1. Put the getter in `lib/blob-store.ts` next to its siblings, with the
   signature `(event: unknown, binding?: SiteBinding)`, forwarding to
   `getNetlifyBlobStore({ name, consistency }, event, binding)`. Say in a
   comment why the consistency level is what it is.
2. Name it `get…BlobStore` — the lint selector matches `^get[A-Za-z]*(BlobStore|MembershipStore)$`,
   so a conforming name is guarded automatically.
3. Call it as `get…BlobStore(event, binding)` from a handler built by
   `createHandler = (binding: SiteBinding) => buildHandlerImpl(binding)`. A
   file-local helper that opens a store takes `binding` as a parameter; an
   exported lib function takes an **optional** trailing `binding?: SiteBinding`
   so existing callers keep compiling.
4. If the new store is opened from the MCP tool libraries, pass
   `getMcpBinding()`.
5. If the handler is one the proof test can drive, add a case to
   `functions/site-binding-threading.test.ts`.

## Deliberately left alone

- `getNetlifyBlobStore`'s `PLATFORM_ENV_NAMES` default — it is what keeps every
  new parameter behaviour-neutral.
- `lib/blob-admin.ts` keeps its direct `@netlify/blobs` import (it needs
  `listStores`) and its module-scope `lambdaContextConnected` latch (W14 F8).
- No site rebinds `env`; all four still set `PLATFORM_ENV_NAMES`.
- The blob-store eventual-consistency note at `blob-store.ts` (W14 T14.4)
  is untouched: on the name-lookup path, requested `'strong'` has always been
  silently eventual.
