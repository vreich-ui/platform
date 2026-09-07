/**
 * W3.3's one impure-looking piece, kept pure and out of `loop.ts` so it can be
 * tested without dragging the whole run loop (and the site-identity config it
 * needs) into a unit test.
 */
import { parseBlockage } from '../../../lib/admin/blockage.js';

/**
 * A blockage off a tool result, when there is one.
 *
 * Tool results travel as a JSON STRING (`ToolResult.content`), so this is the
 * one place that has to parse rather than read a field. Two shapes reach here:
 * the MCP error envelope a failed CMS-Agent call produces
 * (`{error:{code,message,blockage}}` — `toolKit.toolError` spreads a
 * WorkspaceToolError's details onto it) and, for a tool that returns a run
 * record, the run's own `blockages[]`. Both are validated by `parseBlockage`,
 * which drops anything it does not recognise, so a malformed or hostile result
 * yields nothing rather than a button with no handler.
 *
 * Deliberately tolerant: a result that is not JSON, or is JSON without a
 * blockage, is the overwhelming majority and must cost nothing.
 */
export const blockageFromToolResult = (content: string, isError?: boolean): Record<string, unknown> | undefined => {
  if (!content || content.length > 200_000) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const bag = parsed as Record<string, unknown>;
  const errorBag = bag.error && typeof bag.error === 'object' ? (bag.error as Record<string, unknown>) : undefined;
  const dataBag = bag.data && typeof bag.data === 'object' ? (bag.data as Record<string, unknown>) : undefined;
  const runBag = dataBag?.run && typeof dataBag.run === 'object' ? (dataBag.run as Record<string, unknown>) : undefined;
  const fromRun = Array.isArray(runBag?.blockages) ? runBag!.blockages[0] : undefined;
  // An error envelope's blockage only when the call actually failed: a
  // successful read that happens to carry a run's history should not raise a
  // wall in the conversation.
  const candidate = (isError ? errorBag?.blockage : undefined) ?? fromRun;
  return parseBlockage(candidate) ? (candidate as Record<string, unknown>) : undefined;
};
