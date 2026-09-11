/**
 * DEPRECATED SHIM — kept for one release (W1 T1.1).
 *
 * This module's contents moved to `region-registry.ts`, which answers the same
 * question for every reader-side region rather than for the header's action
 * slot alone. The two exports below are re-exports, not copies: there is one
 * implementation, and importing either path reaches it.
 *
 * Delete this file once no importer names it (`rg structural-capacity`).
 */
export { navActionCapacity, type CapacityRule } from './region-registry.js';
