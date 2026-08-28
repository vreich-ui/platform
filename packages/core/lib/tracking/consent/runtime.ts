/**
 * Consent runtime (W13 T13.6, 12-plan §8 — "legal but aggressive").
 *
 * `consentRuntime` is a SELF-CONTAINED function: no imports, no outer-scope
 * references, no TS-only runtime constructs. TrackingScripts serializes it
 * with `Function.prototype.toString` into the inline consent bootstrap —
 * emitted after `#trk-config` and BEFORE every vendor adapter head — so the
 * page ships exactly the code below (single source: the same function object
 * is what the gate-matrix tests execute against a fake window).
 *
 * The law it implements (OQ-W13-1, ratified 2026-07-19):
 * - The own tracker is cookieless and consent-free — this runtime never
 *   gates it; it gates ONLY `advertising`-class snippets (shipped as
 *   `<script type="text/plain" data-trk-gate="advertising">`) and the
 *   consented persistent-id upgrade.
 * - posture `geo-adaptive` (default): pixels auto-fire outside
 *   `restricted_regions`; inside (or while the region is UNKNOWN) they hold
 *   behind Consent Mode v2 denied defaults + the banner.
 * - posture `consent-first`: banner everywhere; nothing fires before grant.
 * - posture `us-first`: unknown = unrestricted (pixels fire immediately)
 *   UNLESS the `Intl` timezone heuristic says maybe-restricted — the
 *   heuristic may only KEEP scripts held, never release them.
 * - GPC beats everything: ad refusal + no id upgrade, any region, any grant.
 * - Region resolution: sessionStorage cache → `GET <ingest>?mode=region`
 *   (the T13.3 oracle) → cached for the session.
 * - `ad_personalization` stays DENIED even on grant: EEA/UK personalization
 *   requires a certified TCF CMP (§8 accuracy note) — this banner is
 *   deliberately not one; conversion tracking is the ceiling.
 * - Revocation after vendor tags already ran takes full effect on the next
 *   page load (scripts cannot be un-executed); the loader's consent flags
 *   and the persistent id react immediately via the `trk:consent` event.
 */

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type ConsentElementLike = {
  hidden: boolean;
  text: string;
  checked?: boolean;
  attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): ConsentElementLike | null;
  closest(selector: string): ConsentElementLike | null;
  replaceWith(other: ConsentElementLike): void;
};

type ConsentEventLike = { target: ConsentElementLike | null; preventDefault?: () => void };

export type ConsentDocumentLike = {
  readyState: string;
  getElementById(id: string): ConsentElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ConsentElementLike>;
  createElement(tag: string): ConsentElementLike;
  addEventListener(type: string, listener: (event: ConsentEventLike) => void): void;
  dispatchEvent(event: unknown): boolean;
};

export type ConsentWindowLike = {
  document: ConsentDocumentLike;
  navigator?: { globalPrivacyControl?: boolean };
  localStorage: StorageLike;
  sessionStorage: StorageLike;
  fetch?: (url: string, init?: unknown) => Promise<{ json(): Promise<unknown> }>;
  CustomEvent: new (type: string, init?: { detail?: unknown }) => unknown;
  Intl?: { DateTimeFormat(): { resolvedOptions(): { timeZone?: string } } };
  Date: { now(): number };
  dataLayer?: unknown[];
  __trk?: Record<string, unknown>;
};

export type ConsentDetail = { analytics: boolean; ads: boolean; gpc: boolean };

