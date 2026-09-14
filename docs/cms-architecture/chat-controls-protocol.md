# Chat interactive controls protocol

**Status: shipped in Platform (client parser/renderer + Platform-assembled
system prompt). Requires a CMS-Agent-side mirror before it's live for chats
running the CMS-Agent engine — see §5.**

Owner request, verbatim intent: "I want this interface to be less typing and
more clicking." When the agent offers the editor a choice between enumerable
options in an admin chat, it renders as clickable checkboxes, radio buttons,
and toggles inside the chat transcript instead of prose the editor has to
answer by typing. The editor's selections post back into the chat as a
compact brief — both the agent's instruction and the editor's own visible
record of what they picked.

## 1. Wire format

The agent opts in by emitting a fenced code block with info-string `controls`
containing one JSON object:

    ```controls
    {
      "id": "tone-choice",
      "title": "Article setup",
      "submit": "Use these settings",
      "fields": [
        {"kind": "radio",    "id": "tone",    "label": "Tone",             "options": [{"value":"warm","label":"Warm"},{"value":"clinical","label":"Clinical"}], "value": "warm"},
        {"kind": "checkbox", "id": "include", "label": "Include sections", "options": [{"value":"faq","label":"FAQ"},{"value":"cta","label":"CTA banner"}], "values": ["cta"]},
        {"kind": "toggle",   "id": "hero",    "label": "Generate hero image", "on": false}
      ]
    }
    ```

- `id` — required, a non-empty string, unique within the chat. Also becomes
  the `[controls:<id>]` receipt marker (§3).
- `title` — optional card heading.
- `submit` — optional submit-button label (defaults to "Submit").
- `fields` — required, non-empty array. Each field kind:
  - `radio` — single-select. `options: [{value, label}, …]` (required,
    non-empty), optional default `value` (must match an option or is dropped).
  - `checkbox` — multi-select. Same `options` shape, optional default
    `values: string[]` (entries that don't match an option are dropped).
  - `toggle` — on/off. Optional default `on: boolean`.
- Every field carries its own `id` and `label`.

**Validation is all-or-nothing per block.** An unrecognized `kind`, invalid
JSON, or any structurally invalid field invalidates the whole block — the
client falls back to rendering it as an ordinary fenced code block. It never
crashes and never half-renders a card. A mismatched default (e.g. a `value`
that isn't one of the field's `options`) is more forgiving: that one default
is dropped rather than failing the block, since it's a recoverable authoring
slip, not a shape violation.

At most one `controls` block per assistant message (agent-side discipline,
not client-enforced — the client will render more than one if it sees them).

## 2. Client behavior

- **Parser** — `packages/core/lib/admin/chat-controls.ts`. Pure functions:
  extract/validate `controls` blocks from assistant text
  (`splitControlsSegments`, `parseControlsJson`, `validateControlsBlock`),
  compute default answer state (`defaultControlsValues`), format the
  submission brief (`formatControlsBrief`), and derive submitted state from
  the transcript (`isControlsSubmitted`, `findControlsSubmissionText`,
  `parseControlsBrief`). Unit tests: `chat-controls.test.ts`.
- **Renderer** — `packages/core/admin/ControlsCard.tsx`, mounted from
  `ChatMessage` in `packages/core/admin/chat.tsx`. A valid block becomes a
  `Card` with a fieldset per field (native radio/checkbox inputs styled with
  the `--adm-*` token layer, a `Switch` for toggles) and a submit button.
  Keyboard accessible: `<fieldset>`/`<legend>` per group, `role="radiogroup"`
  on single-select groups, labeled inputs, and the shared `.adm-focusable`
  focus ring. Cards use `max-w-[26rem]` so they read cleanly at the
  `AgentRail` rail width (~20rem) without breaking `ChatThread`'s
  `overflow-y-auto` scroll container.
- **Submit** — composes a compact plain-text brief and sends it through the
  _existing_ user-message send path (`ChatThread`'s new `onSendControls` prop,
  wired to the same `chat.send` the composer uses in both `AgentRail.tsx` and
  `AgentsHub.tsx`), e.g.:

  ```
  Selections [controls:tone-choice] — Tone: Warm; Include sections: CTA banner; Generate hero image: off
  ```

  The `[controls:<id>]` marker is the machine-readable receipt; the rest is
  human-readable and doubles as the editor's own reference in the transcript.
  No new server API or storage schema — the protocol rides entirely in
  ordinary message text.

- **Submitted state, derived from the transcript** — a card renders read-only
  (selections shown, submit button replaced by a "Sent to the agent." line)
  when any user message _after_ it in the transcript contains its
  `[controls:<id>]` marker. That check runs against the live `events` array on
  every render, not component state, so it survives a refetch/reload with
  zero server changes — reopening the chat re-derives read-only cards from
  the same transcript. The displayed selections in the read-only state are
  parsed back out of that later message's brief text (`parseControlsBrief`),
  not out of local answer state, for the same reason. Before submission a
  card is interactive; while the send is in flight (`chat.busy`) every input
  and the submit button are disabled. Only the newest unanswered card needs
  to stay interactive per this spec; the implementation leaves older
  unanswered cards interactive too rather than special-casing which one is
  "newest" — harmless since submitting an already-answered id just adds a
  second receipt message, which still marks that block read-only afterward.

## 3. Card states (screenshots in words)

- **Interactive** — kicker "Choose options", the block's `title` (or "Choose
  options"), each field rendered live (radio pills, checkboxes, a toggle
  switch), a primary submit button reading the block's `submit` text (or
  "Submit").
