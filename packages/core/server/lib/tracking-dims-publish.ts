/**
 * The annotation layer reaches the SINK, at publish, from the STORE (KI-08).
 *
 * WHAT WAS WRONG. `node_strategy.strategy` / `.intent` are the persuasion
 * architecture of an article — which block is the hook, which is the agitation.
 * They were sourced from the committed EXPORT by
 * `scripts/tracking-dims-push.mjs`, and the export is deliberately stripped of
 * every `private` block on the way out (`materializers/shared.ts` `stripPrivate`,
 * applied in `renderExport`). So from 2026-09-03 — the day the strip landed —
 * every row that script pushed carried NULL labels, and only the ~21 articles
 * published before it kept theirs. Nothing failed: the POST succeeded, the rows
 * upserted, the columns were null. Downstream, CMS-Agent's `strategyLearning`
 * drops a row with neither label (`if (!strategy && !intent) continue`), so the
 * whole strategy grain would have read as "a quiet week" forever.
 *
 * THE STRIP IS NOT THE BUG. It is a security seam: the export is committed to
 * git, and a private repository is one access-control accident from a public
 * one. It stays. The labels are routed AROUND it instead.
 *
 * WHY HERE. `publishObject` holds `record.body` — the full store record, before
 * any materializer touches it — and it already knows the publish succeeded. So
 * this is the one place where the labels exist, the publish is durable, and the
 * push cannot affect the outcome. `scripts/tracking-dims-push.mjs` keeps
 * pushing `object_version` and `producer` at postbuild; only `node_strategy`
 * moves here.
 *
 * WHY A NULL PUSH IS HARMLESS. The sink upserts with
 * `strategy = COALESCE(EXCLUDED.strategy, node_strategy.strategy)`
 * (kugel-data `netlify/functions/tracking-sink-dims.ts`), so the postbuild
 * script's null labels cannot overwrite a real one that arrived here first.
 * The two paths coexist rather than racing.
 *
 * BEST-EFFORT, ALWAYS. Missing configuration, an unreachable sink, a non-2xx,
 * a timeout — all return a result and never throw. A dimensions outage must
 * never fail, delay past its timeout, or roll back a publish that is already
 * committed and stamped. No token value is ever logged or returned.
 */

const DIMS_TIMEOUT_MS = 2_000;

export interface NodeStrategyRow {
  object_id: string;
  node_id: string;
  strategy: string | null;
  intent: string | null;
  node_kind: string | null;
  position: number;
}

export interface TrackingDimsEnv {
  TRACKING_SINK_URL?: string;
  TRACKING_SINK_TOKEN?: string;
  TRACKING_PROJECT_ID?: string;
}

export interface PushNodeStrategyDimsOptions {
  objectType: string;
  objectId: string;
  /** The STORE record's body — full and unstripped. Never the export. */
  body: unknown;
  env?: TrackingDimsEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface PushNodeStrategyDimsResult {
  ok: boolean;
  /** Why nothing was sent, when nothing was sent. Never an error. */
  skipped?: 'not_an_article' | 'no_rows' | 'missing_configuration';
  status?: number;
  /** Row COUNT only. Rows carry editorial annotation and are not returned. */
  rows: number;
  labelled: number;
  error?: string;
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The same projection `scripts/tracking-dims-push.mjs` applies to an export —
 * deliberately identical, including `position` being the array index and a node
 * without an id being skipped, so the two sources cannot disagree about what a
 * row IS. The only difference is that `private` is still here to read.
 */
export const nodeStrategyRowsFromBody = (objectId: string, body: unknown): NodeStrategyRow[] => {
  if (!isRecord(body) || !Array.isArray(body.nodes)) return [];
  const rows: NodeStrategyRow[] = [];
  body.nodes.forEach((node: unknown, position: number) => {
    if (!isRecord(node)) return;
    const nodeId = stringOrNull(node.id);
    if (!nodeId) return;
    const priv = isRecord(node.private) ? node.private : {};
    rows.push({
      object_id: objectId,
      node_id: nodeId,
      strategy: stringOrNull(priv.strategy),
      intent: stringOrNull(priv.intent),
      node_kind: stringOrNull(node.kind),
      position,
    });
  });
  return rows;
};

export const pushNodeStrategyDims = async ({
  objectType,
  objectId,
  body,
  env = process.env as TrackingDimsEnv,
  fetchImpl = globalThis.fetch,
  timeoutMs = DIMS_TIMEOUT_MS,
}: PushNodeStrategyDimsOptions): Promise<PushNodeStrategyDimsResult> => {
  // Only articles carry the annotation layer. A page or a section publishing is
  // not a missing-configuration problem and must not be reported as one.
  if (objectType !== 'content_item') return { ok: true, skipped: 'not_an_article', rows: 0, labelled: 0 };

  const rows = nodeStrategyRowsFromBody(objectId, body);
  const labelled = rows.filter((row) => row.strategy !== null || row.intent !== null).length;
  if (rows.length === 0) return { ok: true, skipped: 'no_rows', rows: 0, labelled: 0 };

  const sinkUrl = env.TRACKING_SINK_URL?.trim();
  const token = env.TRACKING_SINK_TOKEN?.trim();
  const projectId = env.TRACKING_PROJECT_ID?.trim();
  if (!sinkUrl || !token || !projectId || typeof fetchImpl !== 'function') {
    return { ok: true, skipped: 'missing_configuration', rows: rows.length, labelled };
  }

  try {
    const response = await fetchImpl(`${sinkUrl.replace(/\/+$/, '')}/dims`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, node_strategy: rows }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status, rows: rows.length, labelled };
  } catch (error) {
    return {
      ok: false,
      rows: rows.length,
      labelled,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** One line, counts only — never a label, never a token. */
export const describeDimsPush = (objectId: string, result: PushNodeStrategyDimsResult): string =>
  result.skipped
    ? `[tracking-dims] ${objectId}: skipped (${result.skipped})`
    : result.ok
      ? `[tracking-dims] ${objectId}: pushed ${result.rows} node_strategy row(s), ${result.labelled} labelled`
      : `[tracking-dims] ${objectId}: push failed, publish unaffected (${result.rows} row(s), ${result.labelled} labelled)`;
