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
import type { ManifestBundle } from './manifest-types.js';

/** ChatGPT's hard cap on the Custom GPT instructions field. */
export const GPT_INSTRUCTIONS_LIMIT = 8000;

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

export const renderGptInstructions = (bundle: ManifestBundle): string => {
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
Pick \`request_id\` = \`req_gpt_<topic>_<yyyymmdd>_<nn>\`. Pass \`agent_name:"plugin:openai"\` wherever it
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
   \`producer:{run_id:"plugin_openai_<request_id>", node_id:"plugin:openai", prompt_version:"${bundle.manifest_version}", model:"<your model>"}\`.
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

/** W3.2 — the downloadable GPT configuration bundle. */
export const buildGptConfigZip = (bundle: ManifestBundle): { filename: string; bytes: Buffer } => {
  const instructions = renderGptInstructions(bundle);
  if (instructions.length > GPT_INSTRUCTIONS_LIMIT) throw new GptInstructionsTooLongError(instructions.length);

  const entries: ZipEntry[] = [
    { path: 'instructions.md', content: instructions },
    { path: 'actions-setup.md', content: actionsSetup(bundle) },
    { path: 'knowledge/voice.md', content: knowledgeVoice(bundle) },
    { path: 'knowledge/method.md', content: knowledgeMethod(bundle) },
    { path: 'knowledge/publishing.md', content: knowledgePublishing(bundle) },
  ];
  return { filename: `${bundle.connection.tenant}-gpt-config.zip`, bytes: createZip(entries) };
};
