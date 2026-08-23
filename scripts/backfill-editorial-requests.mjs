#!/usr/bin/env node
/**
 * W19 T19.10 — register the jobs that ran before the registry existed.
 *
 * Walks this site's chat docs for `run_workspace_workflow` tool results, which
 * are the only place a pre-W19 job's request id and run id were ever written
 * down, and mints a request record from each.
 *
 * A job older than `--archive-after-days` (default 7) is registered ALREADY
 * ARCHIVED, so the first view of /admin/requests is the live desk and not a
 * year of history. A RECENT job is registered live and left for the sweeper to
 * derive: the script does not read run state and so must never assert one —
 * archiving everything would have hidden a job that was genuinely still
 * running, permanently, since the sweeper skips archived rows.
 *
 * `--dry-run` is the default. Idempotent, including after an interruption: the
 * archive pass runs over what is ON DISK rather than over what this invocation
 * created, so a crash between the two writes is repaired by the next run.
 *
 *   node scripts/backfill-editorial-requests.mjs --site sites/drlurie [--apply]
 */
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const APPLY = flag('apply');
const SITE = value('site') ?? 'sites/drlurie';
const ARCHIVE_AFTER_DAYS = Number.parseInt(value('archive-after-days') ?? '7', 10);

const load = async () => {
  await import(`../${SITE}/config/policy-bindings.js`);
  const chat = await import('../packages/core/server/lib/agent/chat-store.js');
  const store = await import('../packages/core/server/lib/requests/store.js');
  const blobs = await import('../packages/core/server/lib/blob-store.js');
  return { chat, store, blobs };
};

/** The one place a pre-W19 job's ids were recorded: the tool result it left in its chat. */
export const jobsFromChat = (doc) => {
  const jobs = [];
  // A chat whose event log was trimmed (800 → 600) may have lost the very
  // result we read. Coverage is not completeness, and the report says so
  // rather than letting an operator read a clean number as a full one.
  const trimmed = (doc.events ?? []).some((event) => event.type === 'events_trimmed');
  for (const event of doc.events ?? []) {
    if (event.type !== 'tool_result' || event.detail?.is_error) continue;
    if (event.detail?.tool !== 'run_workspace_workflow') continue;
    let body;
    try {
      body = typeof event.detail.output === 'string' ? JSON.parse(event.detail.output) : event.detail.output;
    } catch {
      continue;
    }
    const requestId = body?.request_id;
    const runId = body?.run_id;
    if (typeof requestId !== 'string') continue;
    jobs.push({
      requestId,
      runId: typeof runId === 'string' ? runId : undefined,
      at: event.at,
      chatId: doc.chat_id,
      chatKind: doc.kind,
      createdBy: doc.created_by,
      title: doc.title,
    });
  }
  return { jobs, trimmed };
};

/**
 * Old enough to file away, given a cutoff. An UNPARSEABLE timestamp counts as
 * old: a row with no readable date cannot be shown to be current, and the
 * alternative — treating it as live — hands the sweeper a job it will poll and
 * mail somebody about forever.
 */
export const isOlderThan = (at, cutoffMs) => {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed < cutoffMs : true;
};

const main = async () => {
  const { chat, store, blobs } = await load();
  const chatStore = await blobs.getAgentChatBlobStore(undefined);
  const requestStore = await blobs.getEditorialRequestsBlobStore(undefined);

  const docs = await chat.listChatDocs(chatStore);
  const seen = new Map();
  let trimmedChats = 0;
  for (const doc of docs) {
    const { jobs, trimmed } = jobsFromChat(doc);
    if (trimmed) trimmedChats += 1;
    for (const job of jobs) if (!seen.has(job.requestId)) seen.set(job.requestId, job);
  }

  const existing = await store.loadIndex(requestStore);
  const rowsById = new Map((existing?.rows ?? []).map((row) => [row.request_id, row]));

  const cutoffMs = Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const isOld = (job) => isOlderThan(job.at, cutoffMs);

  const all = [...seen.values()];
  const toRegister = all.filter((job) => !rowsById.has(job.requestId));
  // Idempotence under interruption: anything old that is on disk but not yet
  // archived still needs the second write, whether this run created it or a
  // previous crashed one did.
  const toArchive = all.filter((job) => isOld(job) && !rowsById.get(job.requestId)?.archived);
  const withoutRun = toRegister.filter((job) => !job.runId);

  console.info(
    `[backfill] site=${SITE} chats=${docs.length} chats_with_trimmed_events=${trimmedChats} jobs_found=${seen.size} already_registered=${seen.size - toRegister.length} to_register=${toRegister.length} to_archive=${toArchive.length} without_a_run_id=${withoutRun.length}`
  );
  if (trimmedChats > 0) {
    console.info(
      `[backfill] NOTE: ${trimmedChats} chat(s) had their event log trimmed, so some historical jobs may be unrecoverable from this source.`
    );
  }

  if (!APPLY) {
    for (const job of toRegister.slice(0, 20)) {
      console.info(
        `  would register ${job.requestId} (run ${job.runId ?? 'unknown'})${isOld(job) ? ' [archived]' : ' [live]'}`
      );
    }
    if (toRegister.length > 20) console.info(`  … and ${toRegister.length - 20} more`);
    // Named, not counted. Archiving is the one write here that HIDES
    // something, and an operator cannot check `to_archive=7` against their own
    // knowledge of the desk.
    const alreadyOnDisk = toArchive.filter((job) => rowsById.has(job.requestId));
    for (const job of alreadyOnDisk.slice(0, 20)) {
      console.info(
        `  would archive ALREADY-REGISTERED ${job.requestId} (queued since ${rowsById.get(job.requestId).updated_at})`
      );
    }
    if (alreadyOnDisk.length > 20) console.info(`  … and ${alreadyOnDisk.length - 20} more`);
    console.info('[backfill] dry run — nothing written. Re-run with --apply.');
    return;
  }

  let registered = 0;
  for (const job of toRegister) {
    // What is known is recorded; what is not is left absent rather than
    // guessed. A job with no discoverable run id is registered without a
    // workflow block, and its status_reason says so instead of claiming `done`.
    await store.createRequest(
      requestStore,
      {
        request_id: job.requestId,
        kind: 'article',
        title: job.title || job.requestId,
        created_by: job.createdBy,
        chat: { chat_id: job.chatId, kind: job.chatKind },
        ...(job.runId ? { workflow: { run_id: job.runId, workflow_id: 'publishing_conductor', project_id: '' } } : {}),
      },
      job.at
    );
    registered += 1;
  }

  // Separate pass, driven by what is on disk: a crash between the two writes
  // is repaired next run rather than leaving a `queued` row the sweeper will
  // pick up and e-mail somebody about a year-old job.
  let archived = 0;
  for (const job of toArchive) {
    await store.archiveRequest(requestStore, job.requestId, 'backfill');
    archived += 1;
  }
  await store.rebuildIndex(requestStore);
  console.info(
    `[backfill] registered=${registered} archived=${archived} left_live=${registered - archived}; index rebuilt.`
  );
};

// Importable for its pure halves without running the walk.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error('[backfill] failed:', error);
    process.exitCode = 1;
  });
}
