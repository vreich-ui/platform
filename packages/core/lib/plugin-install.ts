/**
 * The public install page's content (W7.1) — one card per chat app, derived
 * from the ACTIVE manifest rather than typed by hand.
 *
 * WHY THIS FILE EXISTS AT ALL. Every install instruction this project has
 * written by hand has drifted: the legacy GPT schema had five separate
 * inaccuracies (docs/plugin/legacy-gpt.md §A.2), all of them because a human
 * maintained URLs a machine already knew. So the URLs, the manifest version
 * and the tool digest come from the promoted bundle, and only the PROSE is
 * authored here.
 *
 * THREE RULES THE CARDS OBEY, from the W7 plan:
 *
 *  1. THREE NUMBERED STEPS, MAXIMUM. An install page nobody finishes is worth
 *     nothing. Anything past the third step is either a caveat (it goes under
 *     `notes`) or belongs on the admin's own plugins page, which is where the
 *     operator — not the installer — works.
 *  2. EACH CARD CARRIES THE EXACT ERROR TEXT THE WRONG MOVE PRODUCES. Not a
 *     description of the failure: the literal string the server returns, so an
 *     installer can match what is on their screen against what is on the page
 *     and know which of three mistakes they made. Every string in `errors`
 *     below is copied from the code that emits it, and the colocated test
 *     fails if the emitter's text moves.
 *  3. THE LAST STEP IS ALWAYS "PROVE IT" — run `whoami`. An install that
 *     "seems to work" is the failure mode this whole wave exists for: a
 *     connector authenticates, attaches tools, and then fails every write,
 *     which looks like a broken tenant and is a missing invitation. One read
 *     call settles it before anyone writes a word (see server/lib/whoami.ts).
 *
 * `packages/core/admin/**\/*.tsx` is excluded from the test compile, so all of
 * this lives here, where `node --test` can import it, and the page is a thin
 * renderer over it — the same split `lib/admin/plugins-client.ts` uses.
 */

export type InstallPlatformId = 'claude' | 'openai-gpt' | 'openai-agent' | 'gemini';

/** What the endpoint publishes about a tenant. Public facts only — no secrets pass through here. */
export interface InstallFacts {
  tenant: string;
  brand_name: string;
  origin: string;
  mcp_url: string;
  openapi_url: string;
  mcp_auth_health_url: string;
  manifest_version: string;
  tools_digest: string;
  /** Optional per-site published links (site-identity `pluginInstall`). */
  custom_gpt_url?: string;
  agent_studio_url?: string;
  /** Download paths served by the install endpoint; each requires a signed-in member. */
  downloads: { skill: string; plugin: string; gpt: string; gemini: string };
}

export interface InstallStep {
  /** One sentence. The installer does exactly this and nothing else. */
  do: string;
  /** The value to paste, when the step has one. Rendered as a copy button. */
  copy?: string;
  /** A file to download, when the step has one. Requires a signed-in member. */
  download?: { href: string; label: string };
  /** An external destination, when the step has one. */
  link?: { href: string; label: string };
}

export interface InstallError {
  /** The literal text the installer sees. Matched against, not paraphrased. */
  text: string;
  /** What actually happened, and the one move that fixes it. */
  means: string;
}

export interface InstallCard {
  id: InstallPlatformId;
  title: string;
  /** One line: what this shape is good for, so an installer picks correctly. */
  suits: string;
  /** Marked so the page can fold the advanced shape under the primary one. */
  advanced?: true;
  steps: InstallStep[];
  /** Always present, always last, always `whoami`. */
  prove: InstallStep;
  errors: InstallError[];
  /** Non-fatal caveats. Never a fourth step. */
  notes: string[];
}

/**
 * The refusals an installer can actually produce, with the emitting module
 * named so a change there is traceable to the page that quotes it.
 *
 * The colocated test asserts each string against its emitter. If one of these
 * ever drifts, the install page starts lying — which is worse than saying
 * nothing, because the installer stops trusting the page and calls Wolf.
 */
export const INSTALL_ERRORS = {
  /** plugin-actions.ts, the charter refusal. */
  notInCharter: {
    text: "is not in this plugin's charter.",
    means:
      'The Actions schema was imported from a different tenant, or by hand. Re-import it from the schema URL on this page — never paste a saved copy.',
  },
  /** plugin-actions.ts, when nothing is promoted. */
  noManifest: {
    text: 'No active plugin manifest, so no tool is in charter yet.',
    means:
      'This tenant has not promoted a plugin bundle yet. Nothing you do in the chat app fixes this — tell the owner.',
  },
  /** mcp.ts, the auth refusal body. */
  unauthorized: {
    text: 'Unauthorized',
    means:
      'The connector has no valid token. Sign in when the first tool runs; if you already did, remove the connector and add it again.',
  },
  /** mcp.ts, the one refusal that is the TENANT\'s fault and not the caller\'s. */
  audienceMismatch: {
    text: 'audience_mismatch',
    means:
      'The token was minted through a hostname this deploy does not accept. Open the health URL on this page and send the owner what it lists under accepted_audiences.',
  },
  /** whoami\'s refusal for a member with no standing. */
  noStanding: {
    text: 'cannot create or change content',
    means: 'You are signed in, and your role here is read-only. Ask the owner for editor or publisher.',
  },
} as const satisfies Record<string, InstallError>;

