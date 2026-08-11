/**
 * Edit-mode canvas chrome assets: the CSS-in-JS style block and inline SVG
 * icon constants. Split out of ui.ts (W15-S4 sync) purely to keep that file's
 * size manageable — no behavior change; every export here is a pure string
 * constant with no closure over mount-time state.
 */
export const STYLES = `
:root{
  --dlem-accent:var(--adm-accent,var(--aw-color-primary,rgb(20 122 140)));
  --dlem-accent-ink:var(--adm-text-on-accent,#fff);
  --dlem-surface:var(--adm-surface-page,var(--aw-color-bg-page,#fff));
  --dlem-surface-2:var(--adm-surface-sunken,var(--aw-color-bg-surface,#f1f5f4));
  --dlem-text:var(--adm-text,var(--aw-color-text-default,rgb(36 41 46)));
  --dlem-heading:var(--adm-text-heading,var(--aw-color-text-heading,rgb(18 33 38)));
  --dlem-muted:var(--adm-text-muted,var(--aw-color-text-muted,rgb(58 65 73 / 76%)));
  --dlem-border:var(--adm-border,color-mix(in srgb,var(--aw-color-text-muted,rgb(58 65 73)) 24%,transparent));
  --dlem-draft:var(--adm-warning,var(--aw-color-gold,#b45309));
  --dlem-ok:var(--adm-success,var(--aw-color-accent,#15803d));
  /* --dlem-danger used to fall through --adm-danger (admin-only) straight to
     --aw-color-secondary, a site-wide brand blue — the #b91c1c red literal
     was unreachable on the public canvas (Wolf, 2026-08-10; see
     docs/design/marginalia-glass-ui-modernization.md §1). Derive danger from
     the theme's own gold blended toward rust so it stays an in-palette color
     rather than an arbitrary red. */
  --dlem-danger-fix:color-mix(in srgb,var(--aw-color-gold,#b45309) 40%,#7a2e22 60%);
  --dlem-danger:var(--dlem-danger-fix);
  --dlem-font:var(--adm-font-sans,var(--aw-font-sans,ui-sans-serif,system-ui,sans-serif));
  --dlem-font-head:var(--aw-font-heading,var(--dlem-font));
  --dlem-shadow:0 14px 40px rgba(0,0,0,.24);
  /* The sparkle stars: deliberately brighter than the rest of the toolbar so
     the AI action reads first (Wolf, 2026-07-12). Gold, lifted toward white. */
  --dlem-spark:color-mix(in srgb,var(--aw-color-gold,#e8be70) 78%,#fff);
  /* Margin rail (T17.3) — the measured proportions of the approved concept
     (docs/design/marginalia-interaction-model.md §1.1), expressed as tokens so
     the geometry has exactly one source shared by the CSS and ui.ts's layout
     math (which reads these same numbers from RAIL_* constants). */
  --dlem-rail-w:344px;
  --dlem-rail-gap:24px;
  --dlem-rail-pad:8px;
  --dlem-gutter-x:28px;
  /* The page displacement (W17 Fix 4). ui.ts writes this ONE value on
     <html> when the ladder picks the slide rung; everything that must stay in
     register with the page reads it from here — the page box itself, and
     every position:fixed element, which gets no say in the page box at all.
     0px for a visitor, always. */
  --dlem-shift:0px;
}
/* The page displacement itself. Padding, not a transform: a transform would
   make <body> the containing block for every position:fixed descendant and
   would break the site's sticky header, scroll anchoring and view
   transitions. Padding leaves the page in normal flow — full-bleed bands
   narrow from the right, centred columns re-centre in what is left, sticky
   chrome keeps sticking — which is exactly Wolf's "they can't all move the
   same way but they can move" (2026-08-11). */
body.dl-em-on{padding-right:var(--dlem-shift,0px)}
@media (prefers-reduced-motion:no-preference){body.dl-em-on{transition:padding-right .18s ease}}
/* Held for the single synchronous reflow measureNaturalColumnRight needs to
   read the UNDISPLACED column, so lifting and restoring the displacement in
   one task can never animate. */
body.dl-em-measuring{transition:none!important}
/* ── the toolbar (T17.6b) ────────────────────────────────────────────────────
   The PDF draws three floating pills at the viewport's top right — "Editing"
   "Attention N" "Release" — over the page, not a full-width strip pushing it
   down. Wolf's 2026-08-11 ruling on the brief's Q1 ("keep 'exit' visible")
   keeps "Exit" as a fourth always-visible pill rather than folding it into the
   "Editing" popover. .dl-em-bar is now just the positioning cluster: it
   carries no background, no border, no padding of its own — every visible
   surface is a .dl-em-pill (or the popover / toast hung off it). */
.dl-em-bar{position:fixed;top:10px;right:calc(10px + var(--dlem-shift,0px));z-index:99990;display:none;
  align-items:flex-start;gap:8px;font:600 12.5px/1.4 var(--dlem-font)}
/* The bar overlays the page — it never claims a box-model property on <body>
   (guarded by displacement-registration.test.ts) — and its right edge follows
   the page displacement (W17 Fix 4) the same way every other fixed edit-mode
   surface does, so it is never the one thing left behind when the page moves. */
body.dl-em-on .dl-em-bar{display:flex}
.dl-em-pill{position:relative;display:inline-flex;align-items:center;gap:6px;border:none;cursor:pointer;
  border-radius:999px;padding:7px 14px;font:inherit;color:var(--dlem-heading);
  background:color-mix(in srgb,var(--dlem-surface) 32%,transparent);
  -webkit-backdrop-filter:blur(9px) saturate(1.3);backdrop-filter:blur(9px) saturate(1.3);
  box-shadow:0 2px 12px color-mix(in srgb,var(--dlem-text) 12%,transparent);
  outline:1px solid color-mix(in srgb,var(--dlem-text) 16%,transparent);outline-offset:-1px}
.dl-em-pill:hover{outline-color:var(--dlem-accent);color:var(--dlem-accent)}
.dl-em-pill:focus-visible{outline:2px solid var(--dlem-accent);outline-offset:2px}
.dl-em-pill[aria-expanded="true"]{outline-color:var(--dlem-accent);color:var(--dlem-accent)}
.dl-em-pill.dl-em-primary{background:var(--dlem-accent);outline-color:var(--dlem-accent);color:var(--dlem-accent-ink)}
.dl-em-pill.dl-em-primary:hover{filter:brightness(1.08);color:var(--dlem-accent-ink)}
.dl-em-pill:disabled{opacity:.5;cursor:not-allowed}
.dl-em-pill .dl-em-dot{width:8px;height:8px;border-radius:50%;background:var(--dlem-accent);flex:none}
.dl-em-btn{border:1px solid var(--dlem-border);border-radius:6px;background:transparent;color:var(--dlem-text);
  padding:4px 10px;font:600 12px var(--dlem-font);cursor:pointer}
.dl-em-btn:hover{border-color:var(--dlem-accent);color:var(--dlem-accent)}
.dl-em-btn.dl-em-primary{background:var(--dlem-accent);border-color:var(--dlem-accent);color:var(--dlem-accent-ink)}
.dl-em-btn.dl-em-primary:hover{filter:brightness(1.08);color:var(--dlem-accent-ink)}
.dl-em-btn:disabled{opacity:.5;cursor:not-allowed}
.dl-em-count{display:inline-flex;min-width:17px;height:17px;align-items:center;justify-content:center;
  margin-left:2px;padding:0 5px;border-radius:9px;background:color-mix(in srgb,var(--dlem-text) 40%,transparent);
  color:var(--dlem-surface);font-size:10.5px}
.dl-em-count[hidden]{display:none}
.dl-em-count.dl-em-hot{background:var(--dlem-draft);color:#fff}
/* The "Editing" popover (T17.6b): Pending, the signed-in email and the last
   status line (Q2/Q3, built as proposed). A child of the pill so it needs no
   --dlem-shift compensation of its own — it inherits the pill's fixed
   positioning context and simply hangs off it. */
.dl-em-popover{position:absolute;top:100%;left:0;margin-top:8px;display:none;flex-direction:column;gap:2px;
  min-width:220px;padding:6px;border-radius:12px;
  background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 78%,transparent);
  -webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4);
  border:1px solid color-mix(in srgb,var(--aw-color-primary,rgb(20 122 140)) 18%,transparent);
  box-shadow:var(--dlem-shadow);color:var(--dlem-text);font:12.5px/1.5 var(--dlem-font)}
.dl-em-popover.dl-em-open{display:flex}
.dl-em-popover-row{padding:7px 9px;border-radius:8px}
.dl-em-popover-static{color:var(--dlem-muted);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dl-em-popover-btn{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:none;
  background:transparent;color:var(--dlem-text);cursor:pointer;font:600 12px var(--dlem-font);text-align:left}
.dl-em-popover-btn:hover{background:color-mix(in srgb,var(--dlem-text) 8%,transparent)}
.dl-em-popover-btn .dl-em-count{margin-left:0}
/* The status line's toast (T17.6b, spec §9): a transient role="status"
   region under the cluster, fading after TOAST_VISIBLE_MS. Opacity only —
   never display:none — so the live region stays in the accessibility tree
   the whole time and a screen reader can announce a text change at any
   point, faded or not. A child of the bar for the same reason the popover
   is: it inherits the fixed positioning (and the shift compensation) for
   free. */
.dl-em-toast{position:absolute;top:100%;right:0;margin-top:8px;max-width:320px;padding:7px 12px;border-radius:10px;
  background:color-mix(in srgb,var(--dlem-surface) 32%,transparent);
  -webkit-backdrop-filter:blur(9px) saturate(1.3);backdrop-filter:blur(9px) saturate(1.3);
  outline:1px solid color-mix(in srgb,var(--dlem-text) 16%,transparent);outline-offset:-1px;
  color:var(--dlem-heading);font:600 11.5px var(--dlem-font);
  box-shadow:0 2px 12px color-mix(in srgb,var(--dlem-text) 12%,transparent);
  opacity:0;pointer-events:none;transition:opacity .2s ease}
.dl-em-toast.dl-em-toast-visible{opacity:1}
.dl-em-fab{position:fixed;right:calc(18px + var(--dlem-shift,0px));bottom:18px;z-index:99990;width:44px;height:44px;border-radius:50%;
  border:none;background:var(--dlem-accent);color:var(--dlem-accent-ink);font:18px var(--dlem-font);cursor:pointer;
  box-shadow:var(--dlem-shadow)}
body.dl-em-on .dl-em-fab{display:none}
body.dl-em-on [data-cms-section-id].dl-em-hot>*,body.dl-em-on [data-cms-nav-object].dl-em-hot>*{outline:2px solid color-mix(in srgb,var(--dlem-accent) 60%,transparent);outline-offset:6px;border-radius:2px}
body.dl-em-on [data-cms-section-id].dl-em-focus>*,body.dl-em-on [data-cms-nav-object].dl-em-focus>*{outline:2px solid var(--dlem-accent);outline-offset:6px}
body.dl-em-on [data-cms-section-id].dl-em-draft>*,body.dl-em-on [data-cms-nav-object].dl-em-draft>*{outline:2px dashed var(--dlem-draft);outline-offset:6px}
/* The W7 hover chip is RETIRED (T17.14a). One block shows one affordance —
   its margin bubble — so the chip element, its positioning, its decay timer
   and every rule that styled it are gone; each of its functions has a named
   home in docs/design/marginalia-affordance-model.md §3. What survives here
   is only what the BUBBLE'S DRAWER reuses: the compact select and number
   inputs of a related grid's configuration. */
/* Selection-algorithm dropdown (related grids) — a compact select. */
.dl-em-alg{appearance:none;-webkit-appearance:none;height:24px;padding:2px 18px 2px 8px;cursor:pointer;
  border:1px solid color-mix(in srgb,var(--dlem-text) 30%,transparent);border-radius:5px;
  background:color-mix(in srgb,var(--dlem-text) 8%,transparent) url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M1 1l3 3 3-3' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 6px center;
  color:var(--dlem-text);font:600 10.5px var(--dlem-font)}
.dl-em-alg:hover{border-color:var(--dlem-text)}
.dl-em-alg option{color:var(--dlem-text);background:var(--dlem-surface)}
/* Compact tile-count / columns steppers (related grids). */
.dl-em-num{width:38px;height:24px;padding:2px 2px 2px 6px;border-radius:5px;
  border:1px solid color-mix(in srgb,var(--dlem-text) 30%,transparent);
  background:color-mix(in srgb,var(--dlem-text) 8%,transparent);color:var(--dlem-text);
  font:600 10.5px var(--dlem-font)}
.dl-em-num:hover,.dl-em-num:focus{border-color:var(--dlem-text);outline:none}
.dl-em-gaplayer{position:absolute;top:0;left:0;width:100%;height:0;z-index:99989;display:none;pointer-events:none}
body.dl-em-on .dl-em-gaplayer{display:block}
.dl-em-gap{position:absolute;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;
  border:1px solid color-mix(in srgb,var(--dlem-accent) 45%,transparent);background:var(--dlem-surface);
  color:var(--dlem-accent);opacity:.45;transition:opacity .12s,transform .12s;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.dl-em-gap:hover{opacity:1;transform:translate(-50%,-50%) scale(1.15);border-color:var(--dlem-accent)}
.dl-em-pal{position:fixed;z-index:99993;min-width:230px;padding:5px;background:var(--dlem-surface);
  color:var(--dlem-text);border:1px solid var(--dlem-border);border-radius:10px;box-shadow:var(--dlem-shadow);
  font:12.5px/1.45 var(--dlem-font)}
.dl-em-pal .dl-em-palhead{padding:5px 9px 7px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dlem-muted)}
.dl-em-pal button{display:block;width:100%;text-align:left;border:none;background:transparent;color:inherit;
  padding:7px 9px;border-radius:7px;cursor:pointer;font:inherit}
.dl-em-pal button:hover{background:var(--dlem-surface-2)}
.dl-em-pal .dl-em-pallabel{font-weight:600}
.dl-em-pal .dl-em-palhint{font-size:11px;color:var(--dlem-muted)}
.dl-em-newsec-inner{border-radius:10px;margin:18px auto;max-width:720px;
  padding:18px 22px;font:12.5px/1.5 var(--dlem-font);color:var(--dlem-muted);background:var(--dlem-surface-2)}
.dl-em-newsec-inner strong{color:var(--dlem-heading);font-size:13px}
.dl-em-form{padding:12px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;
  max-height:52vh}
.dl-em-formrow{display:flex;flex-direction:column;gap:4px}
.dl-em-formrow label{font:700 10.5px ui-monospace,monospace;color:var(--dlem-muted)}
.dl-em-formrow input,.dl-em-formrow textarea{border:1px solid var(--dlem-border);border-radius:8px;
  padding:7px 9px;font:12.5px/1.5 var(--dlem-font);background:var(--dlem-surface);color:var(--dlem-text)}
.dl-em-formrow textarea{min-height:84px;resize:vertical}
.dl-em-formrow input:focus,.dl-em-formrow textarea:focus{outline:2px solid var(--dlem-accent);outline-offset:1px;border-color:transparent}
.dl-em-formrow .dl-em-fieldnote{font-size:10.5px;color:var(--dlem-muted)}
.dl-em-imgthumb{max-width:100%;max-height:140px;border-radius:8px;border:1px solid var(--dlem-border);object-fit:cover}
.dl-em-srcrow{display:flex;gap:6px;align-items:center}
.dl-em-srcrow input{flex:1;min-width:0}
.dl-em-upload{width:36px;height:36px;padding:0;flex:none}
.dl-em-upload.dl-em-loading{opacity:.5;pointer-events:none}
.dl-em-upload.dl-em-loading svg{animation:dl-em-spin .8s linear infinite}
@keyframes dl-em-spin{to{transform:rotate(360deg)}}
/* Anchored mode (desktop): the panel sits where the tile was — right rail,
   top aligned with the object it belongs to — and scrolls with the page. */
.dl-em-panel.dl-em-anchored{position:absolute;right:auto;bottom:auto}
/* A deleted region disappears in place (draft — publish makes it real). */
.dl-em-removed{display:none!important}
/* Delete confirmation modal. */
.dl-em-confirm{position:fixed;inset:0;right:var(--dlem-shift,0px);z-index:99996;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb,var(--dlem-text) 26%,transparent)}
.dl-em-confirmcard{width:340px;max-width:calc(100vw - 40px);background:var(--dlem-surface);color:var(--dlem-text);
  border:1px solid var(--dlem-border);border-radius:12px;box-shadow:var(--dlem-shadow);padding:16px 16px 12px;
  font:13px/1.5 var(--dlem-font)}
.dl-em-confirmcard p{margin:0 0 12px}
.dl-em-confirmrow{display:flex;gap:8px;justify-content:flex-end}
.dl-em-btn.dl-em-danger{background:var(--dlem-danger);border-color:var(--dlem-danger);color:#fff;
  display:inline-flex;align-items:center;gap:6px}
.dl-em-btn.dl-em-danger:hover{filter:brightness(1.06);color:#fff}
.dl-em-btn.dl-em-primary{background:var(--dlem-accent);border-color:var(--dlem-accent);color:var(--dlem-accent-ink)}
.dl-em-btn.dl-em-primary:hover{filter:brightness(1.06)}
/* Busy dots: every wait (AI round trip, record load, save) shows motion. */
.dl-em-busy{display:inline-flex;align-items:center;gap:3px;margin-right:6px;vertical-align:middle}
.dl-em-busy i{width:4px;height:4px;border-radius:50%;background:var(--dlem-accent);opacity:.25;
  animation:dl-em-pulse 1s infinite}
.dl-em-busy i:nth-child(2){animation-delay:.16s}
.dl-em-busy i:nth-child(3){animation-delay:.32s}
@keyframes dl-em-pulse{0%,80%,100%{opacity:.25}40%{opacity:1}}
.dl-em-imgrefs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dl-em-imgref{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dlem-border);border-radius:8px;
  background:transparent;color:var(--dlem-text);padding:3px 8px 3px 3px;font:600 11.5px var(--dlem-font);cursor:pointer}
.dl-em-imgref img{width:26px;height:26px;object-fit:cover;border-radius:5px}
.dl-em-imgref:hover{border-color:var(--dlem-accent);color:var(--dlem-accent)}
.dl-em-imgref.dl-em-armed{border-color:var(--dlem-accent);outline:1.5px solid var(--dlem-accent)}
.dl-em-repill{display:inline-block;background:color-mix(in srgb,var(--dlem-accent) 14%,transparent);
  border:1px solid var(--dlem-accent);color:var(--dlem-accent);border-radius:999px;padding:0 8px;
  font:700 10.5px ui-monospace,monospace}
.dl-em-formfoot{display:flex;gap:8px;padding:10px 0 2px;position:sticky;bottom:0;background:var(--dlem-surface)}
.dl-em-formfoot .dl-em-save{flex:1;background:var(--dlem-accent);border-color:var(--dlem-accent);color:var(--dlem-accent-ink)}
.dl-em-formfoot .dl-em-save:hover{filter:brightness(1.08);color:var(--dlem-accent-ink)}
.dl-em-btn:active{transform:translateY(1px)}
.dl-em-btn:focus-visible{outline:2px solid var(--dlem-accent);outline-offset:2px}
.dl-em-btn.dl-em-busybtn{pointer-events:none;opacity:.75}
.dl-em-imgphold{display:flex;align-items:center;justify-content:center;gap:6px;height:56px;margin-top:4px;
  border:1px dashed var(--dlem-border);border-radius:8px;color:var(--dlem-muted);font-size:11px}
.dl-em-imgpreview{margin:8px 0}
.dl-em-formfoot .dl-em-ghost{width:38px;padding:0;flex:none}
/* Content-sized, never viewport-pinned: the panel grows with what's in it
   (capped), instead of always spanning top bar → bottom of the screen. */
.dl-em-panel{position:fixed;top:46px;right:calc(12px + var(--dlem-shift,0px));width:372px;
  max-width:calc(100vw - 24px - var(--dlem-shift,0px));
  max-height:calc(100vh - 58px);
  z-index:99992;display:none;flex-direction:column;background:var(--dlem-surface);color:var(--dlem-text);
  border:1px solid var(--dlem-border);border-radius:14px;box-shadow:var(--dlem-shadow);font:13px/1.5 var(--dlem-font);
  overflow:hidden}
.dl-em-panel.dl-em-open{display:flex}
.dl-em-panel header{display:flex;gap:8px;align-items:center;padding:9px 8px 9px 13px;border-bottom:1px solid var(--dlem-border);
  background:var(--dlem-surface-2)}
.dl-em-ident{flex:1;min-width:0;display:flex;align-items:center;gap:7px;font:600 12px var(--dlem-font)}
.dl-em-ident .dl-em-itype{color:var(--dlem-heading);white-space:nowrap}
.dl-em-ident .dl-em-iid{font:400 10.5px ui-monospace,monospace;color:var(--dlem-muted);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dl-em-ident .dl-em-idot{width:6px;height:6px;border-radius:50%;flex:none}
.dl-em-ident .dl-em-idot.dl-em-shd{background:var(--dlem-accent)}
.dl-em-ident .dl-em-idot.dl-em-drf{background:var(--dlem-draft)}
.dl-em-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;
  border:none;background:transparent;color:var(--dlem-muted);border-radius:7px;cursor:pointer}
.dl-em-close:hover{background:color-mix(in srgb,var(--dlem-text) 10%,transparent);color:var(--dlem-text)}
/* accordion: icon-led sections, one open at a time; the open one grows */
.dl-em-accstack{flex:1;min-height:0;display:flex;flex-direction:column}
.dl-em-acc{display:flex;flex-direction:column;min-height:0;border-bottom:1px solid var(--dlem-border)}
.dl-em-acc:last-child{border-bottom:none}
.dl-em-acc.dl-em-open{flex:1;min-height:0}
.dl-em-acc-head{display:flex;align-items:center;gap:10px;width:100%;padding:11px 13px;border:none;
  background:transparent;color:var(--dlem-text);font:600 12.5px var(--dlem-font);cursor:pointer;text-align:left}
.dl-em-acc-head:hover{background:var(--dlem-surface-2)}
.dl-em-acc-head .dl-em-ic{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;
  color:var(--dlem-accent)}
.dl-em-acc-head .dl-em-lbl{flex:1;color:var(--dlem-heading)}
.dl-em-acc-head .dl-em-chev{color:var(--dlem-muted);transition:transform .16s ease}
.dl-em-acc.dl-em-open>.dl-em-acc-head{border-bottom:1px solid var(--dlem-border);background:var(--dlem-surface-2)}
.dl-em-acc.dl-em-open>.dl-em-acc-head .dl-em-chev{transform:rotate(180deg);color:var(--dlem-accent)}
.dl-em-acc-body{display:none;flex-direction:column;min-height:0;flex:1}
.dl-em-acc.dl-em-open>.dl-em-acc-body{display:flex}
.dl-em-panel:not(.dl-em-has-image) .dl-em-acc[data-em-acc="image"]{display:none}
/* The role/annotation editor applies to article blocks only. */
.dl-em-panel:not(.dl-em-article) .dl-em-acc[data-em-acc="role"]{display:none}
.dl-em-panel:not(.dl-em-article) .dl-em-acc[data-em-acc="meta"]{display:none}
.dl-em-rolefoot{display:flex;gap:8px;align-items:center}
.dl-em-form select{background:var(--dlem-surface-2);color:var(--dlem-text);border:1px solid var(--dlem-border);
  border-radius:8px;padding:7px 9px;font:12.5px var(--dlem-font)}
/* Chrome (navigation objects): copy form only — AI/Image sections don't apply. */
.dl-em-panel.dl-em-nav .dl-em-acc[data-em-acc="ai"],.dl-em-panel.dl-em-nav .dl-em-acc[data-em-acc="image"]{display:none}
.dl-em-log{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;
  min-height:72px;max-height:44vh}
.dl-em-msg{max-width:92%;padding:8px 11px;border-radius:10px;font-size:12.5px}
.dl-em-msg.dl-em-user{align-self:flex-end;background:var(--dlem-accent);color:var(--dlem-accent-ink);border-bottom-right-radius:3px}
.dl-em-msg.dl-em-ai{align-self:flex-start;background:var(--dlem-surface-2);border:1px solid var(--dlem-border);border-bottom-left-radius:3px}
.dl-em-msg.dl-em-sys{align-self:stretch;background:none;color:var(--dlem-muted);font-size:11px;text-align:center}
.dl-em-msg.dl-em-sys svg{vertical-align:-2px;margin-right:3px;opacity:.8}
.dl-em-diff{border:1px solid var(--dlem-border);border-radius:8px;padding:8px 10px;font-size:12px;margin-top:6px}
.dl-em-diff .dl-em-field{font:700 10.5px ui-monospace,monospace;margin-bottom:2px;color:var(--dlem-muted)}
.dl-em-diff del{background:color-mix(in srgb,var(--dlem-danger) 14%,transparent);color:var(--dlem-danger);text-decoration:line-through;border-radius:2px}
.dl-em-diff ins{background:color-mix(in srgb,var(--dlem-ok) 16%,transparent);color:var(--dlem-ok);text-decoration:none;border-radius:2px}
.dl-em-diff .dl-em-noprev{color:var(--dlem-draft);font-size:10.5px}
.dl-em-btn svg{display:block}
.dl-em-btn.dl-em-ico{display:inline-flex;align-items:center;justify-content:center;gap:6px}
.dl-em-actions{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--dlem-border)}
.dl-em-actions[hidden]{display:none}
.dl-em-actions .dl-em-btn{border-color:var(--dlem-accent);background:var(--dlem-accent);color:var(--dlem-accent-ink)}
.dl-em-actions .dl-em-accept{flex:1}
.dl-em-actions .dl-em-btn.dl-em-ghost{background:transparent;color:var(--dlem-text);border-color:var(--dlem-border)}
.dl-em-composer{padding:9px 12px 11px;border-top:1px solid var(--dlem-border)}
.dl-em-composer .dl-em-row{display:flex;gap:8px;align-items:flex-end}
.dl-em-composer textarea{flex:1;height:52px;resize:none;border:1px solid var(--dlem-border);border-radius:9px;
  padding:8px 10px;font:12.5px/1.45 var(--dlem-font);background:var(--dlem-surface);color:var(--dlem-text)}
.dl-em-composer textarea:focus{outline:2px solid var(--dlem-accent);outline-offset:1px;border-color:transparent}
.dl-em-composer .dl-em-send{width:40px;height:40px;flex:none;padding:0;border-radius:9px}
.dl-em-hint{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dlem-muted);margin-top:7px}
.dl-em-hint kbd{font:600 10px ui-monospace,monospace;border:1px solid var(--dlem-border);border-radius:4px;
  padding:0 4px;color:var(--dlem-text)}
/* The quiet "✓ Resolve" text action on a thread's last comment (T17.14a —
   affordance-model §2, R2). Opacity, never display:none: it must stay in the
   tab order and in the accessibility tree at all times — visually quiet is
   not the same as absent, and resolve is one of the two actions a thread
   has. It appears on hover or focus anywhere in the thread. */
.dl-em-marg-resolve{display:block;margin-top:4px;padding:0;border:none;background:transparent;cursor:pointer;
  color:var(--dlem-accent-ink);font:700 10.5px var(--dlem-font);opacity:0;transition:opacity .12s ease}
.dl-em-marg-thread:hover .dl-em-marg-resolve,.dl-em-marg-thread:focus-within .dl-em-marg-resolve{opacity:.9}
.dl-em-marg-resolve:hover,.dl-em-marg-resolve:focus-visible{opacity:1;text-decoration:underline}
.dl-em-marg-resolve:focus-visible{outline:2px solid var(--dlem-accent-ink);outline-offset:2px;border-radius:4px}
.dl-em-marg-thread{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-bottom:1px solid var(--dlem-border)}
.dl-em-marg-thread:last-child{border-bottom:none}
.dl-em-marg-thread-head{display:flex;align-items:center;gap:8px;font-size:11px}
.dl-em-marg-status{font-weight:700;text-transform:uppercase;letter-spacing:.03em;font-size:10px;color:var(--dlem-muted)}
.dl-em-marg-status-open{color:var(--dlem-accent)}
.dl-em-marg-status-resolved,.dl-em-marg-status-dismissed{color:var(--dlem-ok)}
.dl-em-marg-scope{flex:1;color:var(--dlem-muted);font:11px ui-monospace,monospace}
.dl-em-marg-toggle{padding:3px 8px;font-size:10.5px;border-radius:7px}
.dl-em-marg-comment{max-width:100%}
.dl-em-marg-comment-meta{display:flex;gap:6px;align-items:baseline;font-size:10.5px;opacity:.85;margin-bottom:2px}
.dl-em-marg-comment p{margin:0;white-space:pre-wrap}
.dl-em-marg-input{flex:1;height:44px;resize:none;border:1px solid var(--dlem-border);border-radius:9px;
  padding:8px 10px;font:12.5px/1.45 var(--dlem-font);background:var(--dlem-surface);color:var(--dlem-text)}
.dl-em-tray{position:fixed;top:44px;right:calc(12px + var(--dlem-shift,0px));width:420px;
  max-width:calc(100vw - 24px - var(--dlem-shift,0px));z-index:99992;display:none;
  flex-direction:column;background:var(--dlem-surface);color:var(--dlem-text);border:1px solid var(--dlem-border);
  border-radius:12px;box-shadow:var(--dlem-shadow);font:12.5px/1.5 var(--dlem-font)}
.dl-em-tray.dl-em-open{display:flex}
.dl-em-tray header{padding:11px 14px;font:700 13px var(--dlem-font-head);color:var(--dlem-heading);border-bottom:1px solid var(--dlem-border)}
.dl-em-tray .dl-em-rows{max-height:50vh;overflow-y:auto}
.dl-em-tray .dl-em-row2{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dlem-border)}
.dl-em-tray .dl-em-meta{flex:1;min-width:0}
.dl-em-tray .dl-em-oid{font:600 11px ui-monospace,monospace;color:var(--dlem-accent)}
.dl-em-tray .dl-em-note{font-size:11px;color:var(--dlem-muted)}
.dl-em-tray footer{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--dlem-border)}
.dl-em-tray footer .dl-em-deploy{flex:1;font-size:11px;color:var(--dlem-muted)}
.dl-em-tray .dl-em-btn.dl-em-primary{background:var(--dlem-accent);border-color:var(--dlem-accent);color:var(--dlem-accent-ink)}
/* ── margin rail (T17.3) ────────────────────────────────────────────────────
   The concept's annotation surface: block-aligned bubbles in the page margin,
   NOT a docked panel. One fixed, zero-height, pointer-transparent column whose
   left edge AND width ui.ts computes from the content column (compact mode
   narrows --dlem-rail-w to the margin the page really has, rather than moving
   the page); bubbles are absolutely positioned inside it at viewport
   coordinates and repositioned on scroll.
   Spec: docs/design/marginalia-interaction-model.md §§1–2, 8.1. */
.dl-em-rail{position:fixed;top:0;left:0;width:var(--dlem-rail-w);height:0;z-index:99991;display:none;
  pointer-events:none;font:13px/1.5 var(--dlem-font)}
body.dl-em-on .dl-em-rail.dl-em-rail-on{display:block}
.dl-em-bubble{position:absolute;left:0;width:100%;pointer-events:auto;display:flex;flex-direction:column;
  color:var(--dlem-text);border-radius:14px;overflow:visible;box-shadow:var(--dlem-shadow);
  background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 78%,transparent);
  -webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4);
  border:1px solid color-mix(in srgb,var(--aw-color-primary,rgb(20 122 140)) 18%,transparent)}
.dl-em-bubble.dl-em-pinned{border-color:color-mix(in srgb,var(--dlem-accent) 55%,transparent)}
/* ── the bubble's anatomy (T17.14a — affordance-model §2) ───────────────────
   R1 identity row · R2 thread log · R3 composer · R4 footer strip · R5 the
   block drawer. The PDF's card exactly: the agent route and "✎ edit directly"
   on one row, the conversation, the composer, then "{object} · {state}" and a
   chevron. Everything the retired hover chip carried is either a line here or
   a labelled row in R5 — deliberately NOT an icon strip, which is the
   difference between "native in the bubble" and "the chip, relocated". */
.dl-em-bubble-id{display:flex;align-items:flex-start;gap:8px;padding:8px 10px 7px 11px;border-radius:13px 13px 0 0;
  border-bottom:1px solid var(--dlem-border);
  background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 65%,transparent);
  -webkit-backdrop-filter:blur(12px) saturate(1.3);backdrop-filter:blur(12px) saturate(1.3)}
.dl-em-bubble-who{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dl-em-bubble-agent{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font:600 11.5px/1.35 var(--dlem-font);
  color:var(--dlem-heading)}
.dl-em-bubble-agent[hidden]{display:none}
.dl-em-avatar{width:20px;height:20px;flex:none;border-radius:6px;object-fit:cover}
.dl-em-avatar-initials{display:inline-flex;align-items:center;justify-content:center;
  background:var(--dlem-accent);color:var(--dlem-accent-ink);font:700 9.5px var(--dlem-font);letter-spacing:.02em}
.dl-em-agentvia{color:var(--dlem-muted);font-weight:400}
/* The block's own identity — the string the chip used to print, minus the
   monospace id, which is provenance and lives in this line's tooltip now. */
.dl-em-bubble-block{font:500 10.5px/1.4 var(--dlem-font);color:var(--dlem-muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-em-bubble-shared{margin-left:4px;color:var(--dlem-accent);font-weight:700}
/* "✎ edit directly" — a text action with a glyph and a dotted underline, per
   the PDF. Not an icon button: the pencil tool is a sentence now. */
.dl-em-editlink{flex:none;display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;
  padding:0;cursor:pointer;color:var(--dlem-muted);font:600 10.5px var(--dlem-font);
  text-decoration:underline dotted;text-underline-offset:3px}
.dl-em-editlink:hover{color:var(--dlem-accent)}
.dl-em-editlink:focus-visible{outline:2px solid var(--dlem-accent);outline-offset:2px;border-radius:4px}
.dl-em-editlink svg{display:block}
.dl-em-bubble .dl-em-log{max-height:38vh;min-height:0}
.dl-em-bubble .dl-em-log[hidden]{display:none}
.dl-em-bubble .dl-em-composer{border-top:1px solid var(--dlem-border)}
/* R4 — the footer strip: what object this is and where it stands. */
.dl-em-bubble-foot{display:flex;align-items:center;gap:7px;padding:6px 6px 6px 11px;
  border-top:1px solid var(--dlem-border);border-radius:0 0 13px 13px;
  background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 55%,transparent)}
.dl-em-foot-title{flex:1;min-width:0;font:600 11px var(--dlem-font);color:var(--dlem-heading);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-em-statepill{flex:none;padding:1px 8px;border-radius:9px;font:700 10px var(--dlem-font);white-space:nowrap}
.dl-em-statepill[hidden]{display:none}
.dl-em-statepill.dl-em-state-published{background:color-mix(in srgb,var(--dlem-ok) 18%,transparent);color:var(--dlem-ok)}
.dl-em-statepill.dl-em-state-draft{background:color-mix(in srgb,var(--dlem-draft) 18%,transparent);color:var(--dlem-draft)}
.dl-em-statepill.dl-em-state-never{background:color-mix(in srgb,var(--dlem-text) 10%,transparent);color:var(--dlem-muted)}
.dl-em-drawer-toggle{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;
  padding:0;border:none;border-radius:6px;background:transparent;color:var(--dlem-muted);cursor:pointer}
.dl-em-drawer-toggle:hover{background:color-mix(in srgb,var(--dlem-text) 10%,transparent);color:var(--dlem-text)}
.dl-em-drawer-toggle:focus-visible{outline:2px solid var(--dlem-accent);outline-offset:1px}
.dl-em-drawer-toggle .dl-em-chev{transition:transform .16s ease}
.dl-em-bubble.dl-em-drawer-open .dl-em-drawer-toggle .dl-em-chev{transform:rotate(180deg);color:var(--dlem-accent)}
.dl-em-bubble.dl-em-drawer-open .dl-em-bubble-foot{border-radius:0}
/* R5 — the block drawer. Labelled text rows with a leading glyph. */
.dl-em-drawer{display:flex;flex-direction:column;padding:4px;border-top:1px solid var(--dlem-border);
  border-radius:0 0 13px 13px;background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 45%,transparent)}
.dl-em-drawer[hidden]{display:none}
.dl-em-drawer-head{padding:6px 8px 5px;font:600 10px var(--dlem-font);letter-spacing:.04em;text-transform:uppercase;
  color:var(--dlem-muted)}
.dl-em-drawer-id{font:400 10px ui-monospace,monospace;text-transform:none;letter-spacing:0}
.dl-em-drawer-rule{height:1px;margin:4px 6px;background:var(--dlem-border)}
.dl-em-drawer-row{display:flex;align-items:center;gap:9px;width:100%;padding:7px 8px;border:none;border-radius:7px;
  background:transparent;color:var(--dlem-text);cursor:pointer;font:600 12px var(--dlem-font);text-align:left}
.dl-em-drawer-row:hover{background:color-mix(in srgb,var(--dlem-text) 8%,transparent)}
.dl-em-drawer-row:focus-visible{outline:2px solid var(--dlem-accent);outline-offset:-1px}
.dl-em-drawer-row svg{display:block;flex:none;color:var(--dlem-muted)}
.dl-em-drawer-row.dl-em-drawer-danger{color:var(--dlem-danger)}
.dl-em-drawer-row.dl-em-drawer-danger svg{color:var(--dlem-danger)}
.dl-em-drawer-row.dl-em-drawer-danger:hover{background:color-mix(in srgb,var(--dlem-danger) 12%,transparent)}
.dl-em-bubble-more{margin:0 12px 8px;padding:4px 8px;border-radius:7px;border:1px dashed var(--dlem-border);
  background:transparent;color:var(--dlem-muted);font:600 10.5px var(--dlem-font);cursor:pointer;align-self:flex-start}
.dl-em-bubble-more:hover{border-color:var(--dlem-accent);color:var(--dlem-accent)}
/* A bubble the packer pushed down draws a 1px line back to its block (§8.1). */
.dl-em-bubble-link{position:absolute;left:calc(-1 * var(--dlem-rail-gap));width:var(--dlem-rail-gap);
  border-left:1px solid color-mix(in srgb,var(--dlem-accent) 45%,transparent);
  border-bottom:1px solid color-mix(in srgb,var(--dlem-accent) 45%,transparent);
  border-bottom-left-radius:6px;pointer-events:none}
/* A hovered block with NO thread yet: the concept's 💬 affordance. */
.dl-em-ghostbubble{position:absolute;left:0;width:30px;height:30px;padding:0;pointer-events:auto;
  display:inline-flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer;
  color:var(--dlem-muted);border:1px solid var(--dlem-border);
  background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 72%,transparent);
  -webkit-backdrop-filter:blur(10px) saturate(1.2);backdrop-filter:blur(10px) saturate(1.2)}
.dl-em-ghostbubble:hover,.dl-em-ghostbubble:focus-visible{color:var(--dlem-accent);border-color:var(--dlem-accent)}
/* ── attention markers + the inline draft chip (T17.6) ──────────────────────
   One marker per block that has something to say, in the LEFT gutter at the
   block's leading edge minus --dlem-gutter-x. A block needing attention shows
   a filled dot carrying the NUMERAL — colour is never the only carrier. The
   attention token is --dlem-draft (the gold); --dlem-danger is reserved for
   destruction and must not appear here. Spec §4.2. */
.dl-em-gutter{position:fixed;top:0;left:0;width:100%;height:0;z-index:99988;display:none;pointer-events:none}
body.dl-em-on .dl-em-gutter{display:block}
.dl-em-badge{position:absolute;width:18px;height:18px;padding:0;border-radius:50%;pointer-events:auto;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;
  font:700 10.5px var(--dlem-font);line-height:1;transition:transform .12s ease}
.dl-em-badge:hover{transform:scale(1.15)}
.dl-em-badge:focus-visible{outline:2px solid var(--dlem-accent);outline-offset:2px}
.dl-em-badge.dl-em-badge-open{background:var(--dlem-draft);border-color:var(--dlem-draft);color:#fff}
.dl-em-badge.dl-em-badge-muted{width:9px;height:9px;background:transparent;
  border-color:color-mix(in srgb,var(--dlem-muted) 60%,transparent)}
.dl-em-badge.dl-em-badge-accent{width:9px;height:9px;background:var(--dlem-accent);border-color:var(--dlem-accent)}
/* The PDF's "The two-night rule · draft": drawn beside the block's title line
   rather than injected into it, so rendered copy stays byte-identical (the
   in-place preview matches on exact text). The dashed .dl-em-draft outline
   stays as well — this is an addition, not a replacement. */
.dl-em-draftchip{position:absolute;pointer-events:none;white-space:nowrap;border-radius:5px;padding:1px 6px;
  background:color-mix(in srgb,var(--dlem-draft) 16%,transparent);color:var(--dlem-draft);
  font:700 10px var(--dlem-font)}
/* List mode: every open thread on the page, one row each. Its head is the
   only survivor of the pre-fold bubble header (T17.14a replaced the block
   bubble's with the identity row above): a LIST is not a block, so it keeps a
   title and a close control. */
.dl-em-bubble-head{display:flex;align-items:center;gap:8px;padding:7px 7px 7px 12px;border-radius:13px 13px 0 0;
  border-bottom:1px solid var(--dlem-border);
  background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 65%,transparent);
  -webkit-backdrop-filter:blur(12px) saturate(1.3);backdrop-filter:blur(12px) saturate(1.3)}
.dl-em-bubble-title{flex:1;min-width:0;font:600 12px var(--dlem-font);color:var(--dlem-heading);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-em-bubble-list .dl-em-listrows{display:flex;flex-direction:column;max-height:44vh;overflow-y:auto;padding:6px}
.dl-em-listrow{display:flex;flex-direction:column;gap:2px;text-align:left;width:100%;border:none;border-radius:8px;
  background:transparent;color:var(--dlem-text);padding:7px 9px;cursor:pointer;font:inherit}
.dl-em-listrow:hover{background:color-mix(in srgb,var(--dlem-text) 8%,transparent)}
.dl-em-listrow:disabled{cursor:default;opacity:.75}
.dl-em-listwhere{font:700 10px var(--dlem-font);text-transform:uppercase;letter-spacing:.05em;color:var(--dlem-muted)}
.dl-em-listbody{font-size:12px;color:var(--dlem-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-em-listhead{padding:8px 9px 4px;font:700 10px var(--dlem-font);text-transform:uppercase;letter-spacing:.05em;
  color:var(--dlem-muted)}
/* The page displacement is declared at the top of this sheet, on
   body.dl-em-on, and gated by the slide rung of the ladder (spec §1.3).
   What made its first version unusable was not the movement — Wolf's revision
   of 2026-08-11 keeps that — but that it was decided from a rail plan that
   only fills on hover, so the page moved under the pointer. It is now a
   function of the viewport and the surface, decided on activation and resize.
   Below the slide rung the rail still adapts instead: compact writes --dlem-rail-w
   on the rail element, markers drops the rail for gutter markers plus a
   popover. */
/* Nothing is drawn against a page box that is still moving (W17 Fix 4). ui.ts
   hides the anchored overlays for the length of the glide and re-runs the whole
   re-layout pass on transitionend; this is the hide. It is deliberately
   visibility, not display: a hidden bubble keeps its measured height, so the
   packing pass that runs on settle is not measuring zero-height boxes.
   The rail, gutter, gap layer and palette are all positioned by ui.ts in
   viewport coordinates read from live boxes, so they need no --dlem-shift
   compensation of their own — only the fixed chrome above, which is pinned by
   CSS to an edge the page no longer reaches, does. */
.dl-em-settling{visibility:hidden!important}
/* ── inline editing (T17.8) ─────────────────────────────────────────────────
   Double-click a block and its copy becomes editable IN the page, in the
   block's own box: the host REPLACES the element that renders the field and
   carries its tag and classes, so the site's own typography selectors keep
   matching and nothing on the page moves (Wolf, 2026-08-11 — the never-move
   invariant). pre-wrap keeps the blank-line-is-a-new-paragraph rule article
   bodies use visible while editing.

   There is deliberately no monospace variant: the old .dl-em-inline-code
   dropped an HTML-bodied section to 12.5px mono across the full bleed the
   instant it was double-clicked. */
.dl-em-inline{white-space:pre-wrap;outline:2px solid var(--dlem-accent);outline-offset:6px;border-radius:2px;
  min-height:1.4em;caret-color:var(--dlem-accent)}
.dl-em-inline:focus,.dl-em-inline .ProseMirror:focus{outline:2px solid var(--dlem-accent);outline-offset:6px}
.dl-em-inline-rich{white-space:normal}
/* The formatting bubble (T17.8 fix 3). Wolf, 2026-08-11: "When editing
   something that can be edited on the spot, like text it need to show rich
   text tools to make simple changes expected in such scenario: bold, italic,
   bullet points and so on." It belongs AT the text, not in the rail bubble
   head, so it is anchored to the selection rect and floats over everything on
   the canvas — one notch above the rail, below the delete confirmation. Same
   glass treatment as the bubble so it reads as the same surface. */
.dl-em-fmt{position:fixed;top:0;left:0;z-index:99995;display:flex;align-items:center;gap:2px;padding:4px 5px;
  border-radius:10px;border:1px solid color-mix(in srgb,var(--dlem-text) 16%,transparent);
  background:color-mix(in srgb,var(--dlem-surface) 32%,transparent);
  -webkit-backdrop-filter:blur(9px) saturate(1.3);backdrop-filter:blur(9px) saturate(1.3);
  color:var(--dlem-heading);font:700 11.5px var(--dlem-font);
  box-shadow:0 2px 12px color-mix(in srgb,var(--dlem-text) 12%,transparent)}
.dl-em-fmt .dl-em-fmtbtn{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:24px;
  padding:0 4px;border:none;border-radius:5px;background:transparent;color:var(--dlem-text);cursor:pointer;
  font:700 11.5px var(--dlem-font)}
.dl-em-fmt .dl-em-fmtbtn:hover{background:color-mix(in srgb,var(--dlem-text) 14%,transparent);color:var(--dlem-heading)}
.dl-em-fmt .dl-em-fmtbtn:focus-visible{outline:2px solid var(--dlem-accent);outline-offset:1px}
.dl-em-fmt .dl-em-fmtbtn[aria-pressed="true"]{background:color-mix(in srgb,var(--dlem-accent) 22%,transparent);
  color:var(--dlem-heading);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dlem-accent) 55%,transparent)}
.dl-em-fmt .dl-em-fmtbtn:disabled{opacity:.4;cursor:not-allowed}
.dl-em-fmt .dl-em-fmtbtn svg{display:block}
.dl-em-fmt .dl-em-fmtsep{width:1px;height:14px;margin:0 3px;
  background:color-mix(in srgb,var(--dlem-text) 18%,transparent)}
.dl-em-fmt .dl-em-fmthint{padding:2px 6px;color:var(--dlem-muted);font:600 11px var(--dlem-font)}
.dl-em-fmt .dl-em-fmtpop{position:absolute;top:calc(100% + 6px);left:0;display:flex;gap:6px;padding:6px;
  border-radius:10px;border:1px solid var(--dlem-border);background:var(--dlem-surface);
  box-shadow:var(--dlem-shadow)}
.dl-em-fmt .dl-em-fmtpop input{width:15rem;border:1px solid var(--dlem-border);border-radius:7px;padding:5px 8px;
  font:12.5px var(--dlem-font);background:var(--dlem-surface);color:var(--dlem-text)}
.dl-em-fmt .dl-em-fmtpop input:focus{outline:2px solid var(--dlem-accent);outline-offset:1px;border-color:transparent}
/* The hover outline would double up on the block being edited. */
body.dl-em-on [data-cms-section-id].dl-em-editing>*,body.dl-em-on [data-cms-nav-object].dl-em-editing>*{outline:none}
/* Sheet mode (< 900px): no rail column — the bubbles become the bottom sheet. */
.dl-em-rail.dl-em-rail-sheet{top:auto;left:10px;right:10px;bottom:10px;width:auto;height:auto;max-height:62vh;
  overflow-y:auto;pointer-events:auto}
body.dl-em-on .dl-em-rail.dl-em-rail-sheet.dl-em-rail-on{display:flex;flex-direction:column;gap:8px}
.dl-em-rail.dl-em-rail-sheet .dl-em-bubble{position:static;width:auto}
.dl-em-rail.dl-em-rail-sheet .dl-em-ghostbubble{position:static}
.dl-em-rail.dl-em-rail-sheet .dl-em-bubble-link{display:none}
@media (max-width:900px){.dl-em-panel{top:auto;left:10px;right:10px;bottom:10px;width:auto;max-height:62vh}}
/* Glass treatment (Wolf, 2026-08-10 — docs/design/marginalia-glass-ui-modernization.md
   §2): extends the blur/tint the retired hover chip used to the rest of the
   edit-mode chrome so the whole surface reads as one glass layer instead of
   one glass surface plus several flat opaque cards. Tokens are the same
   --aw-color-* brand vars as the rest of the file, so the tint follows
   whatever theme is active. Later in source than each rule's base
   definition above, so these overrides win at equal specificity. */
.dl-em-panel{background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 78%,transparent);
  -webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4);
  border:1px solid color-mix(in srgb,var(--aw-color-primary,rgb(20 122 140)) 18%,transparent)}
.dl-em-panel header,.dl-em-acc.dl-em-open>.dl-em-acc-head{
  background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 65%,transparent);
  -webkit-backdrop-filter:blur(12px) saturate(1.3);backdrop-filter:blur(12px) saturate(1.3)}
.dl-em-confirmcard{background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 82%,transparent);
  -webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5);
  border:1px solid color-mix(in srgb,var(--dlem-danger) 25%,transparent)}
.dl-em-tray{background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 70%,transparent);
  -webkit-backdrop-filter:blur(14px) saturate(1.3);backdrop-filter:blur(14px) saturate(1.3)}
.dl-em-msg.dl-em-ai,.dl-em-diff{background:color-mix(in srgb,var(--aw-color-bg-surface,#f1f5f4) 60%,transparent);
  -webkit-backdrop-filter:blur(10px) saturate(1.2);backdrop-filter:blur(10px) saturate(1.2)}
`;

