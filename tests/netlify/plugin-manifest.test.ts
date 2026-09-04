import '../../sites/drlurie/config/policy-bindings.js'; // register the drlurie site providers
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildManifestBundle,
  buildConnection,
  manifestStaleReasons,
} from '../../packages/core/server/lib/plugin/build-manifest.js';
import {
  buildPluginTools,
  toolSurfaceDigest,
  PLUGIN_TOOL_DENYLIST,
} from '../../packages/core/server/lib/plugin/build-tools.js';
import { manifestBundleSchema } from '../../packages/core/server/lib/plugin/manifest-types.js';
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
