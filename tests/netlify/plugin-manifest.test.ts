import '../../sites/drlurie/config/policy-bindings.js'; // register the drlurie site providers
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildManifestBundle,
  buildConnection,
  manifestStaleReasons,
  skillFingerprint,
} from '../../packages/core/server/lib/plugin/build-manifest.js';
import {
  buildPluginTools,
  toolSurfaceDigest,
  PLUGIN_TOOL_DENYLIST,
} from '../../packages/core/server/lib/plugin/build-tools.js';
import { manifestBundleSchema } from '../../packages/core/server/lib/plugin/manifest-types.js';
import { renderSkillMarkdown } from '../../packages/core/server/lib/plugin/render-skill.js';
import { visibleToolDefinitions } from '../../netlify/functions/mcp.js';

const ORIGIN = 'https://drluriescience.netlify.app';
const FIXED_NOW = () => new Date('2026-08-31T12:00:00.000Z');

const VOICE_FIXTURE = {
  object_id: 'voice_drlurie',
  record_version: 14,
  body: {
    name: 'Dr. Lurie — evidence-led skin health',
    audience: 'Adults making decisions about their own skin.',
    tone: ['warm', 'calm', 'evidence-led', 'non-alarmist'],
    cadence: 'Conversational but disciplined.',
    claim_policy: 'Efficacy statements are hedged to the strength of the evidence.',
    cta_policy: 'At most one ask per article.',
    reader_safety_notes: 'Consumer health audience with no clinical training.',
    default_framework: 'fw_concern',
    frameworks: [
      {
        framework_id: 'fw_concern',
        label: 'Concern',
        when_to_use: 'Reader arrives worried.',
        beats: ['hook', 'proof'],
      },
    ],
    lexicon: { prefer: ['barrier', 'evidence'], avoid: ['miracle', 'cure'] },
  },
};

const render = (overrides: Partial<Parameters<typeof buildManifestBundle>[0]> = {}) =>
  buildManifestBundle({
    origin: ORIGIN,
    definitions: visibleToolDefinitions(),
    voice: VOICE_FIXTURE,
    platform: 'claude',
    now: FIXED_NOW,
    approval: {
      master: 'all-autonomous',
      overrides: { product: 'require-approval', editorial_voice: 'require-approval' },
    },
    ...overrides,
  });

// ─── W1.3 — tools.json is DERIVED from governance.toolClass ────────────────

test('plugin tools are derived from tool governance, never a hand-kept list', () => {
  const tools = buildPluginTools(visibleToolDefinitions());
  assert.ok(tools.length > 10, 'expected a real tool surface');

  // Only one privileged tool is allowed through, by name, and no membership tool ever.
  for (const tool of tools) {
    const allowed =
      ['read', 'draft', 'creation', 'publication'].includes(tool.tool_class) || tool.name === 'release_to_production';
    assert.ok(allowed, `${tool.name} carries class ${tool.tool_class}, which a plugin must never receive`);
    assert.notEqual(tool.tool_class, 'membership', `${tool.name} is a membership tool`);
  }

  // consequential is computed, not hand-set — that is what W3.2 exports as
  // x-openai-isConsequential.
  for (const tool of tools) {
    assert.equal(tool.consequential, tool.tool_class !== 'read', `${tool.name} consequential flag is wrong`);
  }

  const names = new Set(tools.map((t) => t.name));
  // The publish path must be complete...
  for (const required of [
    'object_create',
    'object_checkout',
    'object_patch',
    'object_publish',
    'object_checkin',
    'object_refresh_lock',
    'release_to_production',
    'deploy_status',
    'verify_article_images',
    'object_contract',
  ]) {
    assert.ok(names.has(required), `${required} is missing from the plugin tool list`);
  }
  // ...and every named exclusion must actually be excluded.
  for (const denied of Object.keys(PLUGIN_TOOL_DENYLIST)) {
    assert.ok(!names.has(denied), `${denied} is on the denylist but still reached the bundle`);
  }
  for (const never of [
    'member_list',
    'wipe_blob_stores',
    'membership_policy_set',
    'site_apply_theme',
    'product_set_price',
  ]) {
    assert.ok(!names.has(never), `${never} must never be in a plugin bundle`);
  }
});