// ── inline icons ─────────────────────────────────────────────────────────────
// The sparkles' stars use --dlem-spark (a brightened site gold) so the AI
// action reads a notch brighter than the neighboring tools, which stay in the
// surface's ink color (currentColor).
export const ICON_SPARKLES =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path fill="var(--dlem-spark)" d="M12 2.8l2.1 5.6 5.6 2.1-5.6 2.1L12 18.2l-2.1-5.6-5.6-2.1 5.6-2.1z"/>' +
  '<path fill="var(--dlem-spark)" opacity=".78" d="M19.4 14.6l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"/>' +
  '<path fill="var(--dlem-spark)" opacity=".6" d="M5.2 16.8l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';
export const ICON_PENCIL =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
export const ICON_IMAGE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
export const ICON_PLUS =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
export const ICON_TRASH =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
  '<path d="M10 11v6M14 11v6"/></svg>';
export const ICON_TAG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12.6 2.9 21 11.3a2 2 0 0 1 0 2.8l-6.9 6.9a2 2 0 0 1-2.8 0L2.9 12.6A2 2 0 0 1 2.3 11V4.3a2 2 0 0 1 2-2H11a2 2 0 0 1 1.6.6Z"/>' +
  '<circle cx="7.5" cy="7.5" r="1.4"/></svg>';
