/**
 * This site's image budget. `overBudget: 'warn'` records the overage and lets
 * the write through; 'block' refuses it.
 */
import type { MediaPolicyConfig } from '../../../packages/core/lib/media-policy.js';

export const mediaPolicyConfig = {
  maxImageBytes: 153_600, // 150 KB — web-optimized budget
  overBudget: 'warn',
  preferredImageFormat: 'webp',
} satisfies MediaPolicyConfig;