test('the tool-surface digest is stable for the same surface and moves when it changes', () => {
  const tools = buildPluginTools(visibleToolDefinitions());
  assert.equal(toolSurfaceDigest(tools), toolSurfaceDigest([...tools]));
  assert.notEqual(toolSurfaceDigest(tools), toolSurfaceDigest(tools.slice(1)));
});

// ─── W1.2 — the rendered skill carries the rules the code actually enforces ──

test('the rendered skill states the two rules that block or bind a hand-authored publish', () => {
  const { skill_md: skill } = render();

  // ART-2 article_claim_verification is blocks_publish and bites hand-authored
  // bodies only — the plugin IS that path (docs/plugin/legacy-gpt.md §A.3.1).
  assert.match(skill, /Write `sources`\. Never write `claims`\./);
  assert.ok(
    skill.includes('blocks the') && skill.includes('publish**'),
    'the skill must say a claims array blocks the publish'
  );

  /**
   * W7.3 REPLACES what this assertion used to check. The skill used to say
   * "Nothing on the server enforces this ceiling for you" — true until the
   * ceiling moved into `object_validate`, and dangerous the moment it stopped
   * being true: a model told it is the only enforcement will not read the
   * score the server now returns. The skill must now say the opposite, name
   * the gate, and say how to lower a dial.
   */
  assert.ok(
    !skill.includes('Nothing on the server enforces this ceiling'),
    'the skill must not claim the server ignores the ceiling — W7.3 enforces it'
  );
  assert.match(skill, /The server scores this/);
  assert.match(skill, /GATE-CEIL-1/);
  assert.match(skill, /How to lower a dial/);
});

test('the rendered skill writes the live aggression ceiling in as a hard bound', () => {
  const { skill_md: skill } = render();
  for (const label of ['claim_strength', 'urgency', 'emotional_agitation', 'cta_density']) {
    assert.ok(skill.includes(label), `${label} missing from the rendered ceiling table`);
  }
  assert.match(skill, /ceiling, not a target/);
  assert.ok(!skill.includes('UNSET'), 'drlurie declares a ceiling, so no dial should render as UNSET');
});

test('the rendered skill carries the voice and names the approval-gated types', () => {
  const { skill_md: skill } = render();
  assert.ok(skill.includes('Dr. Lurie — evidence-led skin health'));
  assert.ok(skill.includes('fw_concern'));
  assert.ok(skill.includes('miracle'), 'the avoid-lexicon must survive into the skill');
  assert.match(skill, /`product`/);
  assert.match(skill, /`editorial_voice`/);
});

test('the skill names the real voice object id the tenant actually stores', () => {
  // The plugin's very first tool call is object_get on this id. If the rendered
  // id is wrong the session dies at step 0, so it is pinned against the id
  // convention the site export itself uses (sites/<slug>/data/site/voice/).
  const { skill_md: skill } = render();
  assert.ok(
    skill.includes('object_id:"voice_drlurie"'),
    'the session-start call must name voice_drlurie, the id committed in the site export'
  );
});

test('the skill orders object_create BEFORE the media call', () => {
  // Found by the 2026-08-31 live acceptance run: create_agent_artifact_job is
  // scoped to an EXISTING content_item and refuses outright with
  // "content_item <id> does not exist on <site>" when the object has not been
  // created yet. The first rendered skill put media first (following
  // publishing-policy.md §4, which is wrong on this point), so a plugin
  // following it verbatim died at its first tool call.
  const { skill_md: skill } = render();
  const createAt = skill.indexOf('`object_create {object_type:"content_item"');
  const mediaAt = skill.indexOf('`create_agent_artifact_job`');
  assert.ok(createAt > 0 && mediaAt > 0, 'both steps must be present in the publish procedure');
  assert.ok(createAt < mediaAt, 'object_create must come before create_agent_artifact_job');
  assert.match(skill, /must exist before you can ask for media/);
  // Fail-closed must survive the reorder — it is about not publishing a
  // degraded article, not about ordering.
  assert.match(skill, /do not publish a degraded article/);
});

