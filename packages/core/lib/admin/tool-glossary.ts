/**
 * Plain-language glossary for every agent tool the Guardrails table shows.
 *
 * WHY THIS EXISTS: the Guardrails page used to title each row with
 * `toolLabelForName()`, whose fallback was the literal string "Tool action" —
 * so 27 of the 46 catalogued tools rendered as an identical, meaningless row
 * and the only explanation on offer was the agent-facing MCP `description`
 * (written for a model, not for the person deciding whether to allow it).
 *
 * Every entry carries three registers, used in three places:
 *   - `label`  — the row title. A verb phrase in an editor's words.
 *   - `short`  — the HOVER tooltip. One sentence, plain text, no jargon,
 *                answering "what would the agent be doing?".
 *   - `detail` — the "What this does" MODAL. Two or three sentences: what it
 *                does, what it changes, and what it cannot do. This is where
 *                consequences live, because a hover is not a place to read.
 *
 * The raw tool name, the stored values and the agent-facing description are
 * still shown, but inside the modal's Technical block — not in the row.
 *
 * COVERAGE IS A CONTRACT: `tool-glossary.test.ts` fails if any tool in the
 * served catalog (CHAT_TOOLS + the membership family) has no entry here, so a
 * new tool cannot ship a nameless row. Keys are the names the catalog serves
 * (the legacy chat names for the aliased object family), with the canonical
 * generated names carried as aliases so persisted chat history stays readable.
 */

export interface ToolGlossaryEntry {
  /** Row title — a verb phrase, never a tool name. */
  label: string;
  /** Hover tooltip — one plain sentence. */
  short: string;
  /** Modal body — what it does, what it changes, what it cannot do. */
  detail: string;
}

