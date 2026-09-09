/**
 * Editorial strategy materializer — 'editorial_strategy.v1' →
 * `<exportRoot>/strategy/{strategy_id}.json` (Wolf, 2026-09-09).
 *
 * The editorial-voice materializer's twin, and it exists for the same single
 * reason: a strategy change should show up in the same publish commit history
 * a page change does, so `git log` answers "when did this publication's offer
 * or funnel aggression change, and who approved it". NO Astro route reads this
 * file, and none should — the engine reads the strategy through the live
 * object surface (`object_get('strat_<site>')`), so this export is the audit
 * trail, never the transport.
 *
 * `private.notes` is dropped on the way out by `renderExport`'s `stripPrivate`
 * (materializers/shared.ts) — the strategist's own reasoning stays in the
 * store and never lands in a tenant's committed tree.
 *
 * Pure, like every sibling: same body in, byte-identical file out.
 */
import { editorialStrategyBodySchema } from '../../../schema/bodies/editorial-strategy-v1.js';
import { exportPath, renderExport, type MaterializeMeta, type MaterializedFile } from './shared.js';

export const materializeEditorialStrategy = (
  objectId: string,
  body: unknown,
  meta: MaterializeMeta
): MaterializedFile => {
  const parsed = editorialStrategyBodySchema.parse(body);
  return {
    path: exportPath(meta, 'strategy', `${objectId}.json`),
    content: renderExport('editorial_strategy', objectId, parsed, meta),
  };
};
