/**
 * Render-side experiment arm resolution (T21.5).
 *
 * The edge function decides WHICH arm a reader gets; this decides what an
 * arm's page says about itself. Both read the same source of truth — the
 * published `tracking_config` export's `experiments[]` — so a page can never
 * claim an arm the edge is not serving, or vice versa.
 *
 * Two outputs, and only these two:
 *   1. The canvas/loader marker (`data-cms-experiment` + `data-cms-variant`)
 *      on the article wrapper. The loader reads it to emit one `exposure`.
 *      SinglePost writes the two attributes explicitly rather than spreading an
 *      object — see the note there; a spread changes every article's HTML.
 *   2. SEO for a NON-control arm: `<meta name="robots" content="noindex">`
 *      plus a canonical pointing at the CONTROL route. Two live URLs serving
 *      near-identical articles is a duplicate-content problem; the control is
 *      the one that indexes.
 *
 * Absent tracking export, or `experiments: []` → `null` for every article, and
 * the article page renders byte-for-byte what it rendered before T21.5.
 */
import { getCollection } from 'astro:content';

import { indexActiveArms, type ArmAssignment, type ExperimentRecord } from '../../lib/tracking/experiments/arms';

export type { ArmAssignment };

let armIndexPromise: Promise<Record<string, ArmAssignment>> | undefined;

/** `{content_item id → its arm}` over every ACTIVE experiment. Built once. */
const getArmIndex = (): Promise<Record<string, ArmAssignment>> => {
  armIndexPromise ??= (async () => {
    const entries = await getCollection('trackingConfigObject').catch(() => []);
    const experiments = (entries[0]?.data as { experiments?: ExperimentRecord[] } | undefined)?.experiments;
    return indexActiveArms(experiments);
  })();
  return armIndexPromise;
};

/** The arm this content_item is, or null when it is in no active experiment. */
export const resolveExperimentArm = async (contentItemId: string | undefined): Promise<ArmAssignment | null> => {
  if (!contentItemId) return null;
  return (await getArmIndex())[contentItemId] ?? null;
};

/** True when this arm must be de-indexed and canonicalized to the control. */
export const armNeedsCanonicalToControl = (arm: ArmAssignment | null | undefined): arm is ArmAssignment =>
  !!arm && !arm.is_control;