test('the skill explains why an idempotent retry is safe', () => {
  // The live run hit a real 502 on object_publish; the retry replayed the
  // original receipt rather than double-publishing. The skill must say so, or
  // a cautious model will refuse to retry and leave the article half-published.
  const { skill_md: skill } = render();
  assert.match(skill, /replayed_from_idempotency_key/);
  assert.match(skill, /treat the outcome as "unknown"/);
});

test('the skill tells the truth about what a 502 means (W6 D3)', () => {
  // The W2 run inferred "large payloads 502" and the skill inherited a
  // back-off-and-shrink posture from it. Measured 2026-09-01 that inference is
  // wrong: `ping` 502s too and the endpoint answers in 250-650 ms. A plugin
  // that waits 60 s and then splits its payload is following a fiction; the
  // correct move is an immediate retry.
  const { skill_md: skill } = render();
  assert.match(skill, /transport\*\* failure, not a CMS failure/);
  assert.match(skill, /Retry immediately/);
  assert.ok(
    !/back off 60 s\.$/m.test(skill),
    'the skill must not instruct a 60-second backoff as the response to a 502'
  );
});

test('the skill points reads at the projection that fits (W6 D3)', () => {
  // object_get returns an unbounded history ledger by default. The skill is
  // where a plugin learns to ask for less.
  const { skill_md: skill } = render();
  assert.match(skill, /projection:"nodes"/);
  assert.match(skill, /projection:"summary"/);
});

test('a missing voice degrades to a warning and a placeholder skill, never a throw', () => {
  const bundle = render({ voice: null });
  assert.equal(bundle.sources.voice_object_id, null);
  assert.ok(bundle.warnings.some((w) => w.includes('editorial_voice')));
  assert.match(bundle.skill_md, /read the live object at session start/);
});

test('the skill makes rich_text.v1 the rule, not an option (2026-09-04 live run)', () => {
  // Found by the 2026-09-04 plugin acceptance run. `public.body` takes a plain
  // string OR a rich_text.v1 document and BOTH validate clean, so a body typed
  // as blank-line-separated lines passes every gate and reaches readers as an
  // undifferentiated wall: no list, no bold, no link. Two articles shipped to
  // production that way. The skill is the only place this is catchable, so it
  // must state the rule, show the shapes, and say what a plain string costs.
  const { skill_md: skill } = render();
  assert.match(skill, /Formatting is not optional/);
  assert.match(skill, /A plain string is plain text/);
  assert.ok(
    skill.includes('the moment a body carries a list, a bold lead-in, a heading or a link'),
    'the skill must state when rich text is mandatory'
  );
  // The three shapes a model cannot reconstruct from memory.
  assert.match(skill, /"nodeType": "unordered-list"/);
  assert.match(skill, /"nodeType": "list-item"/);
  assert.match(skill, /"nodeType": "hyperlink"/);
  assert.ok(skill.includes('"marks": [{ "type": "bold" }]'), 'the bold-mark shape must be shown');
  // Bold lead-ins and the Sources shape are house style, not decoration.
  assert.match(skill, /Bold lead-ins are house style/);
  assert.ok(skill.includes('**bold title**'), 'the Sources shape must require a bold title');
});

test('the render is deterministic for identical inputs', () => {
  assert.equal(render().skill_md, render().skill_md);
  assert.equal(render().manifest_version, render().manifest_version);
});

// ─── W1.1 — the bundle validates and the connection is the real one ──────────

test('a rendered bundle satisfies its own schema', () => {
  const parsed = manifestBundleSchema.safeParse(render());
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)));
});

test('the connection card carries the verified OAuth paths and the auth-health probe', () => {
  const connection = buildConnection(ORIGIN, 'drlurie', 'site_drlurie');
  assert.equal(connection.mcp_url, `${ORIGIN}/mcp`);
  // W0.1: audience pinning is the top connector failure mode and is invisible
  // client-side, so the probe URL ships on the card.
  assert.equal(connection.mcp_auth_health_url, `${ORIGIN}/mcp?health=auth`);
  assert.equal(connection.oauth.authorization_url, `${ORIGIN}/oauth/authorize`);
  assert.equal(connection.oauth.token_url, `${ORIGIN}/oauth/token`);
  assert.equal(connection.oauth.registration_url, `${ORIGIN}/oauth/register`);
});