- **Sending** — identical layout, every input and the button disabled/dimmed,
  button shows a spinner.
- **Read-only / submitted** — kicker "Sent to the agent", same field labels
  but each shown as static text (no inputs), the button replaced by a small
  green check row reading "Sent to the agent." No re-submit affordance.

## 4. Agent-side instruction (Platform-assembled prompt)

`buildAgentSystemPrompt` in `packages/core/server/lib/agent/loop.ts` — the
prompt Platform assembles for every admin chat run — now teaches the
protocol: prefer one `controls` block (with sensible defaults) over prose when
offering an enumerable decision, at most one block per message, keep ids
stable, and treat a `Selections [controls:…]` message as the editor's settled
decision rather than re-asking. Covered by
`packages/core/server/lib/agent/loop.test.ts`.

## 5. What must be mirrored into the CMS-Agent service

`buildAgentSystemPrompt`'s output is the `system` field on
`TurnEngineInput` (see `packages/core/server/lib/agent/engine.ts`). It is only
sent on the **`providerEngine`** path (chat mode `off` — the legacy provider
adapters). The **`cmsAgentEngine`** path (chat mode `fallback`/`required`)
deliberately does **not** send a `system` field — per the PF2 seam's own
documented constraint, CMS-Agent owns the prompt entirely once a chat runs on
that engine. That means:

- Chats currently running under `off` (the common case today) already get the
  controls-block instruction from this change, no CMS-Agent change needed.
