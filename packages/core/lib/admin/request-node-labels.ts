/**
 * The pipeline node id → plain-language phrase table, as a LEAF module.
 *
 * INTEGRATE (wave 2, admin-read-model): `agent/tools.ts` and
 * `requests/activity.ts` want `nodeLabel` and nothing else out of
 * `request-logic.ts`, which is 51 KB of ADMIN SCREEN vocabulary — row
 * actions, quick filters, publish-policy reasons, empty states, notification
 * scanning — in server modules that render none of it. Same cut as
 * `lib/admin/display-name-core.ts` (M3.2) and `lib/admin/request-list-order.ts`
 * (M2.1), for the same reason and against the same test.
 *
 * `request-logic.ts` re-exports both names, so no client call site changed.
 * Server code imports THIS spelling; either compiles, only this one is leaf.
 */
/**
 * Human labels for the `publishing_conductor` nodes, so a row reads
 * "researching" rather than "research". An unknown node falls back to its raw
 * id — hiding a node we do not recognise would be worse than showing it.
 */
export const NODE_LABELS: Record<string, string> = {
  input_triage: 'reading the brief',
  placement_resolver: 'placing it',
  topic_opportunity: 'sizing the topic',
  monetization_strategy: 'planning the offer',
  reader_insight: 'profiling the reader',
  research: 'researching',
  objection_mapping: 'mapping objections',
  narrative_movement: 'shaping the narrative',
  angle_strategy: 'choosing the angle',
  brief_architect: 'writing the brief',
  draft_writer: 'drafting',
  human_texture: 'reviewing texture',
  trust_factual: 'fact-checking',
  emotional_resonance: 'reviewing resonance',
  reader_simulation: 'simulating a reader',
  review_aggregator: 'gathering reviews',
  contract_intelligence: 'checking the contract',
  artifact_plan: 'planning media',
  article_body: 'building the article',
  publish_payload: 'preparing to publish',
  publication_controller: 'awaiting your approval',
  publish_executor: 'publishing',
  learning_recorder: 'recording what it learned',
  capture_crawl: 'crawling the source',
  capture_map: 'mapping the source',
  block_classifier: 'classifying blocks',
  capture_emit_live: 'building the site',
  capture_score: 'scoring fidelity',
  gap_adjudicator: 'adjudicating gaps',
  capture_report: 'writing the report',
};

export const nodeLabel = (nodeId: string | undefined): string | undefined =>
  nodeId ? (NODE_LABELS[nodeId] ?? nodeId) : undefined;