// ─── W4.2 — staleness ───────────────────────────────────────────────────────

test('staleness reports a moved voice, a changed tool surface and a changed posture', () => {
  const bundle = render();
  const fresh = {
    voiceRecordVersion: bundle.sources.voice_record_version,
    toolSurfaceDigest: bundle.sources.tool_surface_digest,
    approvalPosture: bundle.sources.approval_posture,
  };
  assert.deepEqual(manifestStaleReasons(bundle, fresh), []);

  assert.equal(manifestStaleReasons(bundle, { ...fresh, voiceRecordVersion: 15 }).length, 1);
  assert.equal(manifestStaleReasons(bundle, { ...fresh, toolSurfaceDigest: 'sha_deadbeef_9' }).length, 1);
  assert.equal(manifestStaleReasons(bundle, { ...fresh, approvalPosture: 'all-require-approval' }).length, 1);
  assert.equal(
    manifestStaleReasons(bundle, { voiceRecordVersion: 99, toolSurfaceDigest: 'x', approvalPosture: 'y' }).length,
    3
  );
});

// ─── W7.7 — the two ways the skill went stale silently ──────────────────────

/**
 * Both of these shipped for real on 2026-09-04: a direct-to-main commit rewrote
 * the drafting instructions in `render-skill.ts`, and every promoted bundle kept
 * serving the old text while /admin/plugins reported "Current". The four input
 * checks above cannot see either case — the renderer is code, and the ceiling
 * was recorded but never compared.
 */
test('a changed RENDERER marks the bundle stale, though no input moved', () => {
  const bundle = render();
  const fresh = {
    voiceRecordVersion: bundle.sources.voice_record_version,
    toolSurfaceDigest: bundle.sources.tool_surface_digest,
    approvalPosture: bundle.sources.approval_posture,
    skillDigest: bundle.sources.skill_digest,
  };
  assert.deepEqual(manifestStaleReasons(bundle, fresh), [], 'nothing moved');

  // The renderer emitted different prose from identical inputs.
  const reasons = manifestStaleReasons(bundle, { ...fresh, skillDigest: 'v00000000' });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /rendered skill text changed/);
  assert.match(reasons[0], /re-render and promote/);
});

test('a changed CEILING marks it stale — recorded since W1.1, never compared until now', () => {
  const bundle = render();
  const louder = renderSkillMarkdown({
    tenant: 'dr-lurie',
    siteId: 'site_drlurie',
    origin: ORIGIN,
    platform: 'claude',
    actorId: 'plugin:claude',
    voice: null,
    // The one input change; everything else identical.
    aggressionCeiling: { claim_strength: 0.9, urgency: 0.8, emotional_agitation: 0.8, cta_density: 0.7 },
    approvalPosture: bundle.sources.approval_posture,
    approvalOverrides: {},
    tools: bundle.tools,
    manifestVersion: bundle.manifest_version,
  });

  const reasons = manifestStaleReasons(bundle, {
    voiceRecordVersion: bundle.sources.voice_record_version,
    toolSurfaceDigest: bundle.sources.tool_surface_digest,
    approvalPosture: bundle.sources.approval_posture,
    skillDigest: skillFingerprint(louder),
  });
  assert.equal(reasons.length, 1, 'a ceiling change must not read as "Current"');
  assert.match(reasons[0], /aggression ceiling/);
});

test('the fingerprint ignores the version line — a check that cries wolf daily is worse than none', () => {
  const bundle = render();
  // `manifest_version` embeds the render DATE, so tomorrow's identical render
  // carries a different one. The digest must not move for that.
  const tomorrow = bundle.skill_md.replace(
    /^manifest_version: .*$/m,
    'manifest_version: dr-lurie-claude-29991231-ffffffff'
  );
  assert.notEqual(tomorrow, bundle.skill_md, 'the fixture must actually differ');
  assert.equal(skillFingerprint(tomorrow), skillFingerprint(bundle.skill_md));

  // …but any other line does move it.
  assert.notEqual(skillFingerprint(`${bundle.skill_md}\nOne more instruction.`), skillFingerprint(bundle.skill_md));
});

