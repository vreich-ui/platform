# W6 acceptance run — 2026-09-03

**Run by the ChatGPT Agent Studio agent as `plugin:openai-agent`, against the live drlurie tenant
`/mcp`. Driven from ChatGPT, outside the session that fixed W6 and wrote this document.** That
matters for how the evidence below should be read: the steps were not scripted by the author, the
verification was done afterwards against the live tenant and the committed exports, and one finding
(§Defect) is a defect in what W6 itself shipped.

Artifact: `req_plugin_moisturizer_functions_20260903_01` — *"What Moisturizers Actually Do:
Humectants, Emollients, and Occlusives"*, `/what-moisturizers-actually-do`, **released and live**.

**Result: the full plugin path works end to end, including release, images and a PDF. D3, D4 and Q
are confirmed on live production data rather than on fixtures. One new defect: attribution
degrades to `unattributed-agent` after the first call.**

---

## The run

Created 13:21:49Z, published three times (13:24:56, 13:38:55, 13:47:30), released. 13 nodes,
content_revision 8, version 17.

| step | result |
|---|---|
| `object_create` | ✅ actor `plugin:openai-agent` — the installed ChatGPT agent |
| Sourcing | ✅ 3 real DOI-cited sources (Lodén 2003, Rawlings & Harding 2004, Purnamawati 2017) |
| Body | ✅ 13 nodes, `private.strategy` + `private.intent` on every one, exactly one action node |
| Images via the artifact bridge | ✅ hero + 2 in-body, `/img/{id}/{sha256}.webp`, 32–61 KB (budget 153,600) |
| **PDF via the artifact bridge** | ✅ `/pdf/…/c90a53be….pdf`, 28,934 bytes, as a `type:"document"` media node |
| Image/PDF revision under lock | ✅ two rounds of `update_node` replacing placeholder art with photographic art |
| `object_publish` ×3 | ✅ dark commits `[skip netlify]` — `5f924ef`, `96d9f36`, `e1eed1a` |
| `object_checkin` | ✅ released after each round; lock free at rest |
| `release_to_production` | ✅ production serves it |

Live checks, 2026-09-03:

```
/what-moisturizers-actually-do/                          200
/img/req_plugin_moisturizer…/d913a7c8….webp              200
/pdf/req_plugin_moisturizer…/c90a53be….pdf               200
```

This is the first plugin-path article to carry a **PDF** through the tenant's server-side artifact
bridge, which is also the first live exercise of the bridge replacing a directly-attached PDF-Tool
app.

---

## D3 — bounded reads, confirmed live

`object_get {projection:"summary"}` against the live tenant returns the envelope, `node_count`, one
`{id, kind, visibility}` line per node, and `history_length: 17` — in place of the full body and a
17-entry ledger. `projection:"nodes"` returns the body with the ledger still replaced by its length.

The W6 plan's falsification stands and is worth restating, because the original defect report's
premise was wrong: the 502s were **not** payload-size dependent (`ping`, a ~200-byte response, 502'd
too; `object_inventory` 502'd and then succeeded unchanged 36 s later). The projections are
worthwhile on their own terms — an unbounded `history` on a read that runs on every revision — and
were never a cure for the transport.

## D4 — the sourcing criterion tells the truth, confirmed live

`object_validate` on the live record:

```
article_claim_substrate   status: "info"
  "3 sources listed, no claim ledger — plugin path. The sourcing record is on the
   article; a per-claim ledger is not, and is not expected here. … Nothing to do."

summary.warnings  []
summary.blockers  []
summary.level     "ready"
```

Both halves of the ruling hold on a real plugin-authored article: an article with real sources and
no claim ledger is `info`, it is not an operator action item, and it never blocks.

## Q — private annotations never reach git, confirmed live

All 13 nodes carry `private.strategy` / `private.intent` in the object store. The committed export
at `sites/drlurie/data/site/articles/req_plugin_moisturizer_functions_20260903_01.json` has **zero**
`private` keys at any depth, scanned recursively. Strip at the git seam, keep in the store — exactly
the ruling, verified on a live artefact rather than a fixture.

---

## Defect — attribution degrades to `unattributed-agent` after the first call

The 17-entry ledger:

| verb | actor |
|---|---|
| `create` 13:21:49 | `plugin:openai-agent` |
| `checkout`, `set_article_meta`, `upsert_node` ×2, `publish`, `checkin` | `unattributed-agent` |
| the remaining 10 entries, both later `publish` calls included | `unattributed-agent` |

No `producer` block on any of the three publishes either.

The agent's instructions carried the Attribution block — *"pass `agent_name` wherever it is
accepted"* — and had done for roughly 35 minutes before this run started. It was obeyed exactly
once. The ledger therefore cannot answer "which surface published this article", which is the only
question attribution exists to answer.

The cause is structural, not a bad prompt: `agent_name` was a tool ARGUMENT, so identity was only
ever as reliable as a model repeating a field across sixteen calls.

**Ruled and fixed the same day** (Wolf, 2026-09-03): the actor is derived from the credential that
authorized the call, never from model-supplied text; `agent_name` is demoted to an optional label;
lock-owner inheritance survives only as a stamped last resort. See
`packages/core/server/lib/caller-actor.ts` and `caller-surface.ts`, and
`tests/netlify/mcp-actor-from-auth.test.ts`, which drives the real `/mcp` handler with an OAuth
token and no `agent_name` at all.

**Not yet closed.** The fix has to deploy, and then one fresh plugin run has to produce a ledger
whose every entry names a human and a surface. The 17 entries above will not change: a history
ledger is append-only, and rewriting it to look better than the day it was written is the one thing
an audit trail must never do.

---

## Still open after this run

- The acceptance above was recorded from the live tenant after the fact. A run driven deliberately,
  with `deploy_status` and `verify_article_images` called as steps rather than checked afterwards,
  is still worth doing once the attribution fix is live.
- `req_plugin_stinging_20260831_01` (the W2 artifact) is retired in the same delivery as this doc.
