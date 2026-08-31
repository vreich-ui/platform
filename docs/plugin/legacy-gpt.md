# W0.3 — Legacy ChatGPT Custom GPT seed

Filed 2026-08-31 from the planning chat's runner paste. This is the seed for `skill.md` (W1.2) and
the GPT export (W3.2). §A below verifies every technical claim in it against the code at HEAD —
**read §A before building anything from §B.**

Decisions carried in with the paste (Wolf):
- Sources: every `content_item` ends with a Sources block; missing sources WARN the editor, never block.
- Urgency/scarcity: implied, sparing, funnel-stage dependent. `voice_drlurie.cta_policy` already edited to match.
- Bridge: the existing GPT reaches the tenant through the **CMS-Agent MCP** (`project.call_tool` pass-through), not a third party.
- The façade path prefix and OAuth URLs in the schema were proposals — replaced in §A.

---

# §A — Verification against code (2026-08-31)

## A.1 Confirmed correct

| Claim in the seed | Verified |
|---|---|
| Publish sequence, order and semantics | Matches `docs/agents/publishing-policy.md` §4 exactly |
| Six patch ops (`set_article_meta`, `upsert_node`, `update_node`, `move_node`, `set_node_visibility`, `remove_node`) | All present in `packages/core/schema/object-patch-ops.ts` |
| `object_validate` accepts a candidate `body` + `requested_id` with no `object_id` | `mcp.ts:1111–1119` forwards `body`, `candidate_patch`, `requested_id` |
| `object_checkout` returns `lockToken` (camel) while inputs are `lock_token` (snake) | `object-lock.ts:190` returns `{action:'checkout', lockToken, lock}`; tool description confirms |
| `list_artifacts_for_request` takes `requestId` (camel) | Confirmed — the casing really is inconsistent with the object verbs |
| `release_to_production` args `{commit, force_build, timeout_seconds, idempotency_key}` | Exact match |
| `get_agent_artifact_job_status` args `{site_id, request_id, job_id}` | Exact match |
| `object_publish.producer` `{run_id,node_id,prompt_version,model}`, all four required | Exact match — and it is recorded in publish history |
| `agent_name` accepted on create / checkout / checkin | Yes — the full set is the 10 tools in `CMS_AGENT_NAME_ATTRIBUTION_TOOLS` (`mcp.ts:797–812`) |
| `object_patch` / `object_publish` correctly omit `agent_name` | Correct — they do not accept it (see `recon-mcp.md` §4.1) |

## A.2 Corrections to make before W3.2

**1. OAuth URLs — replace the placeholders.**

