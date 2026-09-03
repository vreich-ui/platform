/**
 * OpenAI / ChatGPT export (W3.2).
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE: a Custom GPT's instructions field caps
 * at 8,000 characters, and the canonical skill renders to ~17,000. So the
 * export is a deliberate split, not a copy:
 *
 *   instructions.md   the procedure the model must not get wrong, terse
 *   knowledge/*.md    everything it can look up while working
 *
 * What stays in instructions is chosen by one test: would getting this wrong
 * break the run or put something unsafe on the site? Voice detail, the tool
 * table and the error catalog are lookups. The publish sequence, the ceiling
 * numbers, and the two rules that block a publish are not.
 */
import { createZip, type ZipEntry } from './zip.js';
import { pluginActors, type ManifestBundle, type PluginActorId } from './manifest-types.js';

/** ChatGPT's hard cap on the Custom GPT instructions field. */
export const GPT_INSTRUCTIONS_LIMIT = 8000;

/**
 * The canonical skill declares `plugin:openai-gpt`. The Agent shape needs the
 * same text declaring `plugin:openai-agent` instead.
 *
 * A substitution rather than a second render, because the bundle stores the
 * rendered skill and not the voice body it was rendered from — re-rendering
 * would mean storing the whole voice a second time. The substitution is safe
 * because it is EXACT and ASSERTED: an unchanged result, or any surviving
 * occurrence of the old actor, throws rather than shipping a bundle that
 * misattributes its own publishes.
 */
/**
 * Which actor THIS bundle's `skill_md` actually declares.
 *
 * `buildGptConfigZip` used to hardcode `plugin:openai-gpt` as the retarget
 * source. That is only true of a bundle rendered with `platform: "openai"` —
 * and the page renders `claude` by default, so the active manifest on every
 * live tenant declared `plugin:claude` and the ChatGPT download threw
 * "Actor retarget produced no change" for anyone who tried it.
 *
 * Read it off the bundle instead of assuming. `actor_id` is authoritative;
 * a bundle promoted before that field existed is inspected directly, which is
 * safe because the actor ids are a closed set and exactly one appears in a
 * rendered skill. Ambiguity or absence throws with the reason rather than
 * silently picking one.
 */
export const sourceActorFor = (bundle: ManifestBundle): PluginActorId => {
  if (bundle.actor_id) return bundle.actor_id;

  const present = pluginActors.filter((actor) => bundle.skill_md.includes(actor));
  if (present.length === 1) return present[0];
  if (present.length === 0) {
    throw new Error(
      `This bundle (${bundle.manifest_version}) declares no known plugin actor, so the OpenAI shapes cannot be ` +
        're-pointed at theirs. Render and promote the manifest again to record one.'
    );
  }
  throw new Error(
    `This bundle (${bundle.manifest_version}) declares more than one plugin actor (${present.join(', ')}), so the ` +
      'OpenAI retarget would be ambiguous. Render and promote the manifest again.'
  );
};

export const retargetActor = (text: string, from: PluginActorId, to: PluginActorId): string => {
  // Already the target: nothing to substitute, and nothing wrong. This happens
  // when the active bundle was rendered for the very shape being exported.
  if (from === to) return text;

  const out = text.split(from).join(to);
  if (out === text) {
    throw new Error(`Actor retarget produced no change: "${from}" does not appear in the rendered skill.`);
  }
  // `plugin:openai-gpt` is not a prefix of `plugin:openai-agent`, so a clean
  // substitution leaves nothing behind. Assert it anyway — a future actor id
  // that IS a prefix would corrupt silently.
  if (out.includes(from)) {
    throw new Error(`Actor retarget left "${from}" in the output; the ids overlap and the substitution is unsafe.`);
  }
  return out;
};

export class GptInstructionsTooLongError extends Error {
  constructor(readonly length: number) {
    super(
      `Rendered GPT instructions are ${length} characters, over the ${GPT_INSTRUCTIONS_LIMIT} limit. ` +
        "Move detail into a knowledge file rather than raising the cap — the cap is ChatGPT's, not ours."
    );
    this.name = 'GptInstructionsTooLongError';
  }
}