export const TOOL_GLOSSARY: Record<string, ToolGlossaryEntry> = {
  // ─── Looking things up (read) ────────────────────────────────────────────
  get_object: {
    label: 'Read an object',
    short: 'Opens one page, section or article and reads what it currently says.',
    detail:
      'Reads a single item — its content, its edit history, whether someone has it open, and whether it is published. Nothing is changed and nobody is notified. The agent does this before it proposes any edit, so turning it off will stop most other work as well.',
  },
  get_contract: {
    label: 'Check what an object allows',
    short: 'Looks up the rules for a kind of item: which fields exist and which changes are permitted.',
    detail:
      'Reads the rulebook for a type of item — the fields it has, the edits that are allowed on it, and whether publishing it needs approval. The agent reads this before its first edit to a type so it does not attempt something the site forbids. Read-only.',
  },
  list_objects: {
    label: 'Browse objects',
    short: 'Lists the items of one kind, with their status and version.',
    detail:
      'Returns a list of items of a single type — id, status, version and when each was published. Used to find something by browsing rather than by name. Read-only.',
  },
  inventory: {
    label: 'Browse the publication',
    short: 'Lists everything on the site with its status, and which reusable templates exist.',
    detail:
      'The site-wide catalogue: every item, whether it is locked, whether it is waiting for review, whether it has unpublished edits, and a summary of the reusable templates. The agent is instructed to check here for something it can reuse before creating anything new. Read-only.',
  },
  validate: {
    label: 'Check readiness',
    short: 'Checks an item for problems, or previews whether a proposed change would be valid.',
    detail:
      'Runs the site’s checks against an item as it stands, or against a change the agent is considering, and reports anything that would block publishing — in words that explain themselves. Nothing is saved either way. This is the safety net before publishing.',
  },
  search_artifacts: {
    label: 'Find media',
    short: 'Finds the images and PDFs already produced for a piece of work.',
    detail:
      'Lists the images and PDFs that were generated and verified for one job, so the agent can reference them from an article instead of inventing a file path. Read-only; it does not create, upload or edit media.',
  },
  list_workspace_nodes: {
    label: 'List the writing steps',
    short: 'Lists the steps an article goes through while it is being written.',
    detail:
      'Returns the steps of the article production pipeline — what each one does, how risky it is, and what it depends on. The agent reads this before starting or explaining a writing run. Read-only.',
  },
  get_workspace_run: {
    label: 'Check a writing run',
    short: 'Polls a running article job for its overall status and step states.',
    detail:
      'A short status summary of one article-writing run: whether it is running, which steps are done, and any notes from the driver. Read-only. For a real answer to “where is it up to?” the agent should prefer "See what a job is doing".',
  },
  check_workspace_run_readiness: {
    label: 'Check if a run is ready to publish',
    short: 'Asks whether a finished article has passed every pre-publish check.',
    detail:
      'Runs the publish checklist against a completed writing run — sourcing, claims, compliance, scores and verified images — and returns go or no-go with any blockers quoted verbatim. Read-only, and required before the agent may attempt to publish that run.',
  },
  list_requests: {
    label: 'List editorial jobs',
    short: 'Lists every job on the site — what is running, what stalled, and who asked for it.',
    detail:
      'The record of work: every article being written and anything else registered, with status, progress and requester. This is how the agent answers “what is running?” and “what needs me?”. Read-only — it never starts or advances a job.',
  },
  get_request: {
    label: 'Read one editorial job',
    short: 'Opens one job: its status, why it is in that state, and what it produced.',
    detail:
      'Reads a single job in full — status and the reason for it, progress through the steps, any blockers, the conversations attached to it, and the article it produced. Read-only; the agent uses it before answering about a specific job or offering to retry one.',
  },
  get_request_activity: {
    label: 'See what a job is doing',
    short: 'Shows the live step-by-step progress of a job, with timings, cost and any warnings.',
    detail:
      'The detailed view of a job in flight: every step in order, the one running right now, what each finished step produced, how long each took against its usual time, a real estimate of time remaining, the running cost, and any warnings — in editor language. Read-only; it never advances the run.',
  },

  // ─── Drafting and editing (draft) ────────────────────────────────────────
  checkout: {
    label: 'Start editing',
    short: 'Takes the edit lock on an item so only the agent can change it.',
    detail:
      'Claims exclusive editing rights on one item. While it is held, nobody else can edit that item. Nothing is changed to the item itself, and the lock is released by "Finish editing" or expires on its own.',
  },
  patch: {
    label: 'Update an object',
    short: 'Makes the actual edits to an item the agent has open.',
    detail:
      'Applies changes to an item the agent holds open — text, fields, ordering. The change is saved as a draft with a full undo history; it does not go live until it is published. Only edits the item’s own rules permit are accepted.',
  },
  checkin: {
    label: 'Finish editing',
    short: 'Releases the edit lock when the agent is done.',
    detail:
      'Hands the item back so other people and agents can edit it. Draft changes made during the session are kept; this only releases the lock.',
  },
  refresh_lock: {
    label: 'Keep editing access',
    short: 'Extends the edit lock during a long editing pass.',
    detail:
      'Keeps an item reserved while a long edit is still in progress, so the lock does not expire mid-work. Changes nothing about the item itself.',
  },

  // ─── Creating new things (creation) ──────────────────────────────────────
  create_object: {
    label: 'Create an object',
    short: 'Creates a new page, section or other item from scratch.',
    detail:
      'Mints a brand-new item. The agent is instructed to look for something reusable first. The approval card shows a validation preview before anything is written, and an invalid item is rejected without being saved. New items start unpublished. Articles are the exception — those must go through "Write a new article".',
  },
  create_variant: {
    label: 'Create a variant',
    short: 'Copies an existing article as a new draft, keeping the link to the original.',
    detail:
      'Clones an article into a fresh draft that records where it came from, for an alternate angle or a rewrite. The copy must use a different web address from the original, and starts unpublished.',
  },
  instantiate_template: {
    label: 'Create a page from a template',
    short: 'Builds a new page from one of the site’s saved page templates.',
    detail:
      'Stamps out a new page using a saved template, so it arrives with the right structure instead of being assembled by hand. The approval card shows a dry run of exactly what would be created. The new page starts unpublished.',
  },
  instantiate_section_template: {
    label: 'Create a section from a template',
    short: 'Adds a saved section — a hero, a call to action — to a page, or as a shared block.',
    detail:
      'Stamps a section from a saved recipe, either into a page the agent already has open or as a standalone block that several pages can share. Structure comes from the recipe; the content is edited afterwards. Nothing goes live until it is published.',
  },

  // ─── Publishing (publication) ────────────────────────────────────────────
  submit_review: {
    label: 'Send for review',
    short: 'Puts drafted changes in front of a human for approval.',
    detail:
      'Opens review on work the agent has drafted, for the types the site requires approval on. This asks for a decision — it does not make anything live and it cannot approve itself.',
  },
  publish: {
    label: 'Publish',
    short: 'Marks an item as published — but does not yet put it on the live site.',
    detail:
      'Commits an item as published in the store. The live site is only updated by a separate, deliberate release step, so publishing on its own costs nothing and changes nothing a visitor can see. There is no undo: an item cannot be unpublished, only edited.',
  },
  discard: {
    label: 'Discard changes',
    short: 'Undoes drafted, unpublished edits by reversing them one by one.',
    detail:
      'Rolls back specific unpublished changes by replaying their exact inverses, newest first. Published content is untouched. The agent must name the exact history entries being rejected, so this cannot silently wipe more than was intended.',
  },

  // ─── Site-wide changes (privileged) ──────────────────────────────────────
  apply_theme: {
    label: 'Apply a theme to the whole site',
    short: 'Replaces the site’s colours and fonts with a saved theme. Owner only.',
    detail:
      'Swaps the site-wide palette and typography for a saved theme, replacing the current set outright — keys the new theme does not define are cleared. This is the ONLY way the palette can change, and it requires an Owner at the moment it runs no matter what this page says. Publishing and releasing remain separate steps.',
  },
  apply_brand_imagery: {
    label: 'Apply brand imagery to the whole site',
    short: 'Replaces the site’s image style with a saved visual standard. Owner only.',
    detail:
      'Swaps the whole brand-imagery block — the house visual standard that new images are generated against — for another saved one. Replaces the block wholesale rather than merging. Requires an Owner at execution. Publishing and releasing remain separate steps.',
  },
  brand_imagery_propose: {
    label: 'Propose an image style',
    short: 'Drafts a proposed visual style for review; changes nothing on its own.',
    detail:
      'Produces a proposal for how the site’s images should look, for a human to consider. It is a suggestion only — applying it is a separate, Owner-gated action.',
  },
  run_workspace_workflow: {
    label: 'Write a new article',
    short: 'Starts the full article production run — research, draft, sourcing, compliance and scoring.',
    detail:
      'The only way a new article gets written. Starts (or advances) the production pipeline that researches, drafts and annotates the piece and produces the sourcing, claim, compliance and scoring record an article needs before it can publish. It runs in the background and can take a long time and cost money. It never publishes anything — that stays a separate human decision. Always asks first; that floor cannot be lowered.',
  },
  publish_workspace_run: {
    label: 'Publish a finished article',
    short: 'Publishes a completed article run, with your approval attached to it.',
    detail:
      'Publishes the article a writing run produced, recording the approving human as you. It is refused outright unless the readiness check has returned go, and the approval card shows you that result first. The live site still only updates on release. Always asks first; that floor cannot be lowered.',
  },
  release_workspace_run: {
    label: 'Push everything live (costs money)',
    short: 'Rebuilds the live site so published work becomes visible. Owner only, and billable.',
    detail:
      'Runs the one paid build that makes everything published so far visible to visitors. Publishing is free; this is the step that costs money, so it is worth batching. Owner only, and always asks first — that floor cannot be lowered.',
  },
  retry_request: {
    label: 'Retry a stalled job',
    short: 'Nudges a stalled or failed job back into motion from where it stopped.',
    detail:
      'Makes one bounded attempt at the step that stopped, reusing everything already completed rather than starting over. It is refused on a job that is waiting for a human decision — a gate is not a stall. It never starts a new job. Always asks first.',
  },
  archive_request: {
    label: 'Archive a finished job',
    short: 'Takes a completed job out of the active list. Nothing is deleted.',
    detail:
      'Moves a finished job out of the active view for tidiness. The record, its history and any article it produced all remain, and the archive filter still shows it. Owner or publisher only; always asks first.',
  },

  // ─── Members and roles (membership) ──────────────────────────────────────
  // Every write here needs a signed-in human and is recorded in the audit
  // trail. The 'ask' floor on the writes is built in and cannot be lowered.
  membership_contract: {
    label: 'Check the membership rules',
    short: 'Reads the rulebook for members: the five roles and who may do what.',
    detail:
      'Reads the site’s membership rules — the roles and what each one can do, who may invite whom, how long invitations last, and the minimum number of Owners. Read-only. The agent reads this before touching anything to do with people.',
  },
  member_list: {
    label: 'List members',
    short: 'Lists everyone with access to this site and their role.',
    detail:
      'Shows every member of this site: their role, whether they are invited, active or suspended, how they got access, and when they were last seen. Read-only.',
  },
  member_get: {
    label: 'Look up one member',
    short: 'Reads one person’s membership record by email address.',
    detail: 'Returns a single member’s record — role, status and how they were added. Read-only.',
  },
  member_audit: {
    label: 'Read a member’s history',
    short: 'Reads the record of every access change made to one person. Owner only.',
    detail:
      'The audit trail for one person, newest first — every invitation, role change, suspension and removal, each naming who did it and through which door. Read-only, Owner only.',
  },
  membership_policy_get: {
    label: 'Read the access policy',
    short: 'Reads the current settings for invitations, roles and Owner minimums.',
    detail:
      'Returns the effective access policy: how long invitations last, how many times one may be resent, which email domains are allowed, the default role, the minimum number of Owners, and who may invite. Read-only.',
  },
  member_export: {
    label: 'Export a member’s data',
    short: 'Produces the full data bundle for one person, for a data request. Owner only.',
    detail:
      'Assembles everything the site holds about one member — their record, memberships, invitations, their slice of the audit trail, and references to the edits they made — for a GDPR-style request. No third-party data is included. Owner only.',
  },
  member_invite: {
    label: 'Invite someone',
    short: 'Invites a new person by email and sends them the invitation. Always asks first.',
    detail:
      'Creates a pending invitation at a chosen role and asks the identity provider to email it. Owner tier, or Admin for the roles the policy allows. One pending invitation per address — an existing one must be resent rather than duplicated. The record exists even if the email could not be sent, and the result says so. Always asks first; that floor cannot be lowered.',
  },
  invitation_resend: {
    label: 'Resend an invitation',
    short: 'Sends a pending invitation again and extends its expiry. Owner only.',
    detail:
      'Re-sends the invitation email for someone who has not accepted yet, extends the expiry and issues a fresh link. Capped by policy at a set number of resends. Expired, revoked or already-accepted invitations are refused. Always asks first.',
  },
  invitation_revoke: {
    label: 'Cancel an invitation',
    short: 'Cancels a pending invitation before it is accepted. Owner only.',
    detail:
      'Withdraws an invitation that has not been accepted. The membership that never activated is marked removed and kept for the audit trail. The same address can be invited again afterwards. Always asks first.',
  },
  member_set_role: {
    label: 'Change someone’s role',
    short: 'Moves a member to a different role. Owner only, and never your own.',
    detail:
      'Changes a member’s tier between Owner, Admin, Publisher, Editor and Viewer. It is refused on yourself, on members managed outside the site, and on any change that would leave the site below its required number of Owners. Always asks first.',
  },
  member_suspend: {
    label: 'Suspend someone',
    short: 'Immediately removes a member’s access, reversibly. Owner only.',
    detail:
      'Takes away all of a person’s permissions from that moment: their app connections are revoked, any items they had open are released, and open sessions expire within the hour. Reversible with "Restore someone’s access". Cannot leave the site short of Owners. Always asks first.',
  },
  member_reinstate: {
    label: 'Restore someone’s access',
    short: 'Un-suspends a member and gives back their previous role. Owner only.',
    detail:
      'Reverses a suspension and restores the role the person held before. Someone who was fully removed cannot be reinstated this way — they must be invited again. Always asks first.',
  },
  member_remove: {
    label: 'Remove someone',
    short: 'Removes a member and, by default, deletes their login. Owner only.',
    detail:
      'Everything suspension does, plus the membership is marked removed and their login is deleted by default. Their history is kept and the record is purged after a grace period. Refused on yourself and on the last Owner. Re-inviting later creates a fresh invitation. Always asks first.',
  },
  member_purge: {
    label: 'Erase a removed member’s data',
    short: 'Permanently scrubs the personal data of an already-removed member. Owner only.',
    detail:
      'Irreversible. Erases the personal details of someone already removed — indexes and avatar gone — while keeping the audit trail and their attribution on past edits. Requires typing an exact confirmation phrase, and is refused unless the person was removed first. Always asks first.',
  },
  ownership_transfer: {
    label: 'Transfer ownership',
    short: 'Makes someone else an Owner and steps the current Owner down. Owner only.',
    detail:
      'Promotes another active member to Owner and demotes the departing Owner — by default yourself, to Admin. Both people must already be active members. Recorded in the audit trail on both sides. Always asks first.',
  },
  membership_policy_set: {
    label: 'Change the access policy',
    short: 'Changes the site-wide rules for invitations, roles and Owner minimums. Owner only.',
    detail:
      'Overrides the site’s access rules — invitation lifetime, resend cap, allowed email domains, default role, minimum Owners, who may invite, and what an Admin may grant. Unspecified fields keep their existing value. This changes the rules everything else is checked against, so it is worth reading the current policy first. Always asks first.',
  },
};