export const consentRuntime = (win: ConsentWindowLike): void => {
  const doc = win.document;
  const configElement = doc.getElementById('trk-config');
  const rawConfig = configElement && configElement.text !== undefined ? configElement.text : null;
  if (!rawConfig) return;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(rawConfig) as Record<string, unknown>;
  } catch {
    return;
  }
  const consentConfig = (config.consent && typeof config.consent === 'object' ? config.consent : {}) as Record<
    string,
    unknown
  >;
  const posture =
    consentConfig.posture === 'consent-first' || consentConfig.posture === 'us-first'
      ? (consentConfig.posture as string)
      : 'geo-adaptive';
  const regions = Array.isArray(consentConfig.regions) ? (consentConfig.regions as string[]) : [];
  const honorGpc = consentConfig.gpc !== false;
  const analyticsIdMode =
    consentConfig.analytics_id_mode === 'unrestricted-auto' ? 'unrestricted-auto' : 'granted-only';
  const gpc = honorGpc && !!win.navigator && win.navigator.globalPrivacyControl === true;

  const read = (storage: StorageLike, key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (storage: StorageLike, key: string, value: string): void => {
    try {
      storage.setItem(key, value);
    } catch {
      /* private mode — the session just stays unstored */
    }
  };

  let stored: { analytics: boolean; ads: boolean } | null = null;
  const storedRaw = read(win.localStorage, '_dlconsent');
  if (storedRaw) {
    try {
      const parsed = JSON.parse(storedRaw) as { analytics?: unknown; ads?: unknown };
      if (parsed && typeof parsed.analytics === 'boolean' && typeof parsed.ads === 'boolean') {
        stored = { analytics: parsed.analytics, ads: parsed.ads };
      }
    } catch {
      /* corrupt record = no stored choice */
    }
  }

  let region: string | null = null;
  let regionKnown = false;
  const regionRaw = read(win.sessionStorage, '_dlregion');
  if (regionRaw === '--') {
    regionKnown = true; // the oracle answered "no country" this session
  } else if (regionRaw && /^[A-Z]{2}$/.test(regionRaw)) {
    region = regionRaw;
    regionKnown = true;
  }

  // The Intl timezone heuristic — consulted ONLY where the posture would
  // otherwise RELEASE on an unknown region (us-first). It can keep scripts
  // held; it can never release them.
  const timezoneHold = (): boolean => {
    try {
      const timeZone = (win.Intl && win.Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
      return timeZone.indexOf('Europe/') === 0;
    } catch {
      return false;
    }
  };

  const restricted = (): boolean => {
    if (posture === 'consent-first') return true; // everything waits for grant
    if (!regionKnown) return posture === 'us-first' ? timezoneHold() : true; // unknown = restricted
    if (region === null) return posture !== 'us-first'; // oracle answered, country unknown
    return regions.indexOf(region) !== -1;
  };

  const adsAllowed = (): boolean => {
    if (gpc) return false; // GPC beats grant, everywhere
    if (stored) return stored.ads === true; // an explicit choice is honored in every region
    return !restricted();
  };
  const idUpgradeAllowed = (): boolean => {
    if (gpc) return false;
    if (analyticsIdMode === 'granted-only') return !!stored && stored.analytics === true;
    return stored ? stored.analytics === true : regionKnown && !restricted();
  };
  const bannerNeeded = (): boolean => {
    if (stored || gpc) return false; // a choice exists / GPC already decided
    if (posture === 'consent-first') return true;
    // geo-adaptive / us-first: only once the region is CONFIRMED restricted
    // (an unknown region holds pixels silently — no banner flash for
    // visitors who turn out to be unrestricted).
    if (!regionKnown) return false;
    return region === null ? posture !== 'us-first' : regions.indexOf(region) !== -1;
  };

  // ── Consent Mode v2 ────────────────────────────────────────────────────────
  let defaultsSet = false;
  // gtag.js interprets CONSENT commands only from `arguments` objects — a
  // plain array push is silently ignored, so this must stay a `function`.
  const gtag: (...args: unknown[]) => void = function (): void {
    // eslint-disable-next-line prefer-rest-params
    (win.dataLayer = win.dataLayer || []).push(arguments);
  };
  const setConsentModeDefaults = (): void => {
    if (defaultsSet) return;
    defaultsSet = true;
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
      wait_for_update: 500,
    });
    gtag('set', 'ads_data_redaction', true);
    gtag('set', 'url_passthrough', true);
  };
  const pushConsentUpdate = (): void => {
    if (!defaultsSet) return; // tags ran ungated — nothing listens for an update
    const ads = adsAllowed();
    gtag('consent', 'update', {
      ad_storage: ads ? 'granted' : 'denied',
      ad_user_data: ads ? 'granted' : 'denied',
      // Personalization needs a certified TCF CMP in EEA/UK — permanently denied here.
      ad_personalization: 'denied',
      analytics_storage: idUpgradeAllowed() ? 'granted' : 'denied',
    });
  };

  // ── gated-script activation (idempotent: activated scripts leave the query) ─
  const activateGated = (): void => {
    const gated = doc.querySelectorAll('script[type="text/plain"][data-trk-gate]');
    for (let index = 0; index < gated.length; index += 1) {
      const gatedScript = gated[index]!;
      const live = doc.createElement('script');
      const attributes = gatedScript.attributes;
      for (let attrIndex = 0; attrIndex < attributes.length; attrIndex += 1) {
        const attribute = attributes[attrIndex]!;
        if (attribute.name !== 'type' && attribute.name !== 'data-trk-gate') {
          live.setAttribute(attribute.name, attribute.value);
        }
      }
      live.text = gatedScript.text;
      gatedScript.replaceWith(live);
    }
  };

  // ── banner plumbing (markup is ConsentBanner.astro's — code-owned) ─────────
  const bannerElement = (): ConsentElementLike | null => doc.getElementById('trk-consent-banner');
  const panelElement = (): ConsentElementLike | null => {
    const banner = bannerElement();
    return banner ? banner.querySelector('[data-trk-consent-panel]') : null;
  };
  const showBanner = (): void => {
    const banner = bannerElement();
    if (banner) banner.hidden = false;
  };
  const hideBanner = (): void => {
    const banner = bannerElement();
    if (banner) banner.hidden = true;
    const panel = panelElement();
    if (panel) panel.hidden = true;
  };

  // ── state exposure + the trk:consent signal ────────────────────────────────
  const trk: Record<string, unknown> = (win.__trk = win.__trk || {});
  const sync = (): void => {
    trk.consent = {
      posture,
      region,
      regionKnown,
      gpc,
      ads: adsAllowed(),
      analytics: idUpgradeAllowed(),
    };
  };
  const dispatch = (): void => {
    sync();
    try {
      doc.dispatchEvent(
        new win.CustomEvent('trk:consent', {
          detail: { analytics: idUpgradeAllowed(), ads: adsAllowed(), gpc },
        })
      );
    } catch {
      /* a CustomEvent-less environment just misses the signal */
    }
  };

  const settle = (): void => {
    if (adsAllowed()) {
      pushConsentUpdate();
      activateGated();
    } else if (bannerNeeded()) {
      showBanner();
    }
  };

  const apply = (analytics: boolean, ads: boolean): void => {
    stored = { analytics, ads };
    write(win.localStorage, '_dlconsent', JSON.stringify({ analytics, ads, ts: win.Date.now(), region }));
    pushConsentUpdate();
    if (adsAllowed()) activateGated();
    hideBanner();
    dispatch();
  };

  trk.grant = (): void => apply(true, true);
  trk.reject = (): void => apply(false, false);
  trk.openConsent = (): void => showBanner();

  doc.addEventListener('click', (event: ConsentEventLike): void => {
    const target = event.target;
    if (!target || !target.closest) return;
    // The re-open affordance: any link ending #privacy-choices (an ordinary
    // footer navigation-object edit — zero code) opens the banner.
    const privacyLink = target.closest('a[href$="#privacy-choices"]');
    if (privacyLink) {
      if (event.preventDefault) event.preventDefault();
      showBanner();
      return;
    }
    const control = target.closest('[data-trk-consent]');
    if (!control) return;
    const action = control.getAttribute('data-trk-consent');
    if (action === 'accept') {
      apply(true, true);
    } else if (action === 'reject') {
      apply(false, false);
    } else if (action === 'manage') {
      const panel = panelElement();
      if (panel) panel.hidden = !panel.hidden;
    } else if (action === 'save') {
      let analytics = false;
      let ads = false;
      const options = doc.querySelectorAll('[data-trk-consent-opt]');
      for (let index = 0; index < options.length; index += 1) {
        const option = options[index]!;
        const key = option.getAttribute('data-trk-consent-opt');
        if (key === 'analytics') analytics = option.checked === true;
        if (key === 'ads') ads = option.checked === true;
      }
      apply(analytics, ads);
    }
  });

  // ── region oracle (once per session; failure keeps the hold) ───────────────
  const resolveRegion = (): void => {
    if (regionKnown || !win.fetch) return;
    const ingest = typeof config.ingest_path === 'string' ? config.ingest_path : '/api/t';
    win
      .fetch(ingest + '?mode=region', { credentials: 'omit' })
      .then((response) => response.json())
      .then((data) => {
        const country = (data as { country?: unknown } | null)?.country;
        region = typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null;
        regionKnown = true;
        write(win.sessionStorage, '_dlregion', region === null ? '--' : region);
        settle();
        dispatch();
      })
      .catch(() => {
        /* unanswered oracle = still unknown = still held */
      });
  };

  // ── boot ───────────────────────────────────────────────────────────────────
  // Denied defaults are set SYNCHRONOUSLY, before any later vendor tag in the
  // head can execute — this script is inline and precedes every adapter head.
  if (!adsAllowed()) setConsentModeDefaults();
  sync();
  const boot = (): void => {
    settle();
    dispatch();
    resolveRegion();
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
  // View-Transition swaps replace body markup (fresh gated scripts, a fresh
  // hidden banner) without re-running this inline script — re-settle.
  doc.addEventListener('astro:page-load', settle);
};

/**
 * The inline bootstrap text TrackingScripts emits. Serialized from the very
 * function the tests execute — the page ships what was tested.
 */
export const consentBootstrapScript = (): string => `(${consentRuntime.toString()})(window);`;
