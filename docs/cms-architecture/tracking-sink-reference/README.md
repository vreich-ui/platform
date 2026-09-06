# Tracking sink — owner-DB reference kit (W13 T13.9)

The relay (`/api/t`, `netlify/functions/track-ingest.ts`) forwards enriched
`tracking_event.v1` events to an OWNER-RUN sink and mirrors to the
`tracking-events` blob store when the sink is absent or unhealthy. **Nothing
in this directory deploys from this repo** — it is the contract plus a
Postgres reference implementation ("a DB listening to triggers") an operator
can stand up alone. Any HTTPS endpoint honoring the receiver contract below
works; the DB choice is the owner's.

## 1. The receiver contract

The relay sends, per accepted batch (at-most-once, 2s timeout, no retries —
the mirror catches the rest):

- `POST <TRACKING_SINK_URL>` with `Content-Type: application/x-ndjson`
- `Authorization: Bearer <TRACKING_SINK_TOKEN>` when the token env is set
- Body: one JSON `tracking_event.v1` per line (NDJSON). The authoritative
  shape is `src/schema/tracking-event-v1.ts` — enriched server-side: geo is
  country + subdivision ONLY, the raw IP is hashed into the daily `vhash`
  and discarded, `props` is allowlisted per event kind.

The receiver MUST:

1. **Respond fast** — `202` (or `200`) after parse + enqueue/insert; do any
   heavy work async. Anything else (or >2s) counts as failure and the batch
   lands in the blob mirror instead.
2. **Be idempotent on `event_id`** — inserts are
   `ON CONFLICT (event_id) DO NOTHING` (see `schema.sql`). The mirror-replay
   script and any retry may re-send events; duplicates must be a no-op.
3. **Evolve additively only** (the commerce_event.v1 rules): new optional
   fields may appear on events at any time and must not break ingestion —
   land unknown fields in the jsonb columns, never reject on them. Breaking
   changes come only as a `tracking_event.v2` with a dual-write window.
4. **Never require auth to be absent** — accept token-less posts only if you
   deliberately run an open sink (not recommended; the relay always sends
   the Bearer header when the env is set).

A minimal receiver is ~20 lines in any stack: read body → split lines →
parse JSON → validate/shape → batch INSERT … ON CONFLICT DO NOTHING →
respond 202. (With Postgres, `COPY`/multi-row `INSERT` per batch is plenty;
the AFTER INSERT trigger in `schema.sql` fans out `pg_notify` per row.)

### 1a. `GET /weights` — the experiment split (T21.5, OPTIONAL)

A site's BUILD asks the sink how to weight an experiment's arms:

- `GET <TRACKING_SINK_URL>/weights?project_id=<TRACKING_PROJECT_ID>`
- `Authorization: Bearer <TRACKING_SINK_TOKEN>` when the token env is set
- 2s timeout, no retries, called at most once per build and only when the
  site has at least one `active` experiment.

Response: `{"<control object_id>": {"<arm object_id>": <number>, …}}`, or the
same object under a top-level `weights` key. Values are relative shares, any
scale — the build normalizes them to integer percentages summing to 100.

**This endpoint is optional and the build treats it as advisory.** Absent
configuration, a timeout, a non-2xx, a row missing an arm, a negative value, or
a zero-sum row all fall back to EQUAL weights for that experiment. A weight
outage can change how traffic splits; it can never change which arms are
served, and it can never fail a build. A sink that does not implement
`/weights` at all is a supported configuration — every experiment simply runs
even.

## 2. Env contract (OQ-W13-6)

Per-tenant **Netlify env vars on the site running the relay** — set by the
human operator at T13.11; the `trk_<site>` record references env NAMES only
(never values, never URLs):

| Env var               | Meaning                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `TRACKING_SINK_URL`   | The receiver endpoint (this kit's §1). Absent = mirror-only mode. |
| `TRACKING_SINK_TOKEN` | Bearer token the receiver checks. Absent = post without auth.     |
| `TRACKING_SALT`       | The vhash/shash salt (server-only; rotating it re-keys visitors). |
| `TRACKING_PROJECT_ID` | Project stamp on events (defaults to `drlurie`).                  |

The names above are the defaults; a `trk_<site>` record may point
`providers.own.endpoint_env` / `auth_env` at differently-named vars (still
names, never values) for multi-tenant setups (doc 11 alignment).

## 3. The Postgres reference (`schema.sql`)

`psql "$DATABASE_URL" -f schema.sql` creates:

- `tracking_events` — `event_id UNIQUE` (idempotent replay), typed identity
  columns (`project_id/ts/event`, the object refs incl. `node_id`), jsonb
  `consent/props/context`, and the four query indexes:
  `(project_id, ts)`, `(project_id, object_id, ts)`,
  `(project_id, event, ts)`, `gin(props)`.
- `notify_tracking_event()` + an `AFTER INSERT` trigger firing
  `pg_notify('tracking_events', <row identity json>)` — workers `LISTEN
tracking_events` and fetch what they need (payloads stay tiny by design).
- `node_strategy` — the strategy-join dimension (§4).

## 4. The strategy join (OQ-W13-5 — blessed)

Events carry `node_id` ONLY — strategy vocabulary never leaves the CMS in
events (the leak-safe boundary; rendered HTML is scanned, exports are not).
The committed article exports **do** round-trip private fields by design, so
the owner DB ingests them directly:

1. Source: `src/data/site/articles/*.json` in the site repo (each file is a
   published `content_item` export; `body.nodes[]` carries
   `private.strategy` / `private.intent` per node).
2. For each export: upsert one `node_strategy` row per node —
   `(project_id, object_id, node_id, strategy, intent, node_kind, position)`
   where `object_id` is the record id in the export's `__generated.from`
   marker and `position` is the node's array index. Re-run on every deploy
   (or on the repo's export commits) — the primary key makes it idempotent.
3. Engagement × strategy is then a plain JOIN on `(object_id, node_id)` —
   the worked example query sits at the bottom of `schema.sql`.

## 5. Mirror replay (`scripts/tracking-mirror-replay.mjs`)

The blob mirror (`tracking-events` store,
`events/<yyyy-mm-dd>/<compact-ts>-<event_id>.json`) holds every event the
sink missed (or everything, with `blob_mirror: 'always'`). Backfill:

```
rm -rf .tmp/ci-test && npx tsc -p tsconfig.test.json   # compile the blob client
node scripts/tracking-mirror-replay.mjs --from 2026-07-19 --to 2026-07-20   # DRY-RUN: plan only
node scripts/tracking-mirror-replay.mjs --from 2026-07-19 --to 2026-07-20 \
  --sink https://db.example.com/ingest --token-env TRACKING_SINK_TOKEN --execute
```

Dry-run is the default and posts nothing. The script dedupes `event_id`s
within the run, posts NDJSON batches (`--batch-size`, default 100), stops on
the first non-202 response, and is safe to re-run end-to-end because the
sink dedupes on `event_id` (§1.2). Blob access uses the site's Netlify env;
rehearse against the local file-backed store the same way the roundtrip
driver does.

## 6. Non-goals (this kit, on purpose)

No deployed receiver, no dashboards or reporting, no export-ETL automation
(§4 is a recipe the owner runs), no S2S conversion uploads (the
`stripe-webhook` seam stays recorded, not built).