test('a bundle promoted before this field existed is never called stale on no evidence', () => {
  const bundle = render();
  const legacy = { ...bundle, sources: { ...bundle.sources, skill_digest: undefined } };
  const live = {
    voiceRecordVersion: bundle.sources.voice_record_version,
    toolSurfaceDigest: bundle.sources.tool_surface_digest,
    approvalPosture: bundle.sources.approval_posture,
    skillDigest: 'v99999999',
  };
  assert.deepEqual(manifestStaleReasons(legacy, live), [], 'no stored digest = not checked, not stale');

  // And the mirror: the caller could not render a live skill (no actor_id).
  const { skillDigest: _omitted, ...noLive } = live;
  void _omitted;
  assert.deepEqual(manifestStaleReasons(bundle, noLive), []);
});

test('the catch-all stays quiet when a specific reason already explains it', () => {
  const bundle = render();
  const reasons = manifestStaleReasons(bundle, {
    voiceRecordVersion: 15,
    toolSurfaceDigest: bundle.sources.tool_surface_digest,
    approvalPosture: bundle.sources.approval_posture,
    skillDigest: 'v00000000',
  });
  // The voice moved, which is WHY the text differs. One precise sentence beats
  // two, the second of which only says "and the text is different".
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /editorial voice moved/);
});

/**
 * A stand-in for the `render_article_pdf` definition, so both sides of the
 * tool-surface conditional are covered on a deploy that has the call and on one
 * that does not — the branch that ships it is not always the branch under test.
 */
const RENDER_ARTICLE_PDF_DEF = {
  name: 'render_article_pdf',
  description: 'THE ONE CALL that turns an article into an attached PDF. Renders, polls and attaches.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  governance: { toolClass: 'creation', preview: { kind: 'input_echo' } },
} as unknown as ReturnType<typeof visibleToolDefinitions>[number];

const withArticlePdf = () =>
  render({ definitions: [...visibleToolDefinitions(), RENDER_ARTICLE_PDF_DEF] });

test('the skill teaches render_article_pdf when the deploy has it (2026-09-04 live run)', () => {
  // Found by the 2026-09-04 plugin acceptance run. `render_article_pdf` maps the
  // article to render data, resolves template + brand, renders, polls, reads the
  // quality gate and attaches the document node. The skill never named it, so the
  // desk hand-built that sequence in ~8 calls and hand-authored the `data` the
  // deterministic mapper exists to produce. Naming it is not enough on its own:
  // the same run read a findings-carrying success as a failure and re-rendered a
  // pending job, so the receipt rules are part of the fix, not commentary.
  const { skill_md: skill, tools } = withArticlePdf();
  assert.ok(
    tools.some((t) => t.name === 'render_article_pdf'),
    'the fixture must put the call on the tool surface, or this asserts nothing'
  );
  assert.match(skill, /render_article_pdf/);
  assert.ok(skill.includes('THE ONE CALL'), 'render_article_pdf must be presented as the single call');
  assert.ok(skill.includes('content_item_id'), 'the skill must name the argument the tool actually takes');
  assert.ok(skill.includes('never hand-author'), 'the skill must forbid hand-authoring render data');
  // The receipt is what the desk reports from.
  assert.ok(skill.includes('The receipt is the deliverable'), 'the receipt shape must be documented');
  assert.match(skill, /qualityGate/);
  assert.match(skill, /unfilled/);
  assert.match(skill, /public_path/);
  // The three misreadings this run actually made.
  assert.ok(skill.includes('findings WARN, they never block'), 'findings must be stated as non-blocking');
  assert.ok(
    skill.includes('Do not describe such a render as failed'),
    'a completed render carrying findings must not be reported as a failure'
  );
  assert.ok(skill.includes('STILL RENDERING'), 'a pending status must be stated as still rendering');
  assert.match(skill, /re-render/);
  // create_agent_artifact_job survives as the fallback, not the default.
  assert.ok(skill.includes('is the FALLBACK'), 'create_agent_artifact_job must be demoted to the fallback');
});

