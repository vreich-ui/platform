/**
 * The MCP composite's SiteBinding, injected once per process by `configureMcp`.
 *
 * This module holds a `SiteBinding` at module scope — that is, env-var NAMES
 * and the site id. It NEVER holds resolved secret VALUES: the
 * no-module-scope-caching rule in `site-binding.ts` is about values, which are
 * still read live from `process.env` at every call through `readBoundEnv`, so
 * per-invocation resolution and cross-binding isolation are unaffected.
 *
 * It exists because `functions/mcp.ts`'s composite ALREADY holds per-site state
 * of exactly this lifetime — the sibling handlers a site's shim injects once
 * per process via `configureMcp` — and the tool bodies reached from it are
 * spread across `mcp-tool-handlers.ts`, `mcp-artifact-admin.ts`,
 * `mcp-analytics-handlers.ts` and `whoami.ts`. Threading a binding parameter
 * through ~40 exported `call*` tool entry points and every one of their callers
 * would be a far larger and riskier change for the same guarantee.
 *
 * Two readers, deliberately:
 *   - `requireMcpBinding()` for code that only runs behind `configureMcp`
 *     (mcp.ts's own bodies), where a missing binding is a real misconfiguration;
 *   - `getMcpBinding()` for the shared tool-handler libraries, which are also
 *     reachable from lambdas that never configured the composite. There
 *     `undefined` reproduces today's exact default (`PLATFORM_ENV_NAMES`), so
 *     threading can never turn a working call into a throw.
 */
import type { SiteBinding } from './site-binding.js';

let mcpBinding: SiteBinding | undefined;

/** Called by `configureMcp` with the shim's own SiteBinding. */
export const setMcpBinding = (binding: SiteBinding): void => {
  mcpBinding = binding;
};

/** Undefined-tolerant reader: `undefined` means "fall back to the platform names". */
export const getMcpBinding = (): SiteBinding | undefined => mcpBinding;

/** Fail-closed reader, for code paths that only run after `configureMcp`. */
export const requireMcpBinding = (): SiteBinding => {
  if (!mcpBinding) {
    throw new Error("MCP server not configured — this site's shim must call configureMcp() with its SiteBinding.");
  }
  return mcpBinding;
};
