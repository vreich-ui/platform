/**
 * Consent banner markup builder (W13 T13.6, 12-plan §8) — the PURE half of
 * ConsentBanner.astro, so the markup contract is unit-testable: the banner
 * is a CODE component; agents influence ONLY the validated plain-string copy
 * in `tracking_config.consent.banner` (schema-bounded lengths), and every
 * copy string is HTML-escaped here — copy can never smuggle markup.
 *
 * The element ships `hidden` and is revealed exclusively by the consent
 * runtime (restricted region + no stored choice, or the #privacy-choices
 * re-open link). All interactivity is delegated: the runtime listens for
 * clicks on `[data-trk-consent]` controls — this markup carries no script.
 * The manage panel's option labels are code-owned (deliberately not
 * agent-copy: they name the two GRANTS, which are mechanics, not voice).
 */
import type { TrackingConfigBody } from '../../../schema/bodies/tracking-config-v1.js';

export type ConsentBannerCopy = NonNullable<TrackingConfigBody['consent']['banner']>;

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string
  );

export const buildConsentBannerHtml = (copy: ConsentBannerCopy): string => {
  const manage = copy.manage_label
    ? `<button type="button" data-trk-consent="manage" class="btn-link text-sm">${escapeHtml(copy.manage_label)}</button>`
    : '';
  return (
    `<div id="trk-consent-banner" hidden role="dialog" aria-live="polite" aria-label="${escapeHtml(copy.headline)}"` +
    ` class="fixed inset-x-0 bottom-0 z-[var(--dl-layer-overlay)] border-t border-gray-200 bg-page px-4 py-4 shadow-lg sm:px-6 dark:border-gray-800">` +
    `<div class="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">` +
    `<div class="max-w-2xl">` +
    `<p class="text-sm font-semibold text-heading">${escapeHtml(copy.headline)}</p>` +
    `<p class="mt-1 text-sm text-muted">${escapeHtml(copy.body)}</p>` +
    `</div>` +
    `<div class="flex flex-wrap items-center gap-3">` +
    manage +
    `<button type="button" data-trk-consent="reject" class="btn-secondary text-sm">${escapeHtml(copy.reject_label)}</button>` +
    `<button type="button" data-trk-consent="accept" class="btn-primary text-sm">${escapeHtml(copy.accept_label)}</button>` +
    `</div>` +
    `</div>` +
    `<div data-trk-consent-panel hidden class="mx-auto mt-3 flex max-w-5xl flex-wrap items-center gap-4 border-t border-gray-200 pt-3 dark:border-gray-800">` +
    `<label class="flex items-center gap-2 text-sm text-default">` +
    `<input type="checkbox" data-trk-consent-opt="analytics" class="h-4 w-4" /> Analytics identifier</label>` +
    `<label class="flex items-center gap-2 text-sm text-default">` +
    `<input type="checkbox" data-trk-consent-opt="ads" class="h-4 w-4" /> Advertising measurement</label>` +
    `<button type="button" data-trk-consent="save" class="btn-secondary text-sm">Save choices</button>` +
    `</div>` +
    `</div>`
  );
};