/** Canonical (generated-registry) names, so persisted chat history stays
 *  readable when it names a tool by its canonical rather than chat name. */
const CANONICAL_ALIASES: Record<string, string> = {
  object_get: 'get_object',
  object_contract: 'get_contract',
  object_list: 'list_objects',
  object_inventory: 'inventory',
  object_validate: 'validate',
  object_checkout: 'checkout',
  object_patch: 'patch',
  object_checkin: 'checkin',
  object_refresh_lock: 'refresh_lock',
  object_create: 'create_object',
  object_create_variant: 'create_variant',
  object_instantiate_template: 'instantiate_template',
  object_instantiate_section_template: 'instantiate_section_template',
  object_submit_review: 'submit_review',
  object_publish: 'publish',
  object_discard: 'discard',
  site_apply_theme: 'apply_theme',
  site_apply_brand_imagery: 'apply_brand_imagery',
  list_artifacts_for_request: 'search_artifacts',
};

/**
 * Turn an unknown tool name into something a person can at least read —
 * `check_workspace_run_readiness` → "Check workspace run readiness".
 *
 * This is the FALLBACK, not the goal: the coverage test makes sure no
 * catalogued tool reaches it. It exists so a tool that appears at runtime
 * before its copy is written degrades to a readable name instead of the old
 * anonymous "Tool action" — which was indistinguishable from every other row.
 */
export const humanizeToolName = (name: string): string => {
  const words = name.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Unnamed tool';
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The glossary entry for a tool, following canonical aliases, with a
 *  readable fallback for anything not yet written up. */
export const describeTool = (name: string): ToolGlossaryEntry => {
  const direct = TOOL_GLOSSARY[name];
  if (direct) return direct;
  const aliased = CANONICAL_ALIASES[name];
  if (aliased && TOOL_GLOSSARY[aliased]) return TOOL_GLOSSARY[aliased]!;
  const label = humanizeToolName(name);
  return {
    label,
    short: 'No plain-language description has been written for this tool yet.',
    detail:
      'This tool is wired into the agent but has no entry in the guardrails glossary yet, so only its technical description is available below.',
  };
};