```
authorizationUrl  https://drluriescience.netlify.app/oauth/authorize
tokenUrl          https://drluriescience.netlify.app/oauth/token
```
Also live: `/oauth/register` (dynamic client registration), `/oauth/revoke`, `/oauth/consent`.
Discovery: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`.
The consent **screen** is `/admin/authorize` (an admin shell route), not an `/oauth/*` endpoint.
Source: `netlify.toml:113–132`, `mcp-oauth.ts:17–22,127–131`.

⚠️ **Do not invent the `publish` scope.** The server echoes whatever scope the registered client
describes (`mcp-oauth.ts:327`). Read `/.well-known/oauth-authorization-server` for the advertised
set and use that. GPT Actions needs a *static* `client_id`/`client_secret`, so a client must be
registered once through `/oauth/register` and the pair pasted into GPT Builder — that is a **CFG**
step for W3.4, not code.

**2. `verify_article_images` is missing `expectedDocuments` — a real gap.**
The tool accepts `{url, expectedImages, expectedDocuments, commit, deployTimeoutSeconds, deployPollIntervalSeconds}`.
The seed's schema declares only four of those with `additionalProperties:false`, so **a PDF lead
magnet can never be verified through the façade as drafted** — which contradicts the instructions'
own step 6 (PDF attachment) and step 12. Documents come back under `documents` and are asserted as
`<a href>`/`<object data>` fetching `application/pdf`, never as `<img>`. Add both fields.

**3. `create_agent_artifact_job` is missing `operation` (and `model`, `seed`, `loras`).**
Full arg set: `site_id, request_id, artifact_kind, operation, prompt, filename, slot, model,
requirements, template_id, data, assets, negative_prompt, seed, loras, wait, idempotency_key`.
With `additionalProperties:false` any arg the schema omits is unreachable from the GPT. Declare at
least `operation`.

**4. `object_refresh_lock` is absent from the façade — add it.**
The lease is 900 s by default. A human-in-the-loop drafting session routinely runs longer between
`object_checkout` and `object_publish`, and the instructions have no refresh step. Add the tool and
a step: refresh before publishing if the checkout is older than ~10 minutes. Without it the flow
423s at the last step and the human loses the draft position.

**5. Generate the `object_type` enum, don't hardcode it.**
The seed repeats a 12-value enum in nine places. It must be emitted from `OBJECT_CONTRACT_TYPES`
(`packages/core/lib/registry/object-contract.ts:1099`) by the W3.1 generator, or it silently drifts
the first time a type is added.

**6. `agent_name` also belongs on `object_create_variant`** if the plugin ever writes a variant
(A/B article variants are on the admin roadmap). Not urgent.

## A.3 Two findings the seed does not know about

### A.3.1 The Sources decision needs no code — but a *different* ART-2 rule can block the plugin

Wolf's instruction was to downgrade ART-2 to a warning for `plugin:*` actors if it blocks publish.
**It already is a warning, for everyone.** `article_claim_substrate` is
`severity: 'warns'`, and `object-validate.ts:2166` says so in terms:
*"ART-2 — visibility on the claim substrate, deliberately NOT a publish block."*
No change required. Decision closed.

**But there is a second ART-2 rule that does block, and it is aimed exactly at this plugin:**

> `article_claim_verification` — **`severity: 'blocks_publish'`**. IF the body carries claims, no
> claim marked risk `"high"` may go live while its status is unverified, disputed or retracted, or
> while it carries no `source_ids`. An omitted status reads as `"unverified"`.
> *"Under D7 the workflow writes no claims here, so this bites a hand-authored body only."*
> (`object-contract.ts:539`)

The plugin **is** the hand-authored path. Rule for `skill.md`, stated as a hard rule:

> Write `sources` into the body. **Never write `claims`.** A `claims` array with any high-risk entry
> that lacks an explicit cleared status and `source_ids` blocks the publish — and the plugin has no
> readiness report to clear it from.

### A.3.2 ART-1 — the plugin reopens the door admin chat closed. **Wolf's decision.**

`object_create` for `content_item` is refused **in admin chat** (`agent/generated-tools.ts`), on the
reasoning that a new article comes from the publishing workflow, *"which is what builds the
sourcing/claim/compliance record ART-2 requires to publish and applies the aggression ceiling"*
(`mcp-tool-definitions-2.ts:57`).

That refusal is **chat-registry-only**. On the MCP surface:
- `mcp.ts` has no `content_item` guard on `object_create`;
- drlurie's `creation-policy.ts` is `master: 'open'`, with allowlists on `tracking_config` and
  `editorial_voice` only.

**So the seed's flow works as written — the plugin can create and publish a `content_item` over
`/mcp` today.** But note what it skips, from `object-contract.ts:940`:

> *"the aggression ceiling is enforced **only on that path**"* (the workflow).

The plugin reads `aggression_ceiling` and clamps itself (seed §2). Nothing enforces it. Same for the
sourcing/claim/compliance record: the plugin produces none, and no gate demands one.

This is the plan's Risks §5 — *"Do not accept a plugin-only side door"* — made concrete. Three ways:

- **(a) Ship it. Honour-system ceiling, human in the loop.** The plugin is human-driven by
  definition; the editor is the gate. Fastest, and matches the "audience = you + team only" decision.
- **(b) Route the plugin through the CMS-Agent workflow** (`run_workspace_workflow → … →
  release_workspace_run`) instead of the object verbs. Closes the gap properly, and the plugin
  inherits the ceiling clamp and the readiness record for free. But it is a different, slower,
  asynchronous contract, it discards most of the seed, and it puts cms-agent back in the path the
  plan deliberately took it out of.
- **(c) Ship (a) now, add server-side ceiling enforcement to `object_validate` later** so every
  hand-authored path is clamped regardless of actor.

**Recommendation: (a) now, (c) as the follow-on.** (b) is the "correct" answer and the wrong trade
this cycle — it costs the whole W3 wave to close a gap that a human editor is already standing in.
But (a) should be recorded as a deliberate exception in `ARCHITECTURE.md` (W5.3), not left implicit.

## A.4 The two open questions from the paste

**Façade location → platform.** The tenant's tool handlers live in
`packages/core/server/lib/mcp-tool-handlers.ts` in **platform**, so `/api/plugin/{tool}` forwarding
"to the same handlers as `/mcp`" is a real in-process call. In cms-agent it would be a network hop
through `project.call_tool` with a second credential, added latency, and a repo that
`publishing-policy.md` §2 explicitly says *"is not the publishing backend and must not impersonate
it."* The paste's default stands.

**Path shape → keep the seed's `/api/plugin/{tool}`, not the plan's `/api/plugin/act/{tool}`.**
One path per tool gives each op its own `operationId`, summary and
`x-openai-isConsequential` flag, which is what makes ChatGPT call them correctly and prompt only on
writes. A single `act/{tool}` path collapses all of that into one operation. `netlify.toml` needs
one redirect per path or a `/api/plugin/*` splat to the façade function.

**How the legacy GPT is attached** was not in the paste. Still needed for W3.4 (retiring the bridge):
whether the current GPT uses Actions/OpenAPI against cms-agent or a workspace MCP app, and which
credential it holds.

## A.5 One improvement to W1.3

`tools.json` does not need to invent a policy vocabulary. **Every tool definition already carries
`governance: { toolClass, autonomyFloor?, preview? }`** —
`toolClass ∈ read | draft | creation | publication | privileged | membership`, with
`autonomyFloor: 'ask'` as a hard floor no override may promote (`mcp.ts:276–289`).

Today it is consumed only by the admin-chat registry (`agent/registry.ts`, `agent/generated-tools.ts`);
`mcp.ts` declares the type but does not enforce it. So:
- W1.3 should **derive** `tools.json` from `governance.toolClass` rather than hand-maintain an allowlist;
- the `x-openai-isConsequential` flag in the Actions schema should be `toolClass !== 'read'` —
  computed, not hand-set;
- if server-side enforcement is ever wanted, the dispatcher reads the field that is already there.

This also corrects `recon-mcp.md` §4.2: a per-tool policy **taxonomy** exists and is well-specified.
What does not exist is per-*client* per-tool enforcement on the MCP path.

---

# §B — The seed, verbatim

## FILE 1 — GPT instructions (paste into GPT Builder → Instructions; 8k limit)

# Dr. Lurie Publisher — Custom GPT instructions (tenant: drlurie, site_id: site_drlurie)

You are the publishing desk for drluriescience.netlify.app. You write articles in the Dr. Lurie editorial voice using direct-response (Magnetic Marketing) structure, and you publish them to the site through your Actions. A human drives you; you never publish without their explicit "publish".

## 0. Session start (once)
1. `object_get {object_type:"editorial_voice", object_id:"voice_drlurie"}` → this is the voice. Obey tone, lexicon, claim_policy, cta_policy, reader_safety_notes, frameworks.
2. `object_contract {object_type:"content_item"}` → note `aggression_ceiling` (claim_strength, urgency, emotional_agitation, cta_density — each 0–1, a CEILING not a target), `media_policy`, allowed patch ops, publish_policy.
If either call fails, say so and stop — never write from memory of the voice.

## 1. Voice
The live `editorial_voice` object is the voice — tone, cadence, lexicon prefer/avoid, claim_policy, cta_policy, reader_safety_notes, frameworks. Apply all of it. Quick anchors: warm, calm, evidence-led, non-alarmist; ≤ 4-sentence paragraphs; claims hedged to evidence and attributed; no treat/cure/prevent/diagnose; one ask per article; see-a-professional boundary in the body for pregnancy, minors, prescription actives, procedures.

## 2. Direct-response method — married to the voice, dialed by funnel stage
Voice = tone and reader safety (never negotiable). Magnetic Marketing = structure and intent. `aggression_ceiling` = the hard upper bound. Between floor and ceiling, the funnel stage sets the dial — ask the human for the stage in the brief.

| Stage | Reader | Dial | Offer |
|---|---|---|---|
| TOP — trust | arrived from search with a worry | ~0.3 of ceiling: educate, prove, reassure; no pressure | one soft ask: next article or free guide |
| MID — consider | knows the problem, weighing options | ~0.6: comparison, proof, "what not to waste money on", one clear recommendation | lead magnet (PDF), consult a clinician |
| SALES — convert | product/offer page or article written to sell | up to ceiling: vivid problem → relief, specific offer, one path | the offer itself, low-threshold entry first |

Rules at every stage:
- Market → message → media: name the reader's exact worry before writing a word. Kennedy: trust first, then sell — the stage table is that rule.
- Always an offer (rule 1): every article ends with exactly one ask; the stage decides how strong.
- Clear instructions (rule 3): one path, one action node, no competing links.
- Strong copy (rule 7): make the problem vivid through the reader's own experience, then relieve it with evidence. Vivid ≠ alarmist.
- Urgency/scarcity (rule 2): **implied, never literal.** Hint through consequence and timing ("the barrier repairs slowest in winter", "most people wait a year longer than they should", "the guide covers the next three weeks"). Never countdowns, "last chance", "only N left", "act now", or a purchase framed as a health necessity. Use a hint at most once per article, and not in TOP-stage pieces.
- Tracking is the site owner's; never invent tracking fields.

## 3. Drafting flow (in chat / canvas)
1. Brief: topic, reader's worry, search intent. Pick a framework from the voice object (default fw_concern). Say which and why in one line.
2. Draft in canvas as functional blocks, one per beat. Each block gets: a private strategy tag ∈ {hook, agitation, context, explanation, proof, example, comparison, myth, step, recommendation, resolution, summary} and intent ∈ {educate, persuade, reassure, convert, navigate}. The CTA is a separate ACTION block (intent convert) — never a strategy tag.
3. Also draft: title, slug (kebab-case), deck (1–2 lines), description (meta), hero image subject (subject only — no style words; the site adds its style), optional PDF lead magnet (needs a published template — check `list_pdf_templates`).
4. Sources: end every article with a "Sources" block listing the evidence behind each claim (author/journal/year + https link). Also carry them as `sources[]` in the body. If any claim has no source, WARN the human listing the unsourced claims — sourcing is the editor's call; you never block on it and never invent a source.
5. Show the draft. Iterate until the human says "publish". Nothing below runs before that.

## 4. Publish flow (Actions — exact order)
Pick `request_id` = `req_gpt_<topic>_<yyyymmdd>_<nn>` (lowercase snake, today's date, nn 01–99). Reuse `agent_name:"plugin:openai"` everywhere it is accepted.
1. `object_inventory {object_type:"content_item"}` — confirm the id and slug are unused.
2. Build body: `{slug, title, deck, description, nodes:[…], sources:[…], taxonomy?, seo?, editorial:{framework, writer_notes}}` (last content node = the Sources block).
   Node: `{kind:"content", visibility:"public", public:{title, body}, private:{strategy, intent}}` — omit `id` (server mints). body = rich_text.v1 (paragraph / heading-2 / heading-3 / lists / blockquote; marks bold, italic; links https only). CTA node: `{kind:"action", public:{title, body, ctaText, ctaLink}, private:{intent:"convert"}}`.
   Never put strategy words in visible text. Never use hook/agitation/cta/advert/offer in any id.
3. `object_validate {object_type:"content_item", body, requested_id}` — fix every blocker.
4. `object_create {object_type:"content_item", site:"site_drlurie", requested_id, body, agent_name}`.
5. `object_checkout` → keep `lockToken` and `record_version`.
6. Media: `create_agent_artifact_job {site_id, request_id, artifact_kind:"image", filename:"hero.webp", slot:"img_hero", prompt:<subject>, requirements:{maxBytes:153600, image:{outputFormat:"webp", size:"1536x1024", usageContext:"article_body"}}}`. If not complete inline, poll `get_agent_artifact_job_status`. Use the returned `public_path` (`/img/...`) — never a raw `image/...` key, never a URL. PDF: same call with `artifact_kind:"pdf"`, `template_id`, `data`; use `/pdf/...` in the action node's ctaLink or a `media {type:"document"}`. A PDF is never the hero.
   Media failure → stop, report, do not publish a degraded article.
7. `object_patch {…, lock_token, expected_record_version, ops:[{op:"set_article_meta", fields:{image:{src:"/img/…", alt:"…"}}}]}` (+ any node media). Use the new record_version from each response.
8. `object_validate {object_type:"content_item", object_id}` — must be clean.
9. `object_publish {object_type:"content_item", object_id, lock_token, producer:{run_id:"plugin_openai_"+request_id, node_id:"plugin:openai", prompt_version:"gpt-v0.1", model:"<your model>"}}` → dark commit, NOT live. Keep `commit_sha` and `production.article_path`.
10. `object_checkin`.
11. Ask: "Release now, or batch more articles first?" (release costs a build). On "release": `release_to_production {idempotency_key:request_id}`; then poll `deploy_status {commit}` every ~15 s until `deployStatus:"ready"` AND `productionConfirmed:true` (up to ~5 min). `build_not_confirmed_live` on the first call is normal — poll, don't re-release.
12. `verify_article_images {url:<site>+article_path, expectedImages:["/img/…"], commit}` — `inconclusive` = not live yet, retry; only `deployReady:true` is final.
13. Report: live URL, request_id, commit, what was verified.

## 5. Hard rules
- Read-only on `editorial_voice`, `product`, `site`, templates, taxonomy. Never patch or publish them.
- Never edit an article you did not create in this session without the human naming it.
- 423 → checkout again. 409 → re-read and retry once. `creation_restricted` / `approval_required` → stop and tell the human exactly which gate.
- On a timeout or 502 of a write, retry once with the SAME idempotency_key; never re-issue blind.
- Report honestly: published ≠ released ≠ verified. Say which state you reached.


---

## FILE 2 — Actions schema (paste into GPT Builder → Actions → Schema)

```json
{
 "openapi": "3.1.0",
 "info": {
  "title": "Dr. Lurie publishing fa\u00e7ade (tenant drlurie)",
  "version": "0.1.0",
  "description": "REST fa\u00e7ade over the tenant /mcp tools for ChatGPT Actions. Each path forwards its JSON body verbatim to the same-named MCP tool and returns the tool result. Built in plan wave W3.1 (vreich-ui/platform)."
 },
 "servers": [
  {
   "url": "https://drluriescience.netlify.app"
  }
 ],
 "security": [
  {
   "tenantOAuth": []
  }
 ],
 "components": {
  "securitySchemes": {
   "tenantOAuth": {
    "type": "oauth2",
    "flows": {
     "authorizationCode": {
      "authorizationUrl": "https://drluriescience.netlify.app/OAUTH_AUTHORIZE_PATH_FROM_mcp-oauth.ts",
      "tokenUrl": "https://drluriescience.netlify.app/OAUTH_TOKEN_PATH_FROM_mcp-oauth.ts",
      "scopes": {
       "publish": "read + write + release on this tenant"
      }
     }
    }
   }
  }
 },
 "tags": [
  {
   "name": "read"
  },
  {
   "name": "write"
  },
  {
   "name": "release"
  }
 ],
 "paths": {
  "/api/plugin/object_contract": {
   "post": {
    "operationId": "object_contract",
    "summary": "Read the full contract for an object type FIRST (schema, patch ops, constraints, publish_policy, media_policy, aggression_ceiling).",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         }
        },
        "required": [
         "object_type"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_get": {
   "post": {
    "operationId": "object_get",
    "summary": "Fetch one CMS object (e.g. editorial_voice voice_drlurie).",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         }
        },
        "required": [
         "object_type",
         "object_id"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_inventory": {
   "post": {
    "operationId": "object_inventory",
    "summary": "Reuse-first index: ids, status, lock, unpublished_changes; recipe summaries for templates.",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         },
         "status": {
          "type": "string",
          "enum": [
           "active",
           "archived"
          ]
         },
         "pending_changes": {
          "type": "boolean"
         }
        },
        "required": [],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_list": {
   "post": {
    "operationId": "object_list",
    "summary": "List object summaries for a type.",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "status": {
          "type": "string",
          "enum": [
           "active",
           "archived"
          ]
         }
        },
        "required": [
         "object_type"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/registry_get": {
   "post": {
    "operationId": "registry_get",
    "summary": "Read the page_type or component (section type) registry.",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "registry": {
          "type": "string",
          "enum": [
           "component",
           "page_type"
          ]
         }
        },
        "required": [],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/list_pdf_templates": {
   "post": {
    "operationId": "list_pdf_templates",
    "summary": "List published PDF templates (preflight before a PDF job).",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/list_artifacts_for_request": {
   "post": {
    "operationId": "list_artifacts_for_request",
    "summary": "List artifact references (images/PDFs) already produced for a request id.",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "requestId": {
          "type": "string"
         }
        },
        "required": [
         "requestId"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/create_agent_artifact_job": {
   "post": {
    "operationId": "create_agent_artifact_job",
    "summary": "Generate an image or render a PDF for an EXISTING article id. Image: prompt = subject only. PDF: template_id + data.",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "site_id": {
          "type": "string",
          "description": "e.g. site_drlurie"
         },
         "request_id": {
          "type": "string",
          "description": "Existing content_item id (req_...)"
         },
         "artifact_kind": {
          "type": "string",
          "enum": [
           "image",
           "pdf"
          ]
         },
         "filename": {
          "type": "string",
          "description": "e.g. hero.webp / guide.pdf"
         },
         "slot": {
          "type": "string",
          "description": "e.g. img_hero, img_body_1, pdf_guide"
         },
         "prompt": {
          "type": "string",
          "description": "Image subject only; site style is added server-side"
         },
         "negative_prompt": {
          "type": "string"
         },
         "template_id": {
          "type": "string",
          "description": "Published pdf_template id (PDF only)"
         },
         "data": {
          "type": "object",
          "additionalProperties": true,
          "description": "PDF template data"
         },
         "assets": {
          "type": "object",
          "additionalProperties": true
         },
         "requirements": {
          "type": "object",
          "additionalProperties": true,
          "description": "e.g. {\"maxBytes\":153600,\"image\":{\"outputFormat\":\"webp\",\"size\":\"1536x1024\",\"usageContext\":\"article_body\"}}"
         },
         "wait": {
          "type": "boolean",
          "description": "default true \u2014 returns completed artifact inline when fast"
         },
         "idempotency_key": {
          "type": "string"
         }
        },
        "required": [
         "site_id",
         "request_id",
         "artifact_kind",
         "filename"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/get_agent_artifact_job_status": {
   "post": {
    "operationId": "get_agent_artifact_job_status",
    "summary": "Poll an artifact job; on completion returns public_path (/img/... or /pdf/...).",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "site_id": {
          "type": "string"
         },
         "request_id": {
          "type": "string"
         },
         "job_id": {
          "type": "string"
         }
        },
        "required": [
         "site_id",
         "request_id",
         "job_id"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_validate": {
   "post": {
    "operationId": "object_validate",
    "summary": "Dry-run: validate a candidate body (no object_id) or candidate_patch ops on an existing object. Read-only.",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         },
         "body": {
          "type": "object",
          "additionalProperties": true
         },
         "candidate_patch": {
          "type": "array",
          "items": {
           "type": "object",
           "additionalProperties": true
          }
         },
         "requested_id": {
          "type": "string"
         }
        },
        "required": [
         "object_type"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_create": {
   "post": {
    "operationId": "object_create",
    "summary": "Create the article object. object_type content_item, requested_id = req_<flow>_<topic>_<yyyymmdd>_<nn>.",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "site": {
          "type": "string",
          "description": "site_drlurie"
         },
         "body": {
          "type": "object",
          "additionalProperties": true,
          "description": "content_item.v1 body: slug,title,nodes[,deck,description,image,taxonomy,seo,editorial]"
         },
         "requested_id": {
          "type": "string"
         },
         "agent_name": {
          "type": "string",
          "description": "plugin:openai"
         },
         "idempotency_key": {
          "type": "string"
         }
        },
        "required": [
         "object_type",
         "site",
         "body"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_checkout": {
   "post": {
    "operationId": "object_checkout",
    "summary": "Take the lock. Returns lockToken + record_version.",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         },
         "agent_name": {
          "type": "string",
          "description": "plugin:openai"
         },
         "lease_seconds": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3600
         }
        },
        "required": [
         "object_type",
         "object_id"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_patch": {
   "post": {
    "operationId": "object_patch",
    "summary": "Apply typed ops under lock: set_article_meta, upsert_node, update_node, move_node, set_node_visibility, remove_node.",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         },
         "lock_token": {
          "type": "string"
         },
         "expected_record_version": {
          "type": "integer",
          "minimum": 0
         },
         "ops": {
          "type": "array",
          "items": {
           "type": "object",
           "additionalProperties": true
          }
         }
        },
        "required": [
         "object_type",
         "object_id",
         "lock_token",
         "expected_record_version",
         "ops"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_publish": {
   "post": {
    "operationId": "object_publish",
    "summary": "Dark publish (commits with [skip netlify], NOT live yet). Keeps the lock \u2014 call object_checkin after.",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         },
         "lock_token": {
          "type": "string"
         },
         "producer": {
          "type": "object",
          "properties": {
           "run_id": {
            "type": "string"
           },
           "node_id": {
            "type": "string",
            "description": "plugin:openai"
           },
           "prompt_version": {
            "type": "string",
            "description": "manifest version"
           },
           "model": {
            "type": "string"
           }
          },
          "required": [
           "run_id",
           "node_id",
           "prompt_version",
           "model"
          ],
          "additionalProperties": false
         },
         "release_build": {
          "type": "string",
          "enum": [
           "defer",
           "release"
          ]
         },
         "idempotency_key": {
          "type": "string"
         }
        },
        "required": [
         "object_type",
         "object_id",
         "lock_token"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_checkin": {
   "post": {
    "operationId": "object_checkin",
    "summary": "Release the lock.",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         },
         "lock_token": {
          "type": "string"
         },
         "agent_name": {
          "type": "string"
         }
        },
        "required": [
         "object_type",
         "object_id",
         "lock_token"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_discard": {
   "post": {
    "operationId": "object_discard",
    "summary": "Undo rejected draft ops by inverse (needs lock + exact history entries).",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "object_type": {
          "type": "string",
          "enum": [
           "page",
           "section",
           "navigation",
           "taxonomy",
           "site",
           "template",
           "section_template",
           "theme",
           "product",
           "content_item",
           "tracking_config",
           "editorial_voice"
          ]
         },
         "object_id": {
          "type": "string"
         },
         "lock_token": {
          "type": "string"
         },
         "entries": {
          "type": "array",
          "items": {
           "type": "object",
           "properties": {
            "op": {
             "type": "object",
             "additionalProperties": true
            },
            "capture": {}
           },
           "required": [
            "op",
            "capture"
           ]
          }
         }
        },
        "required": [
         "object_type",
         "object_id",
         "lock_token",
         "entries"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/object_instantiate_template": {
   "post": {
    "operationId": "object_instantiate_template",
    "summary": "Create a page from an existing template recipe (tpl_landing, tpl_interior, tpl_legal). dry_run true to preview.",
    "tags": [
     "write"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "template_id": {
          "type": "string"
         },
         "site": {
          "type": "string"
         },
         "route": {
          "type": "string",
          "description": "/offer-slug"
         },
         "title": {
          "type": "string"
         },
         "page_type": {
          "type": "string",
          "enum": [
           "home",
           "standard",
           "listing",
           "content_detail",
           "system",
           "clone"
          ]
         },
         "seo": {
          "type": "object",
          "additionalProperties": true
         },
         "requested_id": {
          "type": "string"
         },
         "dry_run": {
          "type": "boolean"
         },
         "agent_name": {
          "type": "string"
         }
        },
        "required": [
         "template_id",
         "site",
         "route",
         "title"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/release_to_production": {
   "post": {
    "operationId": "release_to_production",
    "summary": "ONE paid build for the whole batch. First call usually returns build_not_confirmed_live \u2014 then poll deploy_status.",
    "tags": [
     "release"
    ],
    "x-openai-isConsequential": true,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "commit": {
          "type": "string"
         },
         "force_build": {
          "type": "boolean"
         },
         "timeout_seconds": {
          "type": "integer",
          "minimum": 1
         },
         "idempotency_key": {
          "type": "string"
         }
        },
        "required": [],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/deploy_status": {
   "post": {
    "operationId": "deploy_status",
    "summary": "Poll until deployStatus == ready AND productionConfirmed == true.",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "commit": {
          "type": "string"
         },
         "deployId": {
          "type": "string"
         }
        },
        "required": [],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  },
  "/api/plugin/verify_article_images": {
   "post": {
    "operationId": "verify_article_images",
    "summary": "After release: confirm the live page shows the expected /img/... paths (and /pdf/...).",
    "tags": [
     "read"
    ],
    "x-openai-isConsequential": false,
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "url": {
          "type": "string"
         },
         "expectedImages": {
          "type": "array",
          "items": {
           "type": "string"
          }
         },
         "commit": {
          "type": "string"
         },
         "deployTimeoutSeconds": {
          "type": "integer",
          "minimum": 0,
          "maximum": 120
         }
        },
        "required": [
         "url",
         "expectedImages"
        ],
        "additionalProperties": false
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Tool result (JSON, same shape as the tenant /mcp tool result)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     },
     "4XX": {
      "description": "Two-layer error envelope {code, message, details}",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "additionalProperties": true
        }
       }
      }
     }
    }
   }
  }
 }
}
```