test('the skill never names render_article_pdf on a deploy without it', () => {
  // The tool reaches a deploy on its own schedule. A skill that named it
  // unconditionally would send the desk at a tool the server answers with
  // "unknown tool" — the failure the generated tool list exists to prevent. So
  // the PDF path is rendered FROM the tool surface, and this is the other side.
  const { skill_md: skill, tools } = render();
  assert.ok(
    !tools.some((t) => t.name === 'render_article_pdf'),
    'this case only means something while the call is absent from the default surface'
  );
  assert.ok(!skill.includes('render_article_pdf'), 'the skill must not name a tool this deploy cannot call');
  // The hand-built path survives, and is still told to read the template first.
  assert.ok(skill.includes('artifact_kind:"pdf"'), 'the fallback PDF call must still be taught');
  assert.match(skill, /get_pdf_template/);
});

test('the skill carries the corrections the 2026-09-04 live run cost us', () => {
  // Every rule below was paid for once already on 2026-09-04: each is a place the
  // skill was silent or wrong and the desk did the expensive thing instead. None
  // of them depends on the PDF tool surface.
  const { skill_md: skill } = render();

  // Taxonomy is a WRITE BLOCKER, and the slugs are not guessable from the subject.
  assert.match(skill, /object_type:"taxonomy"/);
  assert.match(skill, /WRITE BLOCKER/);
  assert.ok(skill.includes('If any of the four fails'), 'the taxonomy read joins the session-start reads');

  // usageContext is the single biggest cost lever in the document.
  assert.ok(
    skill.includes('is mandatory on every image job'),
    'requirements.image.usageContext must be stated as mandatory'
  );
  assert.match(skill, /usageContext/);
  assert.match(skill, /article_body/);
  assert.ok(
    skill.includes('a MISSING value costs everything'),
    'the skill must say that omitting usageContext routes to the most expensive model'
  );

  // A PDF in body.image fails the build; hero and in-body media are not interchangeable.
  assert.ok(
    skill.includes('Hero and in-body media are different mechanisms'),
    'hero vs in-body media must be distinguished'
  );
  assert.ok(skill.includes('fails the whole build'), 'the PDF-as-hero trap must be stated');
  assert.match(skill, /set_article_meta/);
  assert.match(skill, /node\.public\.media/);

  // Node ids are minted by the caller on create, by the server only inside a patch.
  assert.ok(skill.includes('is REQUIRED on every node you pass to'), 'the caller mints node ids on create');
  assert.match(skill, /\^n_\[a-z0-9\]\+\$/);
  assert.ok(skill.includes('only mints an id for an'), 'minting must be scoped to upsert_node inside a patch');
  assert.match(skill, /upsert_node/);

  // object_patch already returns the verdict; a second validate is a wasted round trip.
  assert.ok(skill.includes('validation_summary'), 'the patch response already carries the verdict');
  assert.ok(skill.includes('Validate only if you still need to'), 'the pre-publish validate must be conditional');

  // release_to_production is the ONE tool that must not be retried on a 502.
  assert.ok(skill.includes('502s, do NOT retry it'), 'the release 502 exception must be stated at the release step');
  assert.ok(/two\s+production builds for one release/.test(skill), 'the observed double build is why it exists');
  assert.ok(
    /The one exception is\s+`release_to_production`/.test(skill),
    'the general 502 rule in section 6 must name its exception'
  );

  // Template selection: list_pdf_templates is not choosable, and the poll has a known bug.
  assert.ok(skill.includes('returns **ids only**'), 'list_pdf_templates returns ids only');
  assert.match(skill, /topic-locked/);
  assert.match(skill, /bef0d7b0-a042-4221-aa03-7870f1deb879/);
  assert.ok(
    skill.includes('comes back `Invalid input`'),
    'the get_pdf_template_validation validation_id bug must be documented'
  );

  // The section 7 table is generated from the manifest, so these two live in prose.
  assert.match(skill, /create_pdf_template/);
  assert.ok(skill.includes('are callable too'), 'the template tools must be named in prose, not only the table');
});