const dial = (bundle: ManifestBundle, key: string): string => {
  const value = bundle.sources.aggression_ceiling[key];
  return typeof value === 'number' ? value.toFixed(2) : 'UNSET';
};

const voiceIdFor = (bundle: ManifestBundle): string =>
  bundle.sources.voice_object_id ?? `voice_${bundle.connection.site_id.replace(/^site_/, '')}`;

export const renderGptInstructions = (bundle: ManifestBundle, actor: PluginActorId = 'plugin:openai-gpt'): string => {
  const c = bundle.connection;
  const text = `# ${c.tenant} publishing desk

You write and publish articles for ${c.origin}. A human drives you. You never publish without an
explicit "publish", and you never release without an explicit "release".

Your knowledge files are the reference: **voice.md** (the house voice in full), **method.md** (the
funnel-stage dials), **publishing.md** (body shape, error codes, recovery). Read the relevant one
before you need it. These instructions are only what you must not get wrong.

## Session start — before writing a word
1. \`object_get {object_type:"editorial_voice", object_id:"${voiceIdFor(bundle)}"}\` — the live voice governs
   over anything in your knowledge files.
2. \`object_contract {object_type:"content_item"}\` — confirm the ceiling, media policy and patch ops.

If either fails, say so and stop. Never write from memory of the voice.

## The ceiling — a hard upper bound, not a target
claim_strength ${dial(bundle, 'claim_strength')} · urgency ${dial(bundle, 'urgency')} · emotional_agitation ${dial(bundle, 'emotional_agitation')} · cta_density ${dial(bundle, 'cta_density')}

Copy may always be calmer. The funnel stage sets the dial between the floor and these numbers — ask
the human which stage the piece is for, and see method.md.
**Nothing on the server enforces this for you.**
Urgency is implied, never literal: no countdowns, no "last chance", no purchase framed as a health
necessity.

## Drafting (in chat, before any tool call)
Write as functional blocks, one per beat — never one wall of text. Each block carries
\`private.strategy\` (hook, agitation, context, explanation, proof, example, comparison, myth, step,
recommendation, resolution, summary) and \`private.intent\` (educate, persuade, reassure, convert,
navigate). The CTA is a separate \`kind:"action"\` node with intent \`convert\` — never a strategy tag.
Exactly one ask per article.

End with a Sources block: the evidence behind each claim, with links. If a claim has no source,
**warn the human and name it** — sourcing is the editor's call. Never invent a source.

Show the draft. Iterate until the human says "publish".

## Publishing — this exact order
Pick \`request_id\` = \`req_gpt_<topic>_<yyyymmdd>_<nn>\`. Pass \`agent_name:"${actor}"\` wherever it
is accepted.

1. \`object_inventory\` — confirm the id and slug are unused.
2. \`object_validate\` with \`{object_type, body, requested_id}\` and no \`object_id\` — dry run. Fix
   every blocker.
3. \`object_create\` — keep this call small; attach the rest by patch.
4. \`object_checkout\` → keep \`lockToken\` and \`record_version\`.
5. **Media now, not earlier.** \`create_agent_artifact_job\` is scoped to an article that already
   exists and is refused before step 3. \`prompt\` is the image SUBJECT ONLY — the site adds its own
   style. Poll \`get_agent_artifact_job_status\`; use the returned \`public_path\` (\`/img/…\`) verbatim.
   A PDF uses \`artifact_kind:"pdf"\` + \`template_id\` and is never the hero.
   **If media fails, stop and report — do not publish a degraded article.**
6. \`object_patch\` with \`lock_token\` + \`expected_record_version\`; take the new version from every
   response. Split a long article across two or three patches. Past ~10 minutes, \`object_refresh_lock\`.
7. \`object_validate {object_type, object_id}\` — must be clean.
8. \`object_publish\` with
   \`producer:{run_id:"${actor.replace(/:/g, '_')}_<request_id>", node_id:"${actor}", prompt_version:"${bundle.manifest_version}", model:"<your model>"}\`.
   This is a dark commit. **It is not live.** Keep \`commit_sha\` and \`production.article_path\`.
9. \`object_checkin\` — release the lock before anything else.
10. Ask: "Release now, or batch more articles first?" A release costs a build. On "release":
    \`release_to_production {idempotency_key:<request_id>}\`, then poll \`deploy_status {commit}\` every
    ~15 s until \`deployStatus:"ready"\` AND \`productionConfirmed:true\`.
11. \`verify_article_images {url, expectedImages:["/img/…"], expectedDocuments:["/pdf/…"], commit}\`.
12. Report: live URL, request_id, commit, what was verified.

## Rules that will otherwise bite you
- **Write \`sources\`. Never write \`claims\`.** A \`claims\` array with any high-risk entry that is
  unverified or has no \`source_ids\` **blocks the publish**, and you have no readiness report to
  clear it with. Sources only warn.
- Read-only on \`editorial_voice\`, \`product\`, \`site\`, templates and taxonomy. Never patch or publish
  them. Taxonomy terms must already exist — unknown terms are a write blocker.
- Never put strategy words in visible text, or in any node id.
- \`423\` → check out again. \`409\` → re-read and retry once.
- On a timeout, 502, or any transport error of a write: **do not re-issue blind.** Retry once with
  the SAME \`idempotency_key\` — a write that already landed replays its original receipt
  (\`replayed_from_idempotency_key:true\`) instead of running twice. With no key, check
  \`object_inventory\` first. Treat a transport error as *unknown*, never as *failed*.
- \`build_not_confirmed_live\` on a first release, and \`inconclusive\` from verify, are both normal —
  poll, do not retry the action.
- Report honestly: published ≠ released ≠ verified. Always say which state you reached.
- **One article at a time, or a handful.** A publication-wide job — re-voicing every article, a batch
  refresh — is twenty-plus lock/patch/publish cycles with a confirmation on each, and it is fragile in
  a chat. If asked for one, say so and hand off to the CMS-Agent publishing workflow rather than
  starting. Offer a single article as a sample instead.
`;
  return text;
};

