/**
 * Own-tracker loader — the BROWSER binding (W13, 12-plan §5.1). Thin by
 * design: reads `#trk-config`, wires real DOM signals into the core, and
 * owns the View-Transitions lifecycle. Mounted by T13.5's TrackingScripts
 * via an Astro `<script>` import (hashed same-origin asset). ≤4KB min+gzip
 * total (core + dom + this file) — enforced by tests/scripts'
 * loader-size test.
 *
 * Listener discipline: module-scope registration happens ONCE (this module
 * executes once per real page load); per-page observers re-bind on
 * `astro:page-load` and disconnect on `astro:before-swap` (VT navigations
 * never fire pagehide — the flush rides before-swap).
 */
import { createTracker, parseTrackerConfig, type PageContext, type Tracker } from './core.js';
import { classifyClick, trackableRefOf, type ElementLike } from './dom.js';
import { clearPersistentId, readOrMintPersistentId } from './persistent-id.js';

let tracker: Tracker | null = null;
let observer: IntersectionObserver | null = null;

// ── consent wiring (T13.6) — the runtime owns policy; the loader reacts ──────
type ConsentSnapshot = { analytics: boolean; ads: boolean; gpc: boolean };

/** The effective state the consent runtime maintains at window.__trk.consent. */
const readConsentSnapshot = (): ConsentSnapshot => {
  const trk = (window as { __trk?: { consent?: Record<string, unknown> } }).__trk;
  const state = trk?.consent;
  return {
    analytics: state?.analytics === true,
    ads: state?.ads === true,
    gpc: state?.gpc === true,
  };
};

const applyConsent = (snapshot: ConsentSnapshot): void => {
  if (!tracker) return;
  tracker.setConsent({ analytics: snapshot.analytics, ads: snapshot.ads });
  if (snapshot.analytics && !snapshot.gpc) {
    // Analytics grant, GPC off — the ONLY path that ever stores an id.
    tracker.setVisitor(readOrMintPersistentId(localStorage, Date.now(), () => crypto.randomUUID()));
  } else {
    tracker.setVisitor(null);
    clearPersistentId(localStorage); // refusal/revocation clears the device
  }
};

// Page identity is derived from the DOM the render path already stamps
// (data-cms-object-id / data-cms-node-id) — the config JSON stays static
// across pages, so the loader needs no per-page server assembly.
const TYPE_BY_PREFIX: Record<string, string> = {
  page_: 'page',
  sec_: 'section',
  req_: 'content_item',
  prod_: 'product',
};

const readPageContext = (): PageContext => {
  const first = document.querySelector('[data-cms-object-id]');
  const objectId = first?.getAttribute('data-cms-object-id') ?? null;
  const prefix = objectId ? Object.keys(TYPE_BY_PREFIX).find((candidate) => objectId.startsWith(candidate)) : undefined;
  const termId = document.querySelector('[data-cms-term-id]')?.getAttribute('data-cms-term-id') ?? undefined;
  const nodes = document.querySelectorAll('[data-cms-node-id]');
  const articleId = nodes[0]?.getAttribute('data-cms-object-id') ?? undefined;
  return {
    path: location.pathname,
    route: null,
    object: objectId && prefix ? { object_type: TYPE_BY_PREFIX[prefix], object_id: objectId } : undefined,
    term: termId ? { term_id: termId } : undefined,
    article:
      nodes.length > 0 && articleId
        ? {
            object_id: articleId,
            node_count: nodes.length,
            last_node_id: nodes[nodes.length - 1]!.getAttribute('data-cms-node-id'),
          }
        : undefined,
  };
};

const send = (path: string, body: string): void => {
  if (!(navigator.sendBeacon && navigator.sendBeacon(path, body))) {
    void fetch(path, { method: 'POST', body, keepalive: true }).catch(() => undefined);
  }
};

// T13.7: the bridge's gtag transport — a REAL `arguments` object push
// (gtag.js ignores plain-array dataLayer entries).
const gtagPush = (args: unknown[]): void => {
  const pusher = function (): void {
    const scope = window as { dataLayer?: unknown[] };
    // eslint-disable-next-line prefer-rest-params
    (scope.dataLayer = scope.dataLayer || []).push(arguments);
  };
  (pusher as (...callArgs: unknown[]) => void)(...args);
};

