/**
 * Task 3 §3 — registry selection helpers: resolve which chat-tool registry
 * (agent/tools.ts's curated CHAT_TOOLS vs agent/generated-tools.ts's
 * GENERATED_CHAT_TOOLS) a run is wired against, and compute per-call autonomy
 * with the mid-deploy safety re-clamp. A small standalone module rather than
 * folding into generated-tools.ts, since these helpers dispatch across BOTH
 * registries — tools.ts's legacy one included.
 */
import { CHAT_TOOL_ALIASES } from '../mcp-tool-definitions.js';
import { chatToolByName, CHAT_TOOLS, type ChatTool, type ToolAutonomy } from './tools.js';
import { GENERATED_CHAT_TOOLS, generatedChatToolByName } from './generated-tools.js';
import type { ChatRun, RegistryKind } from './chat-store.js';

export type { RegistryKind };

/** A run without the `registry` stamp (in-flight from before this deploy) is
 *  treated as 'legacy' — never silently promoted to the generated registry. */
export const runRegistryKind = (run: Pick<ChatRun, 'registry'>): RegistryKind => run.registry ?? 'legacy';

export const toolByName = (kind: RegistryKind, name: string): ChatTool | undefined =>
  kind === 'legacy' ? chatToolByName(name) : generatedChatToolByName(name);

export const registryTools = (kind: RegistryKind): readonly ChatTool[] =>
  kind === 'legacy' ? CHAT_TOOLS : GENERATED_CHAT_TOOLS;

/**
 * Reverse of CHAT_TOOL_ALIASES: canonical (generated) name → legacy name.
 * ONLY ever consulted to read an OLD, legacy-keyed autonomy map under the
 * generated registry — never to canonicalize a forward/wire tool name. The
 * forward table's ambiguous `search_artifacts` → `list_artifacts_for_request`
 * entry is harmless here: reversed, it becomes
 * `list_artifacts_for_request` → `search_artifacts`, which is exactly the
 * legacy meaning a frozen pre-migration autonomy map could carry.
 */
const REVERSE_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(CHAT_TOOL_ALIASES).map(([legacyName, canonicalName]) => [canonicalName, legacyName])
);

const defaultAutonomyByClass = (tool: ChatTool): ToolAutonomy => (tool.toolClass === 'read' ? 'auto' : 'ask');

/**
 * Per-call autonomy resolution (the mid-deploy safety rule): the run's
 * frozen autonomy map keyed by the call's own name first, then by its
 * reverse-alias legacy name (a frozen legacy-keyed map read under the
 * generated registry), then a class-based default (`read` → 'auto', else
 * 'ask') — ALWAYS re-clamped against the tool's `autonomyFloor` at lookup
 * time, so a frozen legacy autonomy map can never let a floored write run
 * un-asked under the generated registry. Returns undefined only when `kind`
 * has no tool by that name at all.
 */
export const autonomyForCall = (
  kind: RegistryKind,
  run: Pick<ChatRun, 'autonomy'>,
  name: string
): ToolAutonomy | undefined => {
  const tool = toolByName(kind, name);
  if (!tool) return undefined;
  // Look up by the RESOLVED tool's canonical name first, not the call's own
  // name: under the generated registry a model may still emit a legacy alias
  // (its transcript history taught it "get_object"), and keying the frozen map
  // by that alias would bypass an owner's 'off'/'ask' set on the canonical
  // name. The raw call name and the reverse-alias legacy name remain as
  // fallbacks for legacy-keyed maps.
  const legacyName = REVERSE_ALIASES[tool.name];
  const resolved =
    run.autonomy[tool.name] ??
    run.autonomy[name] ??
    (legacyName !== undefined ? run.autonomy[legacyName] : undefined) ??
    defaultAutonomyByClass(tool);
  return tool.autonomyFloor === 'ask' && resolved === 'auto' ? 'ask' : resolved;
};