const knowledgeVoice = (bundle: ManifestBundle): string => {
  // The publication name lives in the skill's H1, above the slice — carry it
  // explicitly so this file names the publication it speaks for.
  const heading = bundle.skill_md.match(/^# (.+?) — publishing desk$/m);
  const publication = heading ? heading[1] : bundle.connection.tenant;
  const start = bundle.skill_md.indexOf('## 1. Voice');
  const end = bundle.skill_md.indexOf('## 3. Drafting');
  return `# The house voice — ${publication}

The live \`editorial_voice\` object is the authority: read it at session start and prefer it over
anything here. This file is the same content in prose, for when you want it without a tool call.

${bundle.skill_md.slice(start, end)}

---
Rendered from manifest \`${bundle.manifest_version}\`.
`;
};

const knowledgeMethod = (bundle: ManifestBundle): string => {
  const start = bundle.skill_md.indexOf('## 2. Method');
  const end = bundle.skill_md.indexOf('## 3. Drafting');
  return `# Method — direct response inside the ceiling

${bundle.skill_md.slice(start, end)}

---
Rendered from manifest \`${bundle.manifest_version}\`.
`;
};

const knowledgePublishing = (bundle: ManifestBundle): string => {
  const start = bundle.skill_md.indexOf('## 5. Body shape');
  return `# Publishing reference — body shape, tools, hard rules

${bundle.skill_md.slice(start)}

---
Rendered from manifest \`${bundle.manifest_version}\`.
`;
};

const actionsSetup = (bundle: ManifestBundle): string => {
  const c = bundle.connection;
  return `# Actions setup (operator)

## Schema

In GPT Builder → Actions → **Import from URL**:

    ${c.origin}/api/plugin/openapi.json

The document is generated from the live tool surface intersected with this plugin's charter, so it
cannot drift from what the tenant actually accepts. Re-import after any re-export.

## Authentication

OAuth. ChatGPT needs a static client id and secret, so register a client ONCE against the tenant's
authorization server and paste the pair into GPT Builder:

| field | value |
|---|---|
| Authorization URL | \`${c.oauth.authorization_url}\` |
| Token URL | \`${c.oauth.token_url}\` |
| Client registration (once) | \`${c.oauth.registration_url}\` |
| Scope | leave EMPTY |
| Token exchange method | POST |

⚠️ **Do not invent a scope.** The tenant's authorization server does not define plugin-specific
scopes; sending an unknown one produces an authorization failure that looks exactly like a bad
credential. If scopes are ever introduced, read them from
\`${c.oauth.authorization_server_metadata_url}\`.

## When authorization fails, check this first

    ${c.mcp_auth_health_url}

No auth needed. It reports \`accepted_audiences\` — a token minted through a host **not** in that
list is refused permanently and the failure is invisible client-side — and \`token_store_reachable\`,
because a store outage refuses every token while looking like a wrong password.

## What the façade will and will not do

It forwards each call to the same handler and the same OAuth as \`/mcp\`, adding no business logic.
It refuses, 403 \`tool_not_in_plugin_charter\`, any tool outside this plugin's charter — the charter
is the path list in the schema.

## Consequential flags

\`x-openai-isConsequential\` is computed from each tool's own governance class, so ChatGPT prompts on
writes and not on reads. Do not hand-edit it in the imported schema; re-export instead.

---
Manifest \`${bundle.manifest_version}\`, rendered ${bundle.rendered_at}.
`;
};

/**
 * The Agent Studio shape's operational layer. An Agent attaches the tenant
 * `/mcp` DIRECTLY as an App, so it needs no Actions schema and no OAuth card —
 * it needs the tenant skill and the operating rules that differ from a GPT's.
 */
const agentOperationalInstructions = (bundle: ManifestBundle): string => {
  const c = bundle.connection;
  return `# ${c.tenant} publishing agent — operating instructions

Your editorial layer is the attached **skill** (\`skill/SKILL.md\`). It is the same text the Claude
desk uses, retargeted to this surface. Follow it. These instructions cover only what differs here.

## Your connection

The tenant CMS is attached as an MCP App at \`${c.mcp_url}\`, authenticated as **you** over OAuth.
There is no Actions façade in this shape and no schema to import.

⚠️ **The charter is advisory here.** A Custom GPT reaching this tenant through the Actions façade is
refused any tool outside the plugin charter. This surface has the whole tool list, so the skill's
tool section describes the job rather than a boundary the server enforces. Stay inside it.

⚠️ **Do not attach the PDF-Tool MCP app directly.** The tenant \`/mcp\` already bridges pdf-tool with
server-side storage grants. A direct attachment exposes \`set_storage_grant\` to you for no benefit.

## Attribution

Pass \`agent_name: "plugin:openai-agent"\` wherever it is accepted, and on \`object_publish\` pass
\`producer: {run_id:"plugin_openai-agent_<request_id>", node_id:"plugin:openai-agent",
prompt_version:"${bundle.manifest_version}", model:"<your model>"}\`.

That id is what separates your publishes from the Custom GPT's in the ledger. They are different
surfaces with different guarantees; a publish that cannot say which one wrote it cannot answer why an
article reads the way it does.

## Bridge mode

Content drafted elsewhere — another chat, a consulting GPT, a Gem — arrives here as pasted text. Take
it, hold it to this publication's voice and ceiling exactly as if you had written it, and say plainly
what you changed. A draft from outside gets no exemption from the house rules.

## Long runs

This surface suits multi-step work better than a Custom GPT does. It still does not suit
publication-wide batches: twenty-plus lock/patch/publish cycles in one conversation is fragile
whatever the surface. A batch belongs to the CMS-Agent publishing workflow. Say so and hand off.

---
Manifest \`${bundle.manifest_version}\`, rendered ${bundle.rendered_at}.
`;
};

const agentAppCard = (bundle: ManifestBundle, skillZipName: string): string => {
  const c = bundle.connection;
  return `# Agent setup (operator)

ChatGPT → Agents → this agent → Apps.

| field | value |
|---|---|
| MCP server URL | \`${c.mcp_url}\` |
| Auth | OAuth, as the human who will run it |
| Approval | "Allow low-risk actions" is safe once reads are annotated (see below) |

## Attach

Add the tenant \`/mcp\` as an App. **Remove any direct PDF-Tool MCP app** — the tenant already
bridges pdf-tool server-side with minted grants, and a direct attachment only exposes
\`set_storage_grant\` to the model.

## Editorial layer

Skills → Add skill → **Upload skill** → **Upload .zip file** → pick \`${skillZipName}\`, which sits
next to this file. Then paste \`operational-instructions.md\` into the agent's instructions. The
skill is the same text the Claude desk uses; the operational file covers what differs here.

Agent Studio takes a skill as a \`.zip\` whose ROOT is \`SKILL.md\` — \`${skillZipName}\` is exactly
that, built for you. Do NOT upload this whole config bundle: it is refused with *"This archive
isn't a supported GPT export or plugin: it lacks \`gizmo.yaml\` and a plugin manifest"*, which reads
like a broken tenant and is only the wrong zip shape. \`skill/SKILL.md\` is the same text loose, for
reading and diffing.

Agent Studio does not autosave. It counts pending changes in the header and holds them until you
press **Update**.

## Read actions

Agent Studio will list every tool under **Write actions** and report *"No read actions are
available for this app"*, including plain reads like \`object_get\`, \`object_contract\` and \`ping\`.
That is a client-side gap, not a fault here, and **detaching and re-attaching does not clear it** —
tested against a clean re-attach on 2026-09-03.

This tenant does classify reads, on both surfaces, from one field on the tool definition: MCP
\`annotations.readOnlyHint\`, and \`x-openai-isConsequential\` in the Actions schema. Check it from
outside with no credentials:

    ${c.openapi_url ?? `${c.origin}/api/plugin/openapi.json`}

\`object_get\` and \`object_contract\` come back \`x-openai-isConsequential: false\`; \`object_publish\`
comes back \`true\`.

So set Approval to **"Allow low-risk actions"**. It is what keeps a read from costing a
confirmation click, and with the Read bucket empty the stricter setting confirms every single call.

## When authorization fails

    ${c.mcp_auth_health_url}

No auth needed. Reports \`accepted_audiences\` — a token minted through a host not in that list is
refused permanently and looks exactly like a bad credential — and \`token_store_reachable\`.

---
Manifest \`${bundle.manifest_version}\`.
`;
};

const shapeChooser = (bundle: ManifestBundle): string =>
  `# ${bundle.connection.tenant} — OpenAI publishing, two shapes

Both are supported. They are not alternatives; they suit different jobs.

| | \`gpt/\` — Custom GPT | \`agent/\` — Agent Studio |
|---|---|---|
| Connection | Actions façade \`/api/plugin/*\` | tenant \`/mcp\` attached directly as an App |
| Charter | **enforced** — a tool outside it is refused 403 | advisory only |
| Distribution | share link / workspace / store; runs on the installer's own plan and credits | invite-only in the workspace; runs on the invitee's seat |
| Composability | @-mentionable beside other GPTs — a consulting GPT drafts, this one publishes | bridge mode: paste content in from another chat |
| Best for | distributed tenant-owner installs | power use, long multi-step runs |
| Ledger actor | \`plugin:openai-gpt\` | \`plugin:openai-agent\` |

**Before either:** the installer needs an identity on this tenant. Invite them as \`publisher\` or
\`editor\` first — both shapes authenticate the human over OAuth, and an installer with no account can
attach the tools and then fail every write.

Start with \`gpt/actions-setup.md\` or \`agent/app-setup.md\`.

---
Manifest \`${bundle.manifest_version}\`, rendered ${bundle.rendered_at}.
`;

/**
 * W3.2 + the 2026-09-01 two-shape ruling — ONE download carrying BOTH OpenAI
 * shapes, because they are not alternatives: a Custom GPT distributes to tenant
 * owners on their own plan and is charter-enforced through the façade, while an
 * Agent Studio agent is invite-only, attaches `/mcp` directly, and suits long
 * runs. Both are supported; neither is optional.
 *
 * The tenant-specific content is authored ONCE in the skill renderer. `gpt/`
 * gets a projection of it under the 8k cap; `agent/` gets the skill itself,
 * retargeted to its own actor id. There is no hand-maintained duplicate.
 */
/**
 * The name of the inner skill archive, derived from the skill's own frontmatter
 * `name:` so the chip Agent Studio shows matches the file the operator picked.
 * A skill without a parseable name falls back to the tenant — never to a
 * generic label, which would collide across tenants in the operator's Downloads.
 */
export const skillZipNameFor = (bundle: ManifestBundle, skillMd: string): string => {
  const declared = /^name:\s*(\S+)\s*$/m.exec(skillMd)?.[1];
  return `${declared ?? bundle.connection.tenant}-skill.zip`;
};

export const buildGptConfigZip = (bundle: ManifestBundle): { filename: string; bytes: Buffer } => {
  const sourceActor = sourceActorFor(bundle);
  const instructions = renderGptInstructions(bundle, 'plugin:openai-gpt');
  if (instructions.length > GPT_INSTRUCTIONS_LIMIT) throw new GptInstructionsTooLongError(instructions.length);

  const agentSkill = retargetActor(bundle.skill_md, sourceActor, 'plugin:openai-agent');

  /**
   * Agent Studio's "Upload skill" takes a `.zip` that contains `SKILL.md` AT
   * ITS ROOT — nothing above it. Handing it this whole config bundle is
   * refused with "This archive isn't a supported GPT export or plugin: it
   * lacks gizmo.yaml and a plugin manifest", which reads like a broken tenant
   * and is really the wrong zip shape. Ship the inner archive ready-made so
   * the install is one drag-and-drop instead of a `cd` and a `zip` the
   * operator has to be told about.
   *
   * The loose `agent/skill/SKILL.md` stays: it is the readable copy, and the
   * Claude and Gemini shapes want the text rather than an archive.
   */
  const skillZip = createZip([{ path: 'SKILL.md', content: agentSkill }]);

  const entries: ZipEntry[] = [
    { path: `agent/${skillZipNameFor(bundle, agentSkill)}`, content: skillZip },
    { path: 'README.md', content: shapeChooser(bundle) },

    // Shape A — Custom GPT, through the Actions façade.
    { path: 'gpt/instructions.md', content: instructions },
    { path: 'gpt/actions-setup.md', content: actionsSetup(bundle) },
    { path: 'gpt/knowledge/voice.md', content: knowledgeVoice(bundle) },
    { path: 'gpt/knowledge/method.md', content: knowledgeMethod(bundle) },
    { path: 'gpt/knowledge/publishing.md', content: knowledgePublishing(bundle) },

    // Shape B — Agent Studio, tenant /mcp attached directly as an App.
    { path: 'agent/operational-instructions.md', content: agentOperationalInstructions(bundle) },
    { path: 'agent/app-setup.md', content: agentAppCard(bundle, skillZipNameFor(bundle, agentSkill)) },
    { path: 'agent/skill/SKILL.md', content: agentSkill },
  ];
  return { filename: `${bundle.connection.tenant}-openai-config.zip`, bytes: createZip(entries) };
};
