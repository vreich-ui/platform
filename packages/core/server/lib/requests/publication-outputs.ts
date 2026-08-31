/**
 * The one extra read the activity surfaces make once a run has published:
 * the executors' own outputs, via `node_get_latest_output`.
 *
 * Why not `workflow_get_run` with `detail: "full"`: that record is ~1MB on a
 * real run (every node's input and output), and these surfaces are polled
 * every few seconds. The compact view — what they read today — carries no
 * node output at all, so it can prove a publish was committed (its warning)
 * but not that a deploy was served, nor where the article lives. The two
 * executor outputs together are under 10KB and carry the article path, the
 * export commit, the deploy id and the verification verdict.
 *
 * Fetched only once `publish_executor` has completed (`publicationOutputsWorthReading`)
 * — nothing to read before then, and a polled running run stays at its two
 * reads. Best-effort by construction: a failed read (bridge down, tool not
 * on this site's token allowlist) degrades to the compact evidence, which
 * never claims more than it can prove.
 */
import { publicationOutputsWorthReading } from './publication-evidence.js';

export interface PublicationOutputReader {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: T }>;
}

export const PUBLICATION_OUTPUT_NODES = ['publish_executor', 'release_executor'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const runNodes = (payload: unknown): Array<{ nodeId?: string; id?: string; status?: string }> => {
  if (!isRecord(payload)) return [];
  const run = isRecord(payload.run) ? payload.run : payload;
  return Array.isArray(run.nodes) ? run.nodes.filter(isRecord) : [];
};

const runIdOf = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  const run = isRecord(payload.run) ? payload.run : payload;
  const id = run.runId ?? run.id;
  return typeof id === 'string' && id ? id : undefined;
};

/**
 * `{ publish_executor: <output value>, release_executor: <output value> }` for
 * whichever outputs could be read; `{}` when the run has not published yet or
 * nothing could be read.
 */
export const fetchPublicationOutputs = async (
  client: PublicationOutputReader,
  runPayload: unknown
): Promise<Record<string, unknown>> => {
  const runId = runIdOf(runPayload);
  if (!runId || !publicationOutputsWorthReading(runNodes(runPayload))) return {};
  const reads: Array<[string, unknown] | undefined> = await Promise.all(
    PUBLICATION_OUTPUT_NODES.map(async (nodeId): Promise<[string, unknown] | undefined> => {
      try {
        const result = await client.callTool<Record<string, unknown>>('node_get_latest_output', { nodeId, runId });
        if (!result.ok || !isRecord(result.data)) return undefined;
        const output = isRecord(result.data.output) ? result.data.output : result.data;
        // The value is the executor's artifact; a record for another run is
        // not evidence about this one (defensive — the read is run-scoped).
        if (typeof output.runId === 'string' && output.runId !== runId) return undefined;
        return [nodeId, output.value ?? output];
      } catch {
        return undefined;
      }
    })
  );
  return Object.fromEntries(reads.filter((entry): entry is [string, unknown] => entry !== undefined));
};
