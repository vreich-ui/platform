/**
 * Sibling injection for every NON-/mcp lambda that reaches into mcp.ts.
 *
 * `packages/core/server/functions/mcp.ts` holds its three governed sibling
 * handlers (save-artifact, object-store, deploy-status) in module state,
 * injected once per site by that site's `netlify/functions/mcp.ts` shim. That
 * arrangement predates the chat's generated tool registry, which now executes
 * operational tools through the SAME handler bodies `tools/call` uses — and
 * those bodies reach the object store via `objectStoreHandler`.
 *
 * The admin chat lambdas are a different function, so nothing had ever called
 * `configureMcp()` in their process: the first `create_agent_artifact_job`
 * (whose brand-imagery lookup reads the site object) failed closed with
 * "MCP server not configured — this site's shim must call configureMcp()".
 *
 * The same trap caught `admin-plugin-manifest` (W6): it reads the tool surface
 * through `visibleToolDefinitions()`, whose `hasVerifyArticleImages()` filter
 * calls `requireSiblings()` — so an authenticated GET on /admin/plugins threw
 * "MCP server not configured" AFTER the auth gate and Netlify returned a bare
 * 502. Named `ensureMcpSiblings`, not `...ForChat`, because the requirement is
 * structural: it belongs to any lambda that touches this module, and a
 * chat-shaped name is what made the plugin function look out of scope.
 *
 * Rather than editing two shims per site across the fleet (and requiring every
 * future site to remember), the core functions call this once per
 * invocation. It is:
 *
 *   - derived from the caller's OWN SiteBinding, so it can never inject
 *     another tenant's handlers — the exact property the fail-closed doctrine
 *     in mcp.ts exists to protect;
 *   - guarded by `isMcpConfigured()`, so a real MCP shim that already injected
 *     a richer set (one carrying the optional `verifyArticleImagesHandler`) is
 *     never downgraded;
 *   - cheap and idempotent: after the first call on a warm instance the guard
 *     short-circuits before building anything.
 */
import { configureMcp, isMcpConfigured } from '../../functions/mcp.js';
import { createHandler as createSaveArtifactHandler } from '../../functions/save-artifact.js';
import { createHandler as createObjectStoreHandler } from '../../functions/object-store.js';
import { createHandler as createDeployStatusHandler } from '../../functions/deploy-status.js';
import type { SiteBinding } from '../site-binding.js';

export const ensureMcpSiblings = (binding: SiteBinding): void => {
  if (isMcpConfigured()) return;
  configureMcp({
    saveArtifactHandler: createSaveArtifactHandler(binding),
    objectStoreHandler: createObjectStoreHandler(binding),
    deployStatusHandler: createDeployStatusHandler(binding),
  });
};
