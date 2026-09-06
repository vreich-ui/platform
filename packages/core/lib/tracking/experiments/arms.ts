/**
 * Experiment arm resolution (T21.5) — the pure reads over a `tracking_config`
 * body's `experiments[]` that BOTH the render seam and object validation need.
 *
 * Dependency-free on purpose: `packages/core/app` (Astro/Vite) and
 * `packages/core/server` (Node) both import it, and neither world's module
 * resolution may be assumed by the other.
 *
 * The build-time WEIGHT table and the served map live in
 * `scripts/lib/tracking-experiments.mjs` — weights are a build concern (they
 * come from the sink) and never reach the renderer, so nothing here knows
 * about them.
 */

export type ExperimentArmRecord = { variant_id: string; route: string };
export type ExperimentRecord = {
  object_id: string;
  arms: readonly ExperimentArmRecord[];
  status: string;
  winner?: string;
};

/**
 * The default article permalink pattern. Every site in the fleet uses
 * `/%slug%` (`sites/<client>/config.yaml` → `apps.blog.post.permalink`); the
 * pattern is a parameter rather than a constant so a site that changes it
 * cannot silently produce a route the edge would rewrite to a 404.
 */
export const DEFAULT_POST_PERMALINK_PATTERN = '/%slug%';

/** A content_item's public route, from its slug and the site's pattern. */
export const contentItemRoute = (slug: string, pattern: string = DEFAULT_POST_PERMALINK_PATTERN): string => {
  const filled = pattern.replace('%slug%', slug);
  const trimmed = filled.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

/** What one rendered article page needs to know about its own arm. */
export type ArmAssignment = {
  /** The CONTROL content_item id — the experiment's identity. */
  experiment_id: string;
  /** This page's own content_item id. */
  variant_id: string;
  /** True when this page IS the control (`variant_id === experiment_id`). */
  is_control: boolean;
  /** The control arm's route — a non-control arm canonicalizes to it. */
  control_route: string;
};

/**
 * Index every ACTIVE experiment's arms by content_item id.
 *
 * `draft` and `concluded` produce nothing: draft is an authoring state, and
 * concluding an experiment must revert every reader to the control on the next
 * build with no second switch to remember. An experiment whose arm list does
 * not contain its own control is skipped rather than half-served — validation
 * refuses that shape at write time, so reaching it means a hand-edited export.
 */
export const indexActiveArms = (
  experiments: readonly ExperimentRecord[] | undefined
): Record<string, ArmAssignment> => {
  const index: Record<string, ArmAssignment> = {};
  for (const experiment of experiments ?? []) {
    if (experiment.status !== 'active') continue;
    if (experiment.arms.length < 2) continue;
    const control = experiment.arms.find((arm) => arm.variant_id === experiment.object_id);
    if (!control) continue;
    for (const arm of experiment.arms) {
      index[arm.variant_id] = {
        experiment_id: experiment.object_id,
        variant_id: arm.variant_id,
        is_control: arm.variant_id === experiment.object_id,
        control_route: control.route,
      };
    }
  }
  return index;
};
