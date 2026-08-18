# 10 — Admin Workspace Plan (W9): the chat-first admin conversion — workspace, CMS Agents, two-tier rights, canvas ports, legacy retirement

> **Status (2026-07-23): SHIPPED.** Every wave (T9.1–T9.26) is built; T9.23's
> parity sign-off passed (2026-07-23, rows 1–10 pass/confirmed-present, OQ-W9-5
> ruled); T9.24 retired every legacy admin surface (publish/drafts/library/
> agent-admin/review/objects pages, AdminNav, the nine §6 functions,
> `/admin/blobs` → Owner-only `/admin/maintenance`) — see the T9.24/T9.25
> `state-of-play.md` entries for the run record. This doc stays the reference
> for the route map (§2), RBAC model (§8), and what retired (§6) — read it
> before touching `/admin/*`, don't assume it's still a plan.
> Commissioned by Wolf's direct request ("overhaul the admin UX/UA section …
> make this into a plan Admin section conversion"). This is the "admin area
> rethink" that two standing rulings were waiting on: _"ignore the old admin
> editor in favor of this [canvas] UX"_ (state-of-play 2026-07-13 G) and
> _"the W7.7 remainder is ON HOLD — the admin area is being rethought"_
> (07-canvas-editing.md §4). T9.19 formally lifted that hold; T9.24 then
> deleted the old admin-editor UI the hold was protecting against, closing it
> for good.
> Task briefs: `cms-pipeline/T9.1-*.md` … `T9.26-*.md`; queue rows appended
> to `cms-pipeline/queue.tsv`. Open questions for Wolf: §11 (OQ-W9-1…8; -3
> resolved same day at commissioning; -1 and -5 RESOLVED 2026-07-23 — see §11).
> Decisions already taken by Wolf at commissioning (2026-07-16, via session
> Q&A): deliverable = this plan + briefs; UI stack = React islands scoped to
> /admin; CMS Agents = in-house agent endpoint; roles = two tiers
> (Owner + Admin).
> AMENDED same day (Wolf): **both Anthropic and OpenAI are current
> providers and the provider must be settable** (resolves OQ-W9-3), and
> **objects may have DEDICATED agents** — an admin changing an object must
> always be connected to that object's agent (§4a, T9.26).

## 0. Mandate (Wolf, 2026-07-16 — GOVERNING for W9)