/** The one step every card ends on. */
const proveStep = (facts: InstallFacts): InstallStep => ({
  do: `Ask it: "run whoami". It must answer with your e-mail, a role of editor or above, and a surface — not "unknown". If can_write is false, read the reason it gives and stop there; anything you write before fixing it will be refused when you try to publish. Check tools_digest reads ${facts.tools_digest}.`,
});

export const installCards = (facts: InstallFacts): InstallCard[] => [
  {
    id: 'openai-gpt',
    title: 'Add to ChatGPT',
    suits:
      'The everyday shape. Installs on your own ChatGPT plan, @-mentionable beside your other GPTs, and the tool charter is enforced on the tenant side.',
    steps: [
      facts.custom_gpt_url
        ? {
            do: `Open the ${facts.brand_name} GPT and add it to your sidebar.`,
            link: { href: facts.custom_gpt_url, label: 'Open the GPT' },
          }
        : {
            do: 'Create a new GPT, then Actions → Import from URL and paste this schema URL. (The owner has not published a shared GPT link for this tenant yet, so you build it once yourself.)',
            copy: facts.openapi_url,
          },
      {
        do: 'Run any tool once. ChatGPT asks you to sign in — sign in as the address your invitation was sent to. Leave the OAuth scope field EMPTY.',
      },
      { do: 'Set the publishing actions to ask for confirmation for the first week.' },
    ],
    prove: proveStep(facts),
    errors: [INSTALL_ERRORS.unauthorized, INSTALL_ERRORS.notInCharter, INSTALL_ERRORS.noStanding],
    notes: [
      'Signing in with a different address than the one that was invited authenticates fine and then fails every write. whoami is what catches it.',
    ],
  },
  {
    id: 'openai-agent',
    title: 'Add to ChatGPT — Agent Studio',
    advanced: true,
    suits:
      'For long multi-step runs. Invite-only, attaches the tenant MCP endpoint directly, and the charter is advisory rather than enforced.',
    steps: [
      {
        do: 'In Agent Studio, add an App and paste the tenant MCP URL.',
        copy: facts.mcp_url,
        ...(facts.agent_studio_url ? { link: { href: facts.agent_studio_url, label: 'Open the agent' } } : {}),
      },
      {
        do: 'Download the skill and paste it as the agent instructions. Remove any direct PDF-Tool app — this endpoint already carries those tools.',
        download: { href: facts.downloads.gpt, label: 'OpenAI config (both shapes)' },
      },
      { do: 'Sign in when the first tool runs, as the invited address.' },
    ],
    prove: proveStep(facts),
    errors: [INSTALL_ERRORS.unauthorized, INSTALL_ERRORS.audienceMismatch, INSTALL_ERRORS.noStanding],
    notes: [
      'Update is a step here. Agent Studio caches what it imported: when the tenant changes, re-add the App — whoami reports tools_digest_matches false when that is due.',
    ],
  },
  {
    id: 'claude',
    title: 'Add to Claude',
    suits: 'The skill and the connector install together, and Claude asks before each publishing action by default.',
    steps: [
      {
        do: 'Install the .plugin file — it carries the skill and the connector together. In Cowork: Plugins → install from file.',
        download: { href: facts.downloads.plugin, label: 'Download .plugin' },
      },
      {
        do: 'Or, without the .plugin: add a custom connector with this URL, and upload the skill zip to your org skills.',
        copy: facts.mcp_url,
        download: { href: facts.downloads.skill, label: 'Download skill zip' },
      },
      {
        do: 'Sign in when the first tool runs, as the address your invitation was sent to. There is no anonymous mode.',
      },
    ],
    prove: proveStep(facts),
    errors: [INSTALL_ERRORS.unauthorized, INSTALL_ERRORS.audienceMismatch, INSTALL_ERRORS.noStanding],
    notes: [
      'If you already had a connector for this tenant, delete it before adding this one. Duplicates authenticate independently and you cannot tell from the chat which one answered.',
    ],
  },
  {
    id: 'gemini',
    title: 'Gemini Gem',
    suits:
      'Drafting only. A Gem cannot call tools, so it can never reach this CMS — it writes, and you hand the draft to Claude or ChatGPT to publish.',
    steps: [
      {
        do: 'Download the Gem instructions and paste them into Gemini → Gems → new Gem → Instructions.',
        download: { href: facts.downloads.gemini, label: 'Download Gem instructions' },
      },
      { do: 'Draft there. When it is ready, paste it into your Claude or ChatGPT install to publish.' },
    ],
    prove: {
      do: 'There is nothing to prove here: a Gem holds no credential and reaches nothing. If a Gem ever tells you it published something, it did not.',
    },
    errors: [],
    notes: [
      'Write-only by construction, not by policy. The export says so in its own text so the model cannot claim otherwise.',
    ],
  },
];

/** The message the page shows when the tenant has promoted nothing yet. */
export const NO_MANIFEST_MESSAGE =
  'This tenant has not published a plugin bundle yet. An owner renders and promotes one on the admin plugins page; until then there is nothing to install.';
