# W2 acceptance run — 2026-08-31

Run by Claude acting as `plugin:claude` against the live drlurie tenant `/mcp`, following the
rendered SKILL.md. Deploy under test: `dc69162` (W2 merge), `productionConfirmed: true`.

**Result: the publish path works end to end. Stopped at the dark commit, before release, because
the skill itself says to ask.** Four defects found, two of them real bugs in what W1/W2 shipped.

Artifact: `req_plugin_stinging_20260831_01` — *"Why a new product stings — and what that sting does
not tell you"*, `/why-new-skincare-stings`, published dark at commit `c7f3b041`.

---

## What passed

| step | result |
|---|---|
| Session start — live voice read | ✅ `voice_drlurie` read; tone/lexicon/cta_policy applied |
| `object_contract` — ceiling read | ✅ claim_strength 0.45, urgency 0.10, emotional_agitation 0.15, cta_density 0.20 |
| Draft — blocks, one CTA, Sources | ✅ 10 nodes, strategy+intent on each, one action node, 3 real peer-reviewed sources |
| Dry-run `object_validate` (candidate body) | ✅ `eligible: true`, 0 blockers |
| `object_create` | ✅ history actor `agent_name: "plugin:claude"` |
| Hero image via artifact bridge | ✅ verified, 15,618 bytes (budget 153,600), `/img/…/004f5820….webp`, $0.0094 |
| `object_checkout` | ✅ lock owner `plugin:claude`, 1800 s lease |
| `object_patch` ×2 | ✅ 10 nodes + hero, version 2 → 12 |
| `object_validate` (live object) | ✅ 0 blockers; `artifact_trust`, `media_budget`, `article_media` all complete |
| `object_publish` | ✅ dark commit `[skip netlify]`, `live: false`, `/why-new-skincare-stings` |
| `object_checkin` | ✅ lock released, `unpublished_changes: false` |
| Duplicate-publish check | ✅ exactly one export commit on main |

**The idempotency contract proved itself under real failure.** `object_publish` returned a 502 mid-
call; the retry with the same `idempotency_key` came back
`replayed_from_idempotency_key: true, original_result_at: 13:39:40.627Z` — the first call HAD landed,
and the retry replayed its receipt instead of publishing twice. Git confirms one commit, not two.
This is QA-W16-1 working exactly as designed, verified against a genuine transport failure rather
than a simulated one.

## Defect 1 — the skill's publish procedure was in the wrong order (FIXED)

`create_agent_artifact_job` is scoped to an **existing** content_item:

> `Artifact request mapping is absent: content_item req_plugin_stinging_20260831_01 does not exist
> on site_drlurie. Create or select the owning content object before requesting artifacts.`

The rendered skill said **"2. Media first, and fail closed"** — *before* `object_create`. A plugin
following it verbatim dies at its first tool call.

The skill inherited this from `docs/agents/publishing-policy.md` §4, whose canonical sequence also
lists "2. Produce media FIRST … 3. object_create". **That doc is wrong on this point too**, and
should be corrected separately — it is the upstream source every agent reads.

Fixed in `render-skill.ts`: create → checkout → media → patch. The fail-closed rule survives,
restated as what it actually means ("no publish without the media you promised, not media first").
Regression test pins the ordering.

## Defect 2 — `agent_name` on `object_patch`/`object_publish` is unreachable from a Claude client

W1.0 is merged and deployed. But the tool schema the Claude connector advertises for `object_patch`
carries `additionalProperties: false` and **no `agent_name` property**, so the argument cannot be
sent at all. A `RefreshMcpTools` call reported `refreshed` with no additions or removals — it
reconciles the tool *list*, not changed schemas on existing tools.

Consequence, visible in this run's ledger: `create`, `checkout` and `checkin` carry
`plugin:claude`; `patch` and `publish` do not. W1.0's server half is live and its client half is not
yet reachable.

Not a code defect — an operational one. Before the W3 contract tests assert on attribution,
confirm the connector has picked up the new schema (drop the connector and re-add it, or wait out
the cache). **`producer` is unaffected** and remains the reliable publish-time attribution seam,
which is why the skill leans on it.

## Defect 3 — large payloads 502 through the connector

Four 502s, all on the largest calls: the full-body `object_create`, `object_validate` on a complete
article, and `object_get` on a complete article. `object_get` failed twice with a 60-second backoff
between attempts — it is currently **unusable** for a finished article through this connector, which
matters because revising an existing article naturally starts with reading it.

Mitigations now in the skill: keep `object_create` small and attach the body by patch; split long
articles across several patches; treat a transport error as *unknown* rather than *failed* and check
state before retrying.

## Defect 4 — the ART-2 sourcing warning cannot be cleared by supplying sources

`article_claim_substrate` warns when the body carries "no `sources.source_list` / `claims.claim_list`".
This article carries three real sources — and still warns, because the check is satisfied only by
`claims`, which the skill deliberately forbids (writing `claims` risks tripping
`article_claim_verification`, which blocks publish).

So for the plugin path this warning is **permanent and unclearable by design**. That is acceptable —
it is a warning — but it should not be presented to an operator as an action item, and the warning
text ("no claims recorded") is misleading when a source list is present.

## Open question for Wolf

The derived export committed to git retains `node.private` (strategy/intent) for all 10 nodes. The
constraint's promise is specifically that private annotations never reach **reader HTML**, and that
holds. But if `vreich-ui/platform` is a public repository, the persuasion architecture of every
article is publicly readable in git even though it never renders. Worth confirming the repo's
visibility, and deciding whether the export should strip `private` on the way to git.

## Not run

Release, deploy poll, and `verify_article_images` — the release spends a build and puts the article
live. The skill instructs the plugin to ask first, so it asked.

To finish: `release_to_production {idempotency_key:"req_plugin_stinging_20260831_01"}` → poll
`deploy_status {commit:"c7f3b041b4a371c6290dd04fcd4099518b8c67ae"}` to `ready` + `productionConfirmed`
→ `verify_article_images {url:"https://drluriescience.netlify.app/why-new-skincare-stings",
expectedImages:["/img/req_plugin_stinging_20260831_01/004f5820e9ed5c13929e5aa7ea3f333b897db9b0b4eae7ff37773125593f428d.webp"],
commit:"c7f3b041…"}`.