// T13.8: route a native-platform conversion to its queue/function. Queue
// providers (_tfa/_mgq) accept pushes before their gated script activates
// (inert if it never does); function providers (fbq/obApi) are skipped
// until their bootstrap defines them — consent gating upstream means an
// activated provider is defined by the time conversions can fire.
const nativePush = (provider: string, args: unknown[]): void => {
  const scope = window as {
    fbq?: (...callArgs: unknown[]) => void;
    obApi?: (...callArgs: unknown[]) => void;
    _tfa?: unknown[];
    _mgq?: unknown[];
  };
  if (provider === 'meta_pixel' && typeof scope.fbq === 'function') scope.fbq(...args);
  else if (provider === 'outbrain' && typeof scope.obApi === 'function') scope.obApi(...args);
  else if (provider === 'taboola') (scope._tfa = scope._tfa || []).push(args[0]);
  else if (provider === 'mgid') (scope._mgq = scope._mgq || []).push(args[0]);
};

const bindPage = (): void => {
  if (location.pathname.startsWith('/admin')) return;
  const configElement = document.getElementById('trk-config');
  if (!configElement?.textContent) return;
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(configElement.textContent);
  } catch {
    return;
  }
  const config = parseTrackerConfig(rawConfig);
  if (!tracker) {
    tracker = createTracker(config, {
      send,
      gtagPush,
      nativePush,
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      random: () => Math.random(),
      referrer: document.referrer || null,
      lang: navigator.language || null,
      viewport: () => ({ w: innerWidth, h: innerHeight }),
      gpc: (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
    });
  }
  applyConsent(readConsentSnapshot());
  tracker.pageLoad(readPageContext(), location.search);

  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const ref = trackableRefOf(entry.target as unknown as ElementLike);
        if (ref) tracker!.elementVisible(ref, entry.isIntersecting);
      }
    },
    { threshold: 0.5 }
  );
  for (const element of document.querySelectorAll('[data-cms-section-id],[data-cms-node-id]')) {
    observer.observe(element);
  }
};

const onScroll = (): void => {
  if (!tracker) return;
  const height = document.documentElement.scrollHeight;
  if (height > 0) tracker.scroll(Math.round(((scrollY + innerHeight) / height) * 100));
};

export const startTracker = (): void => {
  document.addEventListener('astro:page-load', bindPage);
  document.addEventListener('astro:before-swap', () => tracker?.pageEnd());
  addEventListener('pagehide', () => tracker?.pageEnd());
  document.addEventListener('visibilitychange', () => {
    tracker?.visibility(!document.hidden);
    if (document.hidden) tracker?.flush();
  });
  addEventListener('scroll', onScroll, { passive: true });
  const onClick = (rawEvent: Event): void => {
    if (!tracker) return;
    const target = rawEvent.target as unknown as ElementLike | null;
    if (!target?.closest) return;
    const classified = classifyClick(target, location.hostname);
    if (classified) tracker.click(classified.kind, classified.ref, classified.props, classified.extraObject);
  };
  document.addEventListener('click', onClick);
  document.addEventListener('auxclick', onClick);
  document.addEventListener('trk:goal', (rawEvent) => {
    const detail = (rawEvent as CustomEvent<{ goal?: string; value_cents?: number }>).detail;
    if (detail?.goal) tracker?.goal(detail.goal, detail.value_cents);
  });
  document.addEventListener('trk:consent', (rawEvent) => {
    const detail = (rawEvent as CustomEvent<Partial<ConsentSnapshot>>).detail;
    applyConsent({ analytics: detail?.analytics === true, ads: detail?.ads === true, gpc: detail?.gpc === true });
  });
  // T13.7: Netlify form success → the v1 goal vocabulary (the loader owns
  // this listener so the inline opt-in capture stays byte-identical and the
  // wiring exists ONLY when a tracking export mounts the loader). The same
  // submit is the §6 form_submit activity signal.
  document.addEventListener(
    'submit',
    (rawEvent) => {
      if (!tracker) return;
      const form = rawEvent.target as (ElementLike & { matches?: (selector: string) => boolean }) | null;
      if (!form?.closest || !form.matches?.('form[data-netlify="true"]')) return;
      const section = form.closest('[data-cms-section-id]');
      const sectionType = section?.getAttribute('data-cms-section-type') ?? null;
      const sectionId = section?.getAttribute('data-cms-section-id');
      tracker.click(
        'form_submit',
        sectionId ? { kind: 'section', section_id: sectionId, section_type: sectionType } : null
      );
      tracker.goal(sectionType === 'contact_form' ? 'contact_submit' : 'opt_in');
      tracker.flush(); // the form post navigates — don't leave the goal queued
    },
    { capture: true }
  );
  // The module loads after astro:page-load fired for the first page — bind now.
  if (document.readyState !== 'loading') bindPage();
};