Wolf's framing (verbatim in intent): _"Make the admin UI consistent, logical
and user friendly. No more naked ref numbers or anything that is machine
centered. Modern and convenient widgets with common by today standards
behavior. … new pages like to collect admin information or admin
administration to assign admin rights to others. Whatever was needed earlier
like the admin publish page is not needed any longer, but all its
capabilities need to be converted to the new canvas system. Admin page needs
a good solid interface with AI agents (CMS Agents), create new reader facing
pages, create new sections templates, new page templates. … we probably need
at least two levels of admin rights. With one being able to do anything and
being able to assign rights to other users. … Humans need to avoid doing
anything other than chatting with AI (there should still be adjustable
guardrails and CMS UI. Though they should be promoted through UI as second
option with AI communication exchange being front and center for every
object. … The new system is site wide. It will not be able to create sites
but the top admins can change and create new themes, page templates, section
templates and other templates."_

Why the old pages are obsolete: they operate on the retired substrates
(JSON workflow records under `workflows/by-id/req_*.json`, GitHub-markdown
posts — both superseded by the object store), they expose machine identity
everywhere (raw `req_*` ids, monospace node badges, `JSON.stringify`'d
publish actions on `/admin/objects`), and each page re-implements its own
CSS. The canvas overlay (07-canvas-editing.md) already proved the target
interaction model on the public site; W9 brings the same standard to the
workspace behind the wall.

## 1. Vision & UX principles

1. **Chat is the front door; forms are the fallback.** Every object opens
   into a conversation with a CMS Agent that can read, propose, patch, and
   publish under the signed-in human's identity. The classic CMS form UI
   (the "Details" inspector) is always one click away, never gone — it is
   the parity floor and the trust anchor.
2. **Humans see names, never refs.** Every surface renders a display name
   derived from the object body (title/name/label, type-aware), role labels
   ("Hook · educate"), and human change phrasing ("Image added to
   Resolution"). `obj_*`/`stpl_*`/`req_*` ids appear only in tooltips and
   copy-id affordances. Raw JSON exists only inside an explicitly opened
   "Raw" tab (workspace inspector) and the Owner-only maintenance area.
   This codifies what the canvas pending tray already does.
3. **One design language.** A single admin component kit consuming the
   existing `--aw-*` design tokens. The canvas overlay keeps its vanilla
   implementation but re-points its `--dlem-*` custom properties at the
   same semantic token layer, so site-editing and workspace feel like one
   product.
4. **Guardrails are visible and adjustable; enforcement is server-side.**
   Every AI write shows an approval card unless that tool is configured
   autonomous; the guardrails page shows exactly what is autonomous and
   what asks first. Nothing in the browser is load-bearing for security —
   `publish-gate.ts`, role resolution, and the verb handlers remain the
   wall.
5. **No new write paths.** Every mutation — human form, canvas chip, or
   agent tool call — goes through `handleObjectVerb`
   (`netlify/lib/object-verbs.ts`), keeping locks, patch inverses, history
   attribution, validation, and the publish gate universal.

## 2. Information architecture — the new `/admin` route map

All pages remain static Astro shells, client-gated via `fetchAdminAuthState`
with the real wall in each function (`getAdminStateFromEvent` + roles) —
the existing pattern, unchanged. New shell: `src/layouts/AdminLayout.astro`
+ `src/components/admin-ui/AdminShell.tsx` (sidebar, topbar with user chip,
Cmd-K command palette). `src/components/admin/AdminNav.astro` retired with
the legacy pages (T9.24, 2026-07-23).

| Route | Purpose | Primary widgets | Powered by (existing → new) |
|---|---|---|---|
| `/admin` | Workspace home / attention inbox | Attention queue (pending reviews, unpublished changes, held locks); Release card with deploy status; Recent-activity feed; Quick actions | `admin-object` `inventory` (unpublished_changes) + `list`; `deploy-status`; `admin-release`; new `admin-audit` |
| `/admin/content` | Content library — browse everything by human name | Type-filtered card/table grid (title, type badge, status, readiness dot, unpublished-changes pill); Cmd-K palette | `admin-object` `inventory` + `list`; client-side search (corpus ≈ 50 objects) |
| `/admin/content/[objectId]` | **Object workspace** — chat-first single-object surface (§4) | Chat panel (center), live preview (right), collapsible Details inspector, readiness strip, publish/discard actions, history timeline, lock banner | new `admin-agent-chat`; `admin-object` verbs via existing `EditSession`/`callObjectVerb`; `admin-taxonomy`; artifact upload |
| `/admin/agents` | CMS Agents hub — cross-object conversations ("create a landing page for the retinol line") | Chat session list (human titles); new-chat starters (new article / page from template / section template / retheme); run history with outcome chips | new `admin-agent-chat` |
| `/admin/studio` | Templates & Themes studio (Owner) | Recipe gallery (tpl_/stpl_/thm_ cards showing the REQUIRED description/whenToUse/scope metadata); dry-run instantiate previews; theme cards with palette swatches + apply flow (dry-run diff → confirm) | `inventory` recipe summaries; `instantiate` / `instantiate_section` / `apply_theme` with `dry_run: true`, then the real call |
| `/admin/settings/guardrails` | Adjustable guardrails (Owner) | Approval-policy matrix (per-type autonomous vs require-approval); creation-policy matrix; chat tool autonomy table (auto/ask/off); revert-to-committed | new `admin-governance` over new `governance` blob store; committed configs shown as the labeled defaults |
| `/admin/settings/admins` | Admin administration (Owner) | Members table (avatar, name, role, status, last seen); invite dialog (email + role); role change / disable with confirm; per-member audit trail | new `admin-users` over new `users` blob store; GoTrue admin invite via `context.clientContext.identity` |
| `/admin/profile` | Admin profile (self) | Display name, avatar (artifact upload), preferences; own role read-only | `admin-users` `me`/`update_me`; `uploadImageArtifact` |
| `/admin/maintenance` | Owner-only maintenance (reskinned /admin/blobs) | Blob browser (human framing, raw JSON behind a "Raw" tab); diagnostics; wipe tools behind typed-confirmation dialogs | existing `admin-blob-manager` + `admin-blob-store-diagnostics`, now Owner-gated server-side |
| `/admin/kit` | Component gallery — every kit component in every state | — (dev/reference + visual-regression surface) |

The canvas remains the editing surface for visual work: every object card
and workspace header carries an "Edit on site" link to the object's live
URL with edit mode.

## 3. Design system

- **Add `@astrojs/react` + `react` + `react-dom`, scoped to `/admin/*`
  pages only.** The workspace is a genuinely stateful app (chat streams,
  approval cards, optimistic lock UI, command palette); hand-rolling that
  in vanilla TS at the required quality bar costs more than the framework.
  The public site and the canvas overlay stay vanilla — enforced by T9.1's
  acceptance criterion: **public build output byte-identical** after the
  integration lands. (Seam: `@astrojs/preact` + compat is a drop-in
  downsize if bundle weight ever offends.)
- **No Radix, no shadcn CLI, no cmdk.** A vendored, hand-rolled kit in
  `src/components/admin-ui/`, styled with Tailwind 3.4 + the `--aw-*`
  variables via a new semantic layer `src/assets/styles/admin-tokens.css`
  (`--adm-surface`, `--adm-accent`, `--adm-danger`, radius/spacing/type
  scale). Native `<dialog>` for modals; WAI-APG patterns for
  menu/tabs/combobox. New deps: react, react-dom, @astrojs/react — nothing
  else.
- **Component inventory:** Button, IconButton (tabler SVGs), Card,
  StatCard, Badge/StatusPill, DataTable (sortable, empty-state aware),
  Tabs, Dialog/ConfirmDialog (typed-confirm variant for danger actions),
  Drawer, DropdownMenu, CommandPalette, Toast (single provider in
  AdminShell), Skeleton, EmptyState, Breadcrumbs, Avatar, form controls
  (Input, Textarea, Select, Switch, TaxonomyPicker via `admin-taxonomy`),
  DiffView (reuses `src/lib/admin/field-diff.ts`), ReadinessList (renders
  the existing `ReadinessCriterion[]` from
  `src/lib/admin/readiness-criteria.ts` verbatim — that data is already
  UI-shaped), LockBanner, HistoryTimeline (human phrasing, reusing the
  tray's summarization approach), and chat primitives: ChatThread,
  ChatMessage, ToolCallCard, ApprovalCard, StreamingText, ChatComposer.
- **Identity module:** `src/lib/admin/display-name.ts` —
  `objectDisplayName(record)`, `verbToPhrase(historyEntry)`,
  `idTooltip(id)`. Components take display names, never ids. Unit-tested
  against all ten object types.
- **Kit gallery** at `/admin/kit` renders every component in every state —
  the visual-regression surface and the brief-writers' reference.
- **External references** (2026-07 web survey, for pattern vocabulary, not
  dependencies): assistant-ui (github.com/assistant-ui/assistant-ui) for
  chat-primitive decomposition; satnaing/shadcn-admin +
  Kiranism/next-shadcn-dashboard-starter for workspace conventions
  (collapsible sidebar, Cmd-K, data tables, skeletons); the AG-UI
  human-in-the-loop pattern (docs.ag-ui.com) for tool-call interception +
  approval cards ("autonomy on reads, approval on writes"); Sanity's
  Presentation tool as validation of canvas-first click-to-edit.

## 4. The chat-first object surface

### Layout (`/admin/content/[objectId]`)

Three zones, chat physically and visually primary:

- **Center: chat panel.** A persistent per-object conversation (chat id
  keyed `obj:<objectId>`). Composer pinned at bottom with the **readiness
  strip directly above it** (from `validate` — grouped criteria with
  complete/warning/missing chips; blockers explain themselves in human
  language). Suggested prompts seeded from the contract (`editor.useWhen`
  hints) and from missing readiness criteria ("The SEO description is
  missing — want me to draft one?").
- **Right: live preview.** Per type — page/section: iframe of the rendered
  route with a draft-overlay parameter resolving the working copy;
  content_item: client render via `src/lib/article-object/render-nodes.ts`
  (public copy only — `private` strategy never renders, same leak rule);
  theme: palette swatch board + typography specimen; product: price card +
  gate summary; navigation/taxonomy/site: structured human-readable tree.
  Re-renders on every accepted patch.
- **Bottom/collapsed: the "Details" inspector** — the classic CMS UI, one
  click to expand: field editors generated from
  `object_contract.body_schema` (bounded controls only — enums as selects,
  taxonomy via TaxonomyPicker, images via artifact upload; never free-form
  CSS/class inputs, per design-principles rule 6), each save mapping to the
  type's contract patch op through `EditSession`. Plus the History timeline
  and a read-only Raw tab (the only JSON outside maintenance).

**Header:** display name, type badge, status (draft/review/published +
unpublished-changes pill), LockBanner (holder shown by display name; Owner
sees "Take over" → force checkin, §6), actions: Publish (gated by readiness
+ the publish gate), Submit for review / Approve (M-6 pin picker for gated
types), Discard changes, Edit on site, New variant (content_item →
`create_variant`).

### 4a. Dedicated agents per object (Wolf's 2026-07-16 amendment)

Each object MAY have its own dedicated agent, and **an admin changing an
object is always connected to that object's agent** — the workspace never
hands an object's conversation to a generic bot when a dedicated one exists.

- **Agent profile** = a named configuration: `{ profile_id, name, avatar?,
  provider: 'anthropic' | 'openai', model, system_prompt, tool_autonomy_
  overrides?, status, created_by, updated_at }`. Both provider adapters are
  **v1 requirements** (not a seam) behind one interface; provider + model
  are SET on the profile — never hardcoded in the runtime.
- **Assignment + resolution**: an assignments doc maps `object_id →
  profile_id` and `object_type → profile_id`, plus a site-default profile.
  Resolution chain: object → type default → site default. Storage: new
  `agent-profiles` blob store (same house pattern as `users`), Owner-managed.
- **Binding**: every object-scoped chat (`obj:<objectId>`) resolves the
  dedicated agent at `send` time and stamps the resolved profile into the
  run record (mid-run reconfiguration never switches a live run). The chat
  UI always shows WHICH agent is speaking (name/avatar chip). The canvas
  Ask-AI routes through the same resolution (T9.26) so "change something on
  this object" means the same agent on every surface. Hub free-form chats
  use the site-default profile until the conversation adopts an object.

### What the agent can do

The chat tool registry is a curated wrapper over the verb surface, executed
server-side via `handleObjectVerb` under the **signed-in human's
Principal** (captured server-side from the verified identity at `send`
time — never client-supplied). Default autonomy per tool class (each
adjustable in guardrails, §7):

| Tool class | Tools | Default |
|---|---|---|
| Read | get_object, get_contract, list_objects, inventory, validate, search_artifacts | auto |
| Draft writes | checkout, patch (args constrained to the type's contract patch_ops schemas, incl. content_item node ops), checkin, refresh_lock | **ask** |
| Creation | create, create_variant, instantiate_template, instantiate_section_template (each runs `dry_run: true` first and shows the result in the card) | ask |
| Publication | submit_review, publish (publish_by_time), discard | ask |
| Privileged | apply_theme (dry-run first) | ask + Owner-only |

The model is prompted with the object's contract, current record summary,
readiness state, and the identity rules (refer to things by name, never
quote ids). Deep-merge patch semantics and explicit key-nulling on variant
switches are encoded in the tool descriptions, mirroring the conversion
playbook's trap table.

### Approvals in chat

When the loop reaches an ask-class tool, the run pauses and emits a
`tool_approval_required` event. The ApprovalCard renders a one-line human
summary ("Replace the hero image on **About Dr. Lurié**"), a DiffView of
proposed vs current, the dry-run result where the verb supports it, and
Approve / Edit-and-approve / Deny. Approve resumes the run server-side,
which **re-verifies the pending call against the stored run state** before
executing (the forged-entry lesson from the 2026-07-15 C session applies:
never trust client-supplied args on resume). Deny feeds a refusal
tool-result back to the model. Every executed write lands in object history
attributed to the human principal — the audit story is the existing one.

### Publish and release

Publish is a chat action and a header button; both hit the same verb and
the same server gate. After a successful publish, a release banner appears
(workspace-wide, also on `/admin` home): one click →
`releaseToProduction` (`admin-release`), then `deploy-status` polling with
the established behavior — first call usually reports
`build_not_confirmed_live`; poll, never re-fire.

## 5. Canvas ports — the /admin/publish capability checklist

The legacy page's eleven capabilities and where each lands. **Nothing
retires until this table is green — T9.23 is Wolf's sign-off drive.**

| # | Legacy capability | New home |
|---|---|---|
| 1 | Draft picker | `/admin/content` filtered to content_item + the attention inbox (drafts = unpublished_changes / no published_time) |
| 2 | Title/excerpt editing | **T9.19 (the W7.7 remainder)**: title/lede become canvas-editable document-body fields via `set_article_meta`; also in the workspace inspector |
| 3 | Metadata: author/date/category | **T9.20**: "Article settings" section in the canvas panel + workspace inspector → `set_article_meta`; category via TaxonomyPicker against `tax_drlurie` |
| 4 | Tags + SEO + path | Same T9.20 surface; slug/path edits validate against the contract; taxonomy resolved, never free-typed |
| 5 | Save with undo | `EditSession.patch` + history inverses; Discard = the undo (existing verb); the tray already phrases changes humanly |
| 6 | Per-node TipTap editing | **T9.19**: TipTap 3 in the canvas "Edit text" panel for `rich_text.v1` nodes, bound via `src/lib/richtext/prosemirror.ts`, toolbar restricted to the grammar (p, br, strong, em, https-only link, ul/ol/li, h2/h3) — nothing outside the grammar is even offered; re-validated server-side by `validateObject` |
| 7 | Per-node Ask-AI with word-diff accept/discard | Already in canvas (amber in-place preview via `admin-ask-ai-object`); T9.19 extends the copy-only diff flow to rich_text nodes |
| 8 | Lock lifecycle + force release | `EditSession` (checkout/refresh/409-retry) exists; force checkin becomes an Owner-only additive option on the `checkin` verb (§6), surfaced in LockBanner |
| 9 | Readiness strip gating publish | **T9.21**: the tray gains a ReadinessList fed by `validate` before Publish; blockers disable the button with the criterion text; the same strip lives above the workspace chat composer |
| 10 | `set_published_time` publish | Tray/workspace Publish offers "now" or an explicit timestamp → `publish_by_time`; scheduling/unpublish stay rejected per OQ-2 — the UI surfaces only what the verb allows |
| 11 | Canonical-input promotion | Legacy `req_*` workflow concept with no object-model analogue; the object equivalent is `create_variant` lineage + Discard. Proposed: retire without port — **OQ-W9-5** |

## 6. Backend additions

All new functions follow the house pattern: `getAdminStateFromEvent` →
401/403, roles resolved server-side, zod-validated request bodies, tests
under `tests/netlify/`.

| Piece | Files | Auth tier | Notes |
|---|---|---|---|
| **Chat runtime** | `netlify/functions/admin-agent-chat.ts` (verbs: create_chat / list_chats / get_chat?since_seq / send / approve_tool / deny_tool / cancel), `netlify/functions/admin-agent-chat-run-background.ts` (the loop, 15-min budget), `netlify/lib/agent/{loop,tools,provider,profiles,chat-store}.ts`; new blob stores `agent-chats` + `agent-profiles` | Admin (apply_theme tool Owner) | `send` verifies identity, captures the human Principal into the run record, **resolves the object's dedicated agent profile (object → type → site default) and stamps it into the run**, then enqueues the background run. The loop instantiates the profile's provider adapter — **Anthropic AND OpenAI are both v1 adapters behind one interface; provider/model are set on the profile, never hardcoded (Wolf 2026-07-16)** — and executes tools via `handleObjectVerb` directly. Turn events (text chunks at paragraph/tool boundaries, tool calls, approval requests) append to the chat doc; the client polls `get_chat?since_seq` (~1s while running). SSE streaming (Functions 2.0 Response streaming) is a marked upgrade seam, not v1 — polling is reliable, testable under the Node runner, and the event log doubles as persistence. Caps: max tool calls/turn, token budget, wall clock. Approval resume re-verifies the stored pending call (no client args trusted). |
| **Agent profiles & assignment** | `netlify/lib/agent/profiles.ts` (store + resolution, lands with T9.13; seeds a site-default profile per provider), roster/assignment UI + canvas Ask-AI re-point in **T9.26** | read: Admin; manage/assign: Owner | Profiles per §4a; assignments doc (`object_id → profile`, `object_type → profile`, site default). The canvas `admin-ask-ai-object` re-points through the same resolution so every change surface talks to the object's dedicated agent. |
| **Users store** | `netlify/lib/users-store.ts`, `netlify/functions/admin-users.ts` (me / update_me / list / invite / set_role / disable); new blob store `users` | me/update_me: any admin (self only); rest: Owner | Schema in §8. Invite drives the GoTrue admin API using the short-lived admin token Netlify injects at `context.clientContext.identity` — no new secrets. |
| **Roles extension** | `netlify/lib/roles.ts` gains `Role = 'owner' \| 'admin' \| 'publisher' \| 'editor'` and an async resolver consulting the users store; `ADMIN_EMAILS` members are **bootstrap Owners** (env fallback — a wiped store can never lock Wolf out); owner implies admin+publisher. Callers (`admin-object`, `admin-release`, new functions) migrate to the async resolver. | — | **Security-boundary work** (feeds `publish-gate`): Fable task, exhaustive tests — store/env precedence, disabled user loses roles, agent principals still resolve to `[]`, publish-gate behavior pinned unchanged for existing role sets. `publish-gate.ts` itself is NOT modified. |
| **Force checkin** | Additive `{ force: true }` option on the existing `checkin` verb in `netlify/lib/object-verbs.ts`, allowed only when resolved roles include `owner`; history-attributed | Owner | Bounded additive change to the verb core (OQ-W9-8). Tests: non-owner 403, owner takeover writes history, lock semantics preserved (`version` bumps, never `content_revision`). |
| **Governance overrides** | `netlify/lib/governance-store.ts`, `netlify/functions/admin-governance.ts`; new blob store `governance`, single doc `overrides.v1`: `{ approval?, creation?, chat_tools?, updated_by, updated_at, history[] }`, zod-validated with the existing config schemas | read: Admin; write: Owner | New resolver `resolveActivePolicies(store)` — store override if valid, else committed config; consumed by the verb publish/create paths and the chat tool loop. The committed files remain the defaults and the disaster fallback; the page labels "committed default" vs "runtime override" with one-click revert. **Security boundary** (decides who approves what): Fable task; **gated on OQ-W9-2** because it changes Wolf's one-file-lever governance model. |
| **Audit feed** | `netlify/lib/audit-feed.ts`, `netlify/functions/admin-audit.ts` | Admin | Read-only aggregation of recent object-history entries (via the store, no new writes) + chat run outcomes; powers the home activity widget and per-member audit views. |
| **AI publisher re-point** | `netlify/functions/run-publisher-agent.ts` re-targeted to create content_item objects via `handleObjectVerb` (create → node upserts → validate → publish under the existing gate) instead of the legacy markdown `publish-article` path | existing | Closes open W7.5. `publish-article.ts` and `admin-workflow-lock.ts` are NOT modified (off-limits); only their caller changes. ChatKit page fate = OQ-W9-1. |
| **Retirements — DONE (T9.24, 2026-07-23)** | Deleted: `admin-ask-ai-node.ts`, `get-article-for-edit.ts`, `admin-update-node.ts`, `admin-patch-workflow.ts`, `list-draft-articles.ts`, `admin-save-json-draft.ts`, `admin-get-json-draft.ts`, `admin-list-json-drafts.ts`, `toggle-article-publish.ts`, plus `create-chatkit-session.ts` (OQ-W9-1) and the orphaned `src/lib/admin/ai-suggestion.ts`. Six pages + `AdminNav.astro` + the Legacy nav group also went (see `state-of-play.md`). | — | Callers first, functions second, each with importer verification (grep + tests + full build) — see the T9.24 commits for the grep evidence. `publish-article.ts`, `admin-workflow-lock.ts`, and the `save-json-blob` MCP surface stayed untouched (off-limits / agent-facing until Wolf retires those separately; verified byte-identical via `git diff --stat`). |

## 7. Adjustable guardrails — what the settings page controls

Three layers, one page (`/admin/settings/guardrails`, Owner-write):

1. **Approval policy** (per object type: autonomous vs require-approval) —
   runtime override over `src/config/approval-policy.ts`.
2. **Creation policy** (per object type: open vs agent allowlist; humans
   always allowed) — runtime override over `src/config/creation-policy.ts`.
3. **Chat tool autonomy** (per chat tool: auto / ask / off) — the new
   knob; defaults per the §4 table.

All three resolve through `resolveActivePolicies` (committed config =
default + fallback), are displayed with their provenance, and every change
appends to the governance doc's history. Pending OQ-W9-2 — if Wolf rules
policy stays commit-only, the page ships read-only and toggles become
config PRs.

## 8. RBAC — two tiers on the existing machinery

> **SUPERSEDED (W18, 2026-08-17).** The two-tier model, the users-store
> schema below and the invite flow described here are history: membership
> is now governed by [`18-membership-plan.md`](18-membership-plan.md) §2
> (store v2 — Person / Membership / Invitation / Audit / policy, five tiers
> `owner|admin|publisher|editor|viewer`) and §6 (the permission matrix),
> with the AI/MCP surface in §7 and what shipped in §8 there. The `users`
> store name survives; the record shape here does not (`users-store.ts` is
> the v1 VIEW adapter over v2). §6's "Users store" and "Roles extension"
> rows above are likewise superseded. Kept verbatim for the record.

- **Owner** ("super-admin"): everything below + assign rights, guardrails,
  theme/template creation + `apply_theme`, maintenance/danger tools, lock
  takeover.
- **Admin**: full content work — create/edit pages, sections, articles,
  navigation, products, taxonomy; chat with agents; publish; release;
  decide reviews; instantiate recipes; edit own profile.
- `publisher`/`editor` remain server-side vocabulary (publish-gate
  consumes them unchanged); the workspace UI assigns only owner/admin.
  A visible third tier = OQ-W9-4.

Permission matrix (enforced server-side at the listed functions; the UI
merely hides):

| Action | Admin | Owner | Enforcement |
|---|---|---|---|
| Browse/read objects, previews, history | ✓ | ✓ | `admin-object` |
| Edit/create page, section, content_item, navigation, product, taxonomy | ✓ | ✓ | `admin-object` + creation policy |
| Publish / release | ✓ | ✓ | `publish-gate` (unchanged), `admin-release` |
| Review decide | ✓ | ✓ | existing `canDecideReview` |
| Chat with CMS Agents (writes under own identity) | ✓ | ✓ | `admin-agent-chat` |
| Create/edit template, section_template, theme; apply_theme | — | ✓ | creation-policy override + verb-level owner check |
| Change guardrails | view | ✓ | `admin-governance` |
| Invite admins, assign roles, disable members | — | ✓ | `admin-users` |
| Force checkin (lock takeover) | — | ✓ | `checkin{force}` |
| Maintenance: blob browser, diagnostics | — | ✓ | `admin-blob-manager` + diagnostics (gate added) |
| Wipe stores | — | ✓ + typed confirm | same |
| Edit own profile | ✓ | ✓ | `admin-users` me |

**Users store** (`users` blob store, key = normalized email):

```
{ schema_version: 1, email, user_id?, display_name, avatar_artifact?,
  role: 'owner'|'admin', status: 'invited'|'active'|'disabled',
  invited_by, created_at, updated_at, last_seen_at,
  audit: [{ at, actor_email, action, detail }] }
```

**Bootstrap:** `ADMIN_EMAILS` members are implicit Owners forever (env
fallback in the async resolver) — the store can be empty, wiped, or corrupt
and Wolf still gets in. First login of an env-listed owner seeds their
store record. **Invite flow:** Owner enters email + role → `invite` verb →
store record (`invited`) + GoTrue admin invite → user accepts the Netlify
Identity invite → first login flips `active` and stamps `user_id`.
**Audit:** every role change/disable appends to the member's audit array
and surfaces on the admins page and the home activity feed.

## 9. Phased delivery — waves and tasks

Ordering argument: design system + shell first (everything else renders
through it, low-risk, makes the overhaul visible immediately). RBAC second
(security-boundary work every later surface gates on — landing it before
surfaces multiply avoids retrofitting owner checks). Workspace *forms*
before chat (forms are the parity floor for retirement; the chat's
approval cards reuse the diff/readiness/form components). The chat spike
T9.12 deliberately depends only on T9.1 and should run as early as
scheduling allows — it de-risks the project's central premise (agent loop
+ background function + approval pause/resume on Netlify) in a throwaway
harness. Retirement is last, behind Wolf's parity sign-off.

Modes per pipeline convention: `auto` (headless-runnable), `notify` (run
interactively — Fable/security tasks), `checkpoint` (needs Wolf's OQ answer
first), `human_gate` (prepared by agent, completed by a human action).

**Model guidance (Wolf, 2026-07-16: Fable/Opus budget is not a constraint —
"use it if the result is better and significantly faster"; assignments lean
up when in doubt):**

- **Fable** — anything security-boundary (roles/T9.4, chat protocol/T9.13,
  governance/T9.15), the two hardest generative problems (the UI kit
  T9.2 — every later surface inherits its quality — and the
  contract-driven inspector generation in T9.9), the agent-runtime spike
  T9.12, and the delicate edit of the 2,500-line canvas overlay (T9.19).
  One heavy pass that lands right beats iterated fix-up sessions.
- **Opus** — substantial product UI and integration work with real design
  judgment but no security blast radius: shell/home T9.3, invites T9.5
  (fiddly GoTrue admin API), preview strategies T9.10, chat UI T9.14, hub
  T9.17, studio T9.18, canvas article settings T9.20, publisher re-point
  T9.22, and the deletion sweep T9.24 (cheap insurance on importer
  verification).
- **Sonnet** — mechanical, small, or prep-only tasks: T9.1 (config +
  proof page), T9.6, T9.8 (table/palette wiring over the kit), T9.11,
  T9.21, T9.25, and the human_gate preps (T9.7/16/23).

| Task | What | Mode / model / effort | Depends on |
|---|---|---|---|
| **W9.a Foundations** | | | |
| T9.1 | React islands, admin-scoped (+ `/admin/kit` proof page); public build byte-identical | auto / sonnet / medium | — |
| T9.2 | Admin UI kit + `--adm-*` tokens + display-name module (+ kit gallery) | auto / **fable** / high | T9.1 |
| T9.3 | AdminShell + workspace home v1 (release card, quick actions; legacy pages under a "Legacy" nav group until W9.g) | auto / **opus** / medium | T9.2 |
| **W9.b RBAC** | | | |
| T9.4 | Users store + owner role + async resolver + owner gates + force-checkin | notify / **fable** / high | T9.3 |
| T9.5 | Admins & roles page + invite flow | auto / **opus** / medium | T9.4 |
| T9.6 | Profile page | auto / sonnet / low | T9.4 |
| T9.7 | RBAC credentialed verification (deployed site, second account) | human_gate / sonnet / medium | T9.5, T9.6 |
| **W9.c Workspace core** | | | |
| T9.8 | Content library + command palette | auto / sonnet / medium | T9.3 |
| T9.9 | Object workspace v1: generated inspector, readiness, actions, history, lock (replaces `/admin/objects`) | auto / **fable** / high | T9.8 |
| T9.10 | Live preview pane (per-type strategies; leak-rule test) | auto / **opus** / medium | T9.9 |
| T9.11 | Attention inbox + audit feed | auto / sonnet / medium | T9.9 |
| **W9.d Chat** | | | |
| T9.12 | Agent-runtime spike (throwaway; loop + background fn + approval pause proven on a deployed function) | notify / **fable** / high | T9.1 |
| T9.13 | Chat endpoint productionized (full tool registry, budgets, forged-resume rejection, principal attribution; **both provider adapters + agent-profile resolution**, §4a) | notify / **fable** / xhigh | T9.12, T9.4 |
| T9.14 | Chat UI + chat-first layout flip (inspector collapses to "Details") | auto / **opus** / high | T9.13, T9.9 |
| T9.15 | Governance store + guardrails page | **checkpoint** (OQ-W9-2) / fable / high | T9.13, T9.4 |
| T9.16 | Chat credentialed run (create an article via chat end-to-end on production; flip a guardrail; verify audit) | human_gate / sonnet / medium | T9.14, T9.15 |
| **W9.e Hub & studio** | | | |
| T9.17 | CMS Agents hub (cross-object chats, create-flows with dry-run cards) | auto / **opus** / medium | T9.14 |
| T9.18 | Templates & Themes studio | auto / **opus** / medium | T9.14, T9.4 |
| T9.26 | Agent roster & assignment UI + canvas Ask-AI re-point through profiles (§4a) | auto / **opus** / medium | T9.14 |
| **W9.f Canvas ports** | | | |
| T9.19 | W7.7 remainder: document-body TipTap editing in canvas (lifts the recorded hold) | notify / **fable** / high | T9.2 |
| T9.20 | Article settings surface (canvas + inspector) | auto / **opus** / medium | T9.19 |
| T9.21 | Readiness in tray + publish options + `--dlem-*` token bridge | auto / sonnet / low | T9.19 |
| **W9.g Retirement** | | | |
| T9.22 | Re-point AI publisher at content_item (closes W7.5) | auto / **opus** / medium | T9.13 |
| T9.23 | Parity sign-off — Wolf drives the §5 checklist on the new surfaces | human_gate / sonnet / low | T9.16, T9.20, T9.21, T9.22 |
| T9.24 | Legacy deletion (pages publish/drafts/library/agent-admin/review/objects + AdminNav + §6 function list; blobs → /admin/maintenance reskin) | auto / **opus** / medium | T9.23 |
| T9.25 | Records close-out (state-of-play, CLAUDE.md pointers, queue) | auto / sonnet / low | T9.24 |

## 10. Verification strategy

- **Every task:** `npm run check` + `npm test` (new tests under
  `tests/netlify/` via `tsconfig.test.json`, plus `tests/scripts` for
  extractable plain-TS logic — display-name, tool registry, protocol,
  readiness mapping are all plain-TS testable).
- **Public-site invariance:** every UI-only task (T9.1–3, 8–11, 14, 17–18)
  carries the build-diff-EMPTY check on public output — the workspace must
  never perturb the reader site.
- **Security-boundary tasks (T9.4, T9.13, T9.15):** Fable + enumerated
  adversarial tests — role precedence and lockout-impossibility, forged
  approval-resume, disabled-member access, governance fallback,
  agent-principal isolation. Publish-gate behavior pinned by tests before
  and after the roles migration.
- **Wave exits:** T9.7 (RBAC), T9.16 (chat), T9.23 (parity) are the
  project's credentialed/human gates — per house convention, nothing
  counts as shipped without a production proof recorded in state-of-play.
- **Standing leak-rule test:** `private.*` article content never reaches
  any workspace or preview DOM beyond the authed object payload.

## 11. Open questions for Wolf (OQ-W9)

1. **OQ-W9-1 — RESOLVED (Wolf, 2026-07-23): RETIRE.** ChatKit's hosted
   `/admin/agent-admin` and `create-chatkit-session.ts` retired at T9.24 in
   favor of the in-house Agents hub (`/admin/agents`) — one chat system.
2. **OQ-W9-2 — Runtime guardrail overrides:** the guardrails page implies
   a runtime override layer over your committed one-file levers
   (`approval-policy.ts` / `creation-policy.ts`). Accept the
   override-store-with-committed-fallback design, or must policy stay
   commit-only (then the page ships read-only and toggles are config PRs)?
   Gates T9.15.
3. **OQ-W9-3 — RESOLVED (Wolf, 2026-07-16):** both Anthropic and OpenAI
   are current providers; the provider is SET per agent profile (§4a),
   never hardcoded. Both adapters are v1 requirements in T9.13; the canvas
   Ask-AI re-points through profile resolution in T9.26.
4. **OQ-W9-4 — RESOLVED / DONE (W18 T18.1 + T18.3a, 2026-08-17):**
   `publisher`, `editor` and the new `viewer` are visible, assignable tiers
   on `/admin/settings/admins` (store-backed, audited; `ROLE_EMAILS_*` env
   rows remain break-glass) — see `18-membership-plan.md` §6.
5. **OQ-W9-5 — RESOLVED (Wolf, via the T9.23 sign-off, 2026-07-23): retire
   without an object-model port.** `create_variant` lineage + Discard
   (history inverses) cover the intent; no canonical-input surface exists
   on the object substrate.
6. **OQ-W9-6 — Unpublish:** stand by OQ-2 (no unpublish in the workspace)?
   (Recommended: yes.)
7. **OQ-W9-7 — Agent attribution:** workspace chat always runs under the
   signed-in human's Principal (dodges OQ-3 per-agent credentials).
   Confirm no chat flow should ever run under the shared agent key.
8. **OQ-W9-8 — Force checkin:** Owner-only additive `checkin{force}`
   option on the verb core — acceptable as a bounded change?
