/**
 * The one extra read once a run has published — bounded, best-effort, and
 * never before there is anything to read.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchPublicationOutputs } from './publication-outputs.js';
import { COMPACT_TAIL, PUBLISH_OUTPUT_PENDING, RELEASE_OUTPUT_EXECUTED } from './publication-evidence.fixtures.js';

const envelope = (runId: string, nodes: unknown[]) => ({
  run: { runId, status: 'completed', nodes },
  mode: null,
  stall: null,
});

const recordingClient = (answer: (name: string, args: Record<string, unknown>) => unknown) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    callTool: async <T>(name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const data = answer(name, args);
      if (data instanceof Error) throw data;
      return data === undefined ? { ok: false as const } : { ok: true as const, data: data as T };
    },
  };
};

describe('fetchPublicationOutputs', () => {
  it('reads nothing while publish_executor has not completed', async () => {
    const client = recordingClient(() => ({}));
    const outputs = await fetchPublicationOutputs(
      client,
      envelope('run_1', [{ nodeId: 'publish_executor', status: 'queued' }])
    );
    assert.deepEqual(outputs, {});
    assert.deepEqual(client.calls, []);
  });

  it("reads both executors, run-scoped, and unwraps node_get_latest_output's envelope", async () => {
    const client = recordingClient((name, args) =>
      name === 'node_get_latest_output'
        ? {
            output: {
              id: `artifact_${args.nodeId}`,
              nodeId: args.nodeId,
              runId: args.runId,
              value: args.nodeId === 'publish_executor' ? PUBLISH_OUTPUT_PENDING : RELEASE_OUTPUT_EXECUTED,
            },
          }
        : undefined
    );
    const outputs = await fetchPublicationOutputs(client, envelope('run_1788161192916_2sguif', COMPACT_TAIL));
    assert.deepEqual(
      client.calls.map((call) => [call.name, call.args.nodeId, call.args.runId]),
      [
        ['node_get_latest_output', 'publish_executor', 'run_1788161192916_2sguif'],
        ['node_get_latest_output', 'release_executor', 'run_1788161192916_2sguif'],
      ]
    );
    assert.equal(outputs.publish_executor, PUBLISH_OUTPUT_PENDING);
    assert.equal(outputs.release_executor, RELEASE_OUTPUT_EXECUTED);
  });

  it('degrades to whatever could be read: a refused or thrown read costs that output, not the view', async () => {
    const client = recordingClient((_name, args) =>
      args.nodeId === 'release_executor' ? new Error('HTTP 504') : { output: { value: PUBLISH_OUTPUT_PENDING } }
    );
    const outputs = await fetchPublicationOutputs(client, envelope('run_1', COMPACT_TAIL));
    assert.deepEqual(Object.keys(outputs), ['publish_executor']);

    const refused = recordingClient(() => undefined);
    assert.deepEqual(await fetchPublicationOutputs(refused, envelope('run_1', COMPACT_TAIL)), {});
  });

  it('drops an output recorded for a different run', async () => {
    const client = recordingClient(() => ({ output: { runId: 'run_other', value: RELEASE_OUTPUT_EXECUTED } }));
    assert.deepEqual(await fetchPublicationOutputs(client, envelope('run_1', COMPACT_TAIL)), {});
  });
});