- Chats running under `fallback`/`required` will **not** see this instruction
  until the CMS-Agent service's own system prompt is updated to teach the same
  protocol (§1–§2 above are engine-agnostic — the wire format and client
  rendering don't care which engine produced the message). Concretely,
  CMS-Agent's prompt needs an equivalent instruction to §4's: prefer a
  `controls` block for enumerable decisions, one per message, stable ids,
  treat `Selections [controls:…]` as settled.
- This is a prompt-only mirror — no wire-schema, tool, or transport change is
  needed on the CMS-Agent side. The client renders any well-formed `controls`
  block regardless of which engine produced the assistant text.
- Until that mirror lands, a `fallback`/`required` chat can still receive and
  render a `controls` block if the CMS-Agent model happens to emit one (the
  client doesn't care who authored the text), but it won't be _taught_ to
  prefer the pattern the way `off`-mode chats now are.

---

# v2 — clicking beyond a form (ASV2-W0.3)

> Added by the Agent Surface v2 wave. §1–§5 above describe v1 and are
> unchanged: a v1 block is still valid, still parses, still renders. v2 adds
> three kinds and one per-turn capability channel. The client is the only
> authority on what renders; the agent proposes.

## 6. v2 block kinds

A `controls` block is one of two shapes, and the shape is decided by its
fields:

- a **form block** — one or more `radio` / `checkbox` / `toggle` fields,
  gathered by a submit button (v1, §1–§3, unchanged);
- an **action block** — **exactly one** field of kind `actions`,
  `select_object` or `confirm`, and **no submit button**: the click IS the
  submission.

Mixing the two in one block is invalid and fails the whole block (§1's
all-or-nothing rule), because a card cannot both gather and fire. One block
per assistant message either way.

### 6.1 `actions` — a row of deterministic verbs

    ```controls
    {
      "id": "next-step",
      "title": "Ready when you are",
      "fields": [
        {
          "kind": "actions",
          "id": "next",
          "label": "What would you like to do?",
          "actions": [
            {"verb": "object_validate", "label": "Validate"},
            {"verb": "object_submit_review", "label": "Submit for review", "args": {"note": "ready"}},
            {"verb": "object_publish", "label": "Publish", "tone": "danger"}
          ]
        }
      ]
    }
    ```

- `actions` — required, non-empty, at most 6 entries.
- `verb` — required. **The id of a verb that already exists in
  `packages/core/lib/admin/quick-actions.ts`.** A block may not invent one;
  `controls` never widens the verb surface (see §6.4 and "Out of scope" in
  the wave plan: no new server verbs).
- `label` — required, the button's text.
- `args` — optional object of pre-filled parameters. Parameters the editor
  must still supply are collected by the same `executionFor(params)` path the
  action strip uses (0 params → run immediately, 1 → popover, 2+ → hand back
  to chat).
- `tone` — optional, `default` (omit) or `danger`.

Posts back: `[controls:<id>] ran <verb>` alongside the run's own
`[action:<verb>] <label> — <receipt>` trace line.

### 6.2 `select_object` — pick one of a finite set of objects

    ```controls
    {
      "id": "which-article",
      "fields": [
        {
          "kind": "select_object",
          "id": "pick",
          "label": "Which article did you mean?",
          "objects": [
            {"object_type": "content_item", "object_id": "req_evergreen_retinol_20260901_01", "title": "Retinol, by skin type", "status": "draft"}
          ]
        }
      ]
    }
    ```

- `objects` — required, non-empty, at most 12 entries. Each entry needs
  `object_type` (1..128) and `object_id` (1..256) — the wire's own bounds for
  that pair (`engine.ts` Constraint 7), so that a selection is always
  expressible as a chat binding even though this block does not create one.
  `title` is optional (falls back to the id); `status` is optional and renders
  as a pill.

Posts back: `[controls:<id>] selected <object_id>`.

**What the click does NOT do (corrected by the ASV2-W5 review, 2026-09-14).**
An earlier draft of this section said the selection "becomes the chat's
`object_type`/`object_id` pair". It does not, and it cannot: a chat's pair is
fixed when the chat doc is minted (`create_chat kind:'object'`), and
`conversationContext` in `engine.ts` reads it from that doc on every turn.
There is no rebind verb and this wave adds none. So a `select_object` click
posts an ordinary transcript message naming the chosen object and nothing
else — the conversation stays bound to whatever it was bound to, and the agent
works from the id in that message. A client that silently repointed the dock
would ALSO be wrong for a second reason: the receipt carries only
`object_id`, so the pair would have to be reconstructed from the block the
agent authored rather than from what the editor actually sent.

If repointing is ever wanted, it is a new capability (a rebind verb, or
minting a second chat for the chosen object) and needs its own ruling — not a
sentence in this section.

### 6.3 `confirm` — a two-way door

    ```controls
    {
      "id": "publish-now",
      "fields": [
        {"kind": "confirm", "id": "go", "label": "Publish this now?", "confirm_label": "Publish", "decline_label": "Not yet", "tone": "danger"}
      ]
    }
    ```

- `confirm_label` / `decline_label` — optional (default "Confirm" / "Cancel").
- `tone` — optional, `default` or `danger`.

Posts back: `[controls:<id>] confirmed` or `[controls:<id>] declined`.

A `confirm` block is a statement of intent in the transcript, **never an
authorization**: a privileged tool call still renders its own approval card
through the existing approval path. Confirming here does not approve there.

### 6.4 The offered-verb rule

A button may only name a verb the surface rendering it is currently offering.
A button naming anything else renders **disabled with the reason "not
available here"** — never hidden, matching `resolveObjectControls`'s
disabled-with-reason convention, so the editor sees that the agent offered
something the surface cannot do rather than seeing nothing at all. The
decision is `allowedAction(action, manifest)` in
`packages/core/lib/admin/chat-controls.ts`.

**Which manifest, precisely (corrected by the ASV2-W5 review, 2026-09-14).**
An earlier draft said "that turn's `ui_capabilities`". It overstates what
ships: `ui_capabilities` travels **Platform → CMS-Agent only**, and nothing
returns it to the browser, so the client never holds the object it was sent.
What the client actually gates against is a manifest it REBUILDS locally, with
the same pure builder (`buildUiCapabilities`, `lib/admin/ui-capabilities.ts`)
and the same two inputs — the focused object's `object_type` and the viewer's
roles. In practice the two agree, because both sides call one function over
one registry; but they are **two evaluations, not one value**, and they can
disagree wherever their inputs differ:

- a surface with no object in focus passes no manifest at all, and every
  action button renders disabled — even where the server, reading the chat
  doc, sent a non-empty `actions` list for that same turn;
- roles are resolved separately (`server/lib/roles.ts` for the manifest,
  `useCurrentUser()` for the gate), so a stale client session gates on stale
  roles.

Neither is a security question — §6.4 is display only, and the paragraph below
is the whole authority story. Returning the manifest to the client on the poll
would make this one value instead of two; that is a server change and was
deliberately out of scope for this wave.

Rights are enforced where they always were — in the verb itself and in
`resolveObjectControls` — not by the presence of a button.

## 7. `ui_capabilities` — what the client can render, per turn

The reason v1 needed §5's mirror at all: chats on the `cmsAgentEngine` path
get **no system prompt** from Platform, so the agent cannot be told about the
component library in a prompt Platform writes. `approval_note` was the only
per-turn channel Platform controlled. `ui_capabilities` is the second, and it
is structured rather than prose because it changes every turn with the
focused object.

Sent on `context` next to `approval_note`, on every
`client_manager.turn.v1` request (`conversationContext` in
`packages/core/server/lib/agent/engine.ts`):

    "ui_capabilities": {
      "v": 2,
      "controls": ["radio", "checkbox", "toggle", "actions", "select_object", "confirm"],
      "actions": [
        {"verb": "object_validate", "label": "Validate", "params": {}},
        {"verb": "object_submit_review", "label": "Submit for review", "params": {"note": {"type": "string", "required": false}}}
      ]
    }

- `v` — protocol version, `2`. An agent that does not recognise it ignores
  the object; the client's behaviour does not depend on the agent having read it.
- `controls` — the kinds **this client build renders**. It is a capability
  statement, not a menu: a kind absent here will fall back to a plain code
  block if the agent emits it anyway.
- `actions` — the focused object's `QUICK_ACTIONS` entries, **rights-filtered
  for the caller**, each with its parameter schema. Empty array when no object
  is in focus (a free chat) or when the caller may run none of them. This is
  the list §6.4 gates against.

Bounds (checked in `checkConverseBounds` before the request leaves Platform,
so a violation can never burn a `turn_id`): at most 24 `actions` entries, and
the serialized `ui_capabilities` object at most 4000 characters. Over either,
the field is **dropped, not truncated** — a turn with no manifest degrades to
"every button disabled", which is honest, where a truncated manifest would
silently claim a capability the surface does not have.

### 7.1 The strict-schema gate (why this cannot ship one-sided)

CMS-Agent's `conversationContextSchema`
(`src/agent/conversations/conversationContract.ts`) is `.strict()` and its
JSON-Schema twin sets `additionalProperties: false`. An unknown `context`
field is therefore **rejected** as `invalid_turn_request` — and since the
idempotency claim is written upstream of validation, a rejection **burns the
`turn_id`**. So the order is fixed and is the reverse of a prompt-only mirror:

1. CMS-Agent accepts `ui_capabilities` in the context schema (additive,
   optional) and teaches Client Manager §6's wording. Its `client_manager`
   agent `rev` moves.
2. That revision is **deployed**.
3. Platform starts sending the field, gated on the resolved agent `rev`
   (`agent_resolve` already returns `rev`) — below the minimum rev, the field
   is simply absent and every chat behaves exactly as it does today.

The gate is a capability handshake, not per-tenant operator plumbing: no
tenant needs a manual step, and a tenant pinned to an older agent rev
degrades instead of failing.
