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
}
.dl-em-bar{position:fixed;top:0;left:0;right:0;z-index:99990;display:none;align-items:center;gap:10px;
  padding:6px 14px;background:var(--dlem-surface-2);color:var(--dlem-text);font:600 12.5px/1.4 var(--dlem-font);
  border-bottom:1px solid var(--dlem-border);box-shadow:0 2px 12px rgba(0,0,0,.12)}
body.dl-em-on .dl-em-bar{display:flex}
body.dl-em-on{padding-top:38px}
.dl-em-bar .dl-em-dot{width:8px;height:8px;border-radius:50%;background:var(--dlem-accent);flex:none}
.dl-em-bar .dl-em-who{color:var(--dlem-muted);font-weight:400}
.dl-em-bar .dl-em-status{flex:1;text-align:center;color:var(--dlem-muted);font-weight:400;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dl-em-btn{border:1px solid var(--dlem-border);border-radius:6px;background:transparent;color:var(--dlem-text);
  padding:4px 10px;font:600 12px var(--dlem-font);cursor:pointer}
.dl-em-btn:hover{border-color:var(--dlem-accent);color:var(--dlem-accent)}
.dl-em-btn.dl-em-primary{background:var(--dlem-accent);border-color:var(--dlem-accent);color:var(--dlem-accent-ink)}
.dl-em-btn.dl-em-primary:hover{filter:brightness(1.08);color:var(--dlem-accent-ink)}
.dl-em-btn:disabled{opacity:.5;cursor:not-allowed}
.dl-em-count{display:inline-flex;min-width:17px;height:17px;align-items:center;justify-content:center;
  margin-left:6px;padding:0 5px;border-radius:9px;background:color-mix(in srgb,var(--dlem-text) 40%,transparent);
  color:var(--dlem-surface);font-size:10.5px}
.dl-em-count.dl-em-hot{background:var(--dlem-draft);color:#fff}
.dl-em-fab{position:fixed;right:18px;bottom:18px;z-index:99990;width:44px;height:44px;border-radius:50%;
  border:none;background:var(--dlem-accent);color:var(--dlem-accent-ink);font:18px var(--dlem-font);cursor:pointer;
  box-shadow:var(--dlem-shadow)}
body.dl-em-on .dl-em-fab{display:none}
body.dl-em-on [data-cms-section-id].dl-em-hot>*,body.dl-em-on [data-cms-nav-object].dl-em-hot>*{outline:2px solid color-mix(in srgb,var(--dlem-accent) 60%,transparent);outline-offset:6px;border-radius:2px}
body.dl-em-on [data-cms-section-id].dl-em-focus>*,body.dl-em-on [data-cms-nav-object].dl-em-focus>*{outline:2px solid var(--dlem-accent);outline-offset:6px}
body.dl-em-on [data-cms-section-id].dl-em-draft>*,body.dl-em-on [data-cms-nav-object].dl-em-draft>*{outline:2px dashed var(--dlem-draft);outline-offset:6px}
.dl-em-chip{position:fixed;z-index:99994;display:none;align-items:center;gap:7px;padding:4px 6px 4px 10px;
  border-radius:9px;border:1px solid color-mix(in srgb,var(--dlem-text) 16%,transparent);
  background:color-mix(in srgb,var(--dlem-surface) 32%,transparent);
  -webkit-backdrop-filter:blur(9px) saturate(1.3);backdrop-filter:blur(9px) saturate(1.3);
  color:var(--dlem-heading);font:700 11.5px var(--dlem-font);
  box-shadow:0 2px 12px color-mix(in srgb,var(--dlem-text) 12%,transparent)}
.dl-em-chip .dl-em-id{font:400 10.5px ui-monospace,monospace;color:var(--dlem-muted)}
.dl-em-chip .dl-em-shared{background:color-mix(in srgb,var(--dlem-text) 12%,transparent);border-radius:4px;padding:1px 6px;font-size:10px;color:var(--dlem-text)}
.dl-em-chip .dl-em-draftflag{background:var(--dlem-draft);border-radius:4px;padding:1px 6px;font-size:10px;color:#fff}
.dl-em-chip .dl-em-tools{display:flex;gap:2px;margin-left:2px;padding-left:7px;
  border-left:1px solid color-mix(in srgb,var(--dlem-text) 18%,transparent)}
.dl-em-chip .dl-em-tool{display:inline-flex;align-items:center;justify-content:center;width:26px;height:24px;
  border:none;border-radius:5px;background:transparent;color:var(--dlem-text);cursor:pointer;padding:0}
.dl-em-chip .dl-em-tool:hover{background:color-mix(in srgb,var(--dlem-text) 14%,transparent);color:var(--dlem-heading)}
.dl-em-chip .dl-em-tool svg{display:block}
.dl-em-chip .dl-em-ask.dl-em-sel{background:color-mix(in srgb,var(--dlem-spark) 30%,transparent);
  box-shadow:0 0 0 1.5px var(--dlem-spark)}
/* Selection-algorithm dropdown (related grids) — a chip-native compact select. */
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
.dl-em-confirm{position:fixed;inset:0;z-index:99996;display:flex;align-items:center;justify-content:center;
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
.dl-em-panel{position:fixed;top:46px;right:12px;width:372px;max-width:calc(100vw - 24px);
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
.dl-em-tray{position:fixed;top:44px;right:12px;width:420px;max-width:calc(100vw - 24px);z-index:99992;display:none;
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
@media (max-width:720px){.dl-em-panel{top:auto;left:10px;right:10px;bottom:10px;width:auto;max-height:62vh}}
`;

// ── inline icons ─────────────────────────────────────────────────────────────
// The sparkles' stars use --dlem-spark (a brightened site gold) so the AI
// action reads a notch brighter than the neighboring tools, which stay in the
// chip's ink color (currentColor).
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
export const ICON_SEND =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/>' +
  '<path d="M22 2 15 22l-4-9-9-4Z"/></svg>';
export const ICON_COMMENT =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg>';
