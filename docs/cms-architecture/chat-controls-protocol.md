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
