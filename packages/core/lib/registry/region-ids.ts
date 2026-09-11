/**
 * Region identifiers, alone in their own module.
 *
 * Deliberately separate from `region-registry.ts`: the registry derives its
 * rows from the component definitions, and every component definition declares
 * a `footprint.region`. Putting the id union in the registry would make that a
 * cycle (registry → definitions → types → registry). A five-line module is the
 * cheapest way to keep the dependency a straight line.
 */
export const REGION_IDS = [
  'header',
  'announcement',
  'flow',
  'sticky_bottom',
  'floating',
  'overlay',
  'footer',
] as const;

export type RegionId = (typeof REGION_IDS)[number];
