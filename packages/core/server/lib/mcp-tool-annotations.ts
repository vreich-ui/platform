/**
 * MCP tool annotations (2026-09-01) — the wire shape of a tool definition.
 *
 * TWO PROBLEMS THIS FIXES, both found by capturing the live ChatGPT Agent:
 *
 * 1. The agent showed **"Read actions: none"** and confirmed every call,
 *    including `object_get` and `object_contract`. The MCP spec has a standard
 *    place to say otherwise — `annotations.readOnlyHint` — and this surface
 *    emitted no annotations at all, so a client had nothing to go on. Every
 *    read cost the operator a confirmation click for no reason.
 *
 * 2. `tools/list` returned the raw internal `ToolDefinition`, which carries
 *    `governance` — this repo's private chat-autonomy classification. That is
 *    an implementation detail leaking into a public protocol response.
 *
 * Both are the same fix: serialize a tool to the MCP shape on the way out, and
 * DERIVE the annotations from the governance class rather than hand-maintaining
 * a second list that can drift from it.
 *
 * `governance` remains on the in-process definition — `build-tools.ts` and the
 * chat registry read it directly — it simply stops travelling over the wire.
 */
import type { ToolDefinition } from '../functions/mcp.js';

/** The MCP `ToolAnnotations` subset this server asserts. */
export type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type McpWireTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
};

/**
 * Tools that genuinely remove or overwrite something a human would miss.
 * `destructiveHint` defaults to TRUE in the MCP spec for non-read tools, so
 * naming the destructive ones explicitly is what lets everything else be
 * correctly marked additive — publishing an article is a write, but it does not
 * destroy anything, and a client should not warn as though it does.
 */
const DESTRUCTIVE_TOOLS = new Set([
  'object_retire',
  'object_discard',
  'delete_pdf_template',
  'wipe_blob_stores',
  'member_remove',
  'member_purge',
  'ownership_transfer',
  'site_apply_theme',
  'site_apply_brand_imagery',
]);

/**
 * Tools that reach outside this tenant's own store — image search and URL
 * import fetch from the open internet. Everything else operates on governed
 * objects and artifacts this site owns, which is a closed world.
 */
const OPEN_WORLD_TOOLS = new Set([
  'search_images',
  'import_image_from_url',
  'import_images_from_url',
  'create_capture_job',
  'create_artifact_from_url',
  'verify_article_images',
  'deploy_status',
]);

const declaresIdempotencyKey = (inputSchema: Record<string, unknown>): boolean => {
  const properties = inputSchema.properties;
  return Boolean(properties && typeof properties === 'object' && 'idempotency_key' in properties);
};

export const annotationsFor = (tool: ToolDefinition): McpToolAnnotations => {
  const readOnly = tool.governance.toolClass === 'read';
  return {
    readOnlyHint: readOnly,
    // A read is never destructive; otherwise only the named set is.
    destructiveHint: readOnly ? false : DESTRUCTIVE_TOOLS.has(tool.name),
    // A read is trivially idempotent. A write is only claimed idempotent when
    // it actually implements the contract — an `idempotency_key` argument, the
    // QA-W16-1 bridge that replays the original receipt instead of running
    // twice. Never assert it from the tool's name.
    idempotentHint: readOnly || declaresIdempotencyKey(tool.inputSchema),
    openWorldHint: OPEN_WORLD_TOOLS.has(tool.name),
  };
};

/** Strips the internal `governance` field and adds the MCP annotations. */
export const toWireTool = (tool: ToolDefinition): McpWireTool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: annotationsFor(tool),
});