export const ICON_CHEVRON =
  '<svg class="dl-em-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
export const ICON_CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
export const ICON_CLOSE =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
export const ICON_UPLOAD =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M6 10l6-6 6 6"/>' +
  '<path d="M4 20h16"/></svg>';
export const ICON_UNDO =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/>' +
  '<path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>';
export const ICON_REDO =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/>' +
  '<path d="M20 9H9a5 5 0 0 0 0 10h1"/></svg>';
// ── inline formatting toolbar (T17.8 fix 3) ──────────────────────────────────
// One icon per grammar control. Drawn to the same 24-box, 13px, currentColor
// convention as the rest of the canvas so it reads as the same surface.
export const ICON_BOLD =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7 4h6.5a4 4 0 0 1 0 8H7z"/><path d="M7 12h7.5a4 4 0 0 1 0 8H7z"/></svg>';
export const ICON_ITALIC =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M15 4h5M9 20h5M14 4 10 20"/></svg>';
export const ICON_CODE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 17-5-5 5-5M15 7l5 5-5 5"/></svg>';
export const ICON_LIST_BULLET =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/>' +
  '<circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/>' +
  '<circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>' +
  '<circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>';
export const ICON_LIST_ORDERED =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6h10M10 12h10M10 18h10"/>' +
  '<path d="M3.4 4.6 5 4v4.4M3.2 13.2a1.6 1.6 0 1 1 2.8 1L3.2 20H6"/></svg>';
export const ICON_LINK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7L11.3 6.8"/>' +
  '<path d="M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7"/></svg>';
export const ICON_SEND =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/>' +
  '<path d="M22 2 15 22l-4-9-9-4Z"/></svg>';
export const ICON_COMMENT =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg>';
