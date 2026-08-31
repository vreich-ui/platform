/**
 * W19 — severity, and the rule that a held gate is not a failure.
 *
 * Wolf's ruling (2026-08-22), from a screenshot of the chat showing a red ✗ and
 * "publish_workspace_run failed": *"do not show red Xs and yellow warnings
 * unless they are serious… the cross is given to proper agent behaviour, it
 * should be a warning in this case, nothing is broken and it continues. Use red
 * for total fails of some steps."*
 *
 * The defect underneath is a category error the admin chat has always made: it
 * equates "the tool returned is_error" with "something is broken". Most
 * is_error results in this system are the guardrails WORKING — a publish
 * refused because readiness is `no_go`, a node blocked pending approval, a
 * membership verb refusing an agent principal. Painting those red teaches an
 * editor to ignore red, which is how a real failure gets missed.
 *
 * Four levels, and only four:
 *
 *   failure   — a step actually died and the work cannot continue as it is.
 *               RED. `model_error`, `output_validation_failed`, a node whose
 *               status is `failed`.
 *   attention — the system is working correctly and is WAITING FOR A HUMAN.
 *               Not an alarm; a turn signal. Approval required, readiness
 *               `no_go`, a run `blocked` or `paused`.
 *   notice    — recoverable, already handled, the run carried on. QUIET —
 *               visible in the detail view, never shouting in the transcript.
 *               Prefetch fallbacks, a tool call capped, a human declining a
 *               proposed write.
 *   ok        — nothing to say. Completed, or skipped by design with a reason.
 */

export type Severity = 'failure' | 'attention' | 'notice' | 'ok';

/** Ranked worst-first, so a set of signals can be reduced to the one that matters. */
export const SEVERITY_RANK: Record<Severity, number> = { failure: 0, attention: 1, notice: 2, ok: 3 };

export const worstSeverity = (severities: readonly Severity[]): Severity =>
  severities.reduce<Severity>((worst, next) => (SEVERITY_RANK[next] < SEVERITY_RANK[worst] ? next : worst), 'ok');

/** The admin design tokens each level maps to. `notice` is deliberately muted, not yellow. */
export const severityTone = (severity: Severity): 'danger' | 'warning' | 'neutral' | 'success' =>
  severity === 'failure'
    ? 'danger'
    : severity === 'attention'
      ? 'warning'
      : severity === 'notice'
        ? 'neutral'
        : 'success';

// ─── warnings ────────────────────────────────────────────────────────────────

/**
 * Warning prefixes observed on real production runs, with the level each
 * deserves. Everything unmatched defaults to `notice`: an unrecognised warning
 * on a run that CARRIED ON is by definition not fatal, and guessing upward is
 * how the alarm stops meaning anything.
 */
const WARNING_RULES: ReadonlyArray<{ prefix: string; severity: Severity; label: string }> = [
  // A human gate — the only warning class that earns amber.
  { prefix: 'approval_required', severity: 'attention', label: 'Waiting for your approval' },
  // Real degradations: the run continued, but something downstream will notice.
  { prefix: 'content_item_shell_failed', severity: 'attention', label: 'The article shell could not be created' },
  // Handled, and the run carried on. These fire on essentially every run today.
  { prefix: 'voice_prefetch_fallback', severity: 'notice', label: 'Brand voice unavailable — used the fallback' },
  { prefix: 'contract_prefetch_failed', severity: 'notice', label: 'Client contract could not be pre-read' },
  {
    prefix: 'article_body_validation_unavailable',
    severity: 'notice',
    label: "The client's validator was unreachable",
  },
  { prefix: 'resolved_vector_unclamped', severity: 'notice', label: 'No aggression ceiling was set' },
  { prefix: 'resolved_vector_engine_owned', severity: 'notice', label: 'Tone vector chosen by the engine' },
  { prefix: 'capture_crawl_pending', severity: 'notice', label: 'Waiting on the crawler' },
  { prefix: 'no_publication_performed', severity: 'notice', label: 'Nothing was published' },
  // The publish/release tail (2026-08-31). A committed publish that has not
  // yet been released is the normal shape of every autonomous run — quiet.
  // A release that could not confirm go-live is something a human should
  // check on — amber, exactly like a held gate, and never red: the article is
  // on `main` and nothing died.
  { prefix: 'publish_committed_pending_release', severity: 'notice', label: 'Published — awaiting release' },
  {
    prefix: 'release_execution_idempotent_replay',
    severity: 'notice',
    label: 'Release already recorded — not repeated',
  },
  { prefix: 'release_not_confirmed', severity: 'attention', label: 'Release not confirmed — check the deploy' },
  { prefix: 'deploy_not_confirmed', severity: 'attention', label: 'Deploy not confirmed — check the deploy' },
  { prefix: 'deploy_status_not_ready', severity: 'notice', label: 'Deploy not ready yet' },
  // Skipping by design is not a warning at all.
  { prefix: 'node_skipped', severity: 'ok', label: 'Skipped — not needed for this article' },
];

export interface ClassifiedWarning {
  severity: Severity;
  /** Editor-facing. Falls back to the raw code so an unknown warning is never hidden. */
  label: string;
  /** The raw `<prefix>:<detail>` string, kept for the detail view. */
  raw: string;
}

export const classifyWarning = (warning: string): ClassifiedWarning => {
  const raw = String(warning ?? '');
  const rule = WARNING_RULES.find((candidate) => raw.startsWith(candidate.prefix));
  return rule ? { severity: rule.severity, label: rule.label, raw } : { severity: 'notice', label: raw, raw };
};

// ─── node errors ─────────────────────────────────────────────────────────────

/** Error codes that mean the step genuinely died. Everything here is RED. */
const FATAL_ERROR_CODES = ['model_error', 'output_validation_failed', 'schema_validation_failed', 'node_timeout'];

export const isFatalNodeError = (error: string): boolean =>
  FATAL_ERROR_CODES.some((code) => String(error ?? '').includes(code));

// ─── tool calls ──────────────────────────────────────────────────────────────

/**
 * A tool call that was capped or refused is not a broken run — `web.fetch`
 * hitting `tool_call_limit_exceeded` happens on every research node we have
 * ever recorded, by design.
 */
export const classifyToolCall = (call: { status?: string; errorCode?: string }): Severity => {
  const status = String(call.status ?? '');
  if (status === 'success') return 'ok';
  if (status === 'denied') return 'notice';
  return 'notice';
};

// ─── a node ──────────────────────────────────────────────────────────────────

export interface NodeSignals {
  status?: string;
  errors?: readonly string[];
  warnings?: readonly string[];
  skip?: { reason?: string } | undefined;
}

export const classifyNode = (node: NodeSignals): Severity => {
  const status = String(node.status ?? '');
  if (status === 'failed') return 'failure';
  // The snapshot contract tolerates unknown status values, and a retried node
  // can carry its previous attempt's errors under a non-`failed` status. An
  // advertised fatal error is fatal whatever the status string says.
  if ((node.errors ?? []).some(isFatalNodeError)) return 'failure';
  if (status === 'blocked') return 'attention';
  // A skip carries its own reason and is a decision, not a problem.
  if (status === 'skipped') return 'ok';
  const fromWarnings = worstSeverity((node.warnings ?? []).map((warning) => classifyWarning(warning).severity));
  // A node that COMPLETED cannot be a failure however loud its warnings were.
  return fromWarnings === 'failure' ? 'attention' : fromWarnings;
};

// ─── a chat tool result (the screenshot defect) ──────────────────────────────

/**
 * Machine codes that mean a GATE HELD. Matched against the body's own
 * `code`/`status`, never against prose.
 *
 * A prose substring list used to be the whole test, and it was dangerous in
 * the one direction that matters: CMS-Agent's failure copy routinely names the
 * node or tool that broke, and this system's nodes are called things like
 * `publication_controller` while its tools are called `workflow_publish_
 * readiness` — so a genuine `model_error` whose message merely CONTAINED
 * "approval" or "readiness" classified amber, and the editor was told to wait
 * for a gate that would never open. A missed failure is far worse than a loud
 * one, so a fatal code now outranks every signal here.
 */
const GATE_CODES = [
  'no_go',
  'not_ready',
  'approval_required',
  'requires_approval',
  'membership_requires_human',
  'not_permitted',
  'forbidden',
  'requires_human',
];

/**
 * Prose fallback, consulted ONLY when the body carries no code at all — a
 * number of tools return a bare `{ error: "<sentence>" }`. Deliberately
 * narrower than the code list: whole phrases a refusal uses and a crash does
 * not.
 */
const GATE_PHRASES = [
  'is not ready to publish',
  'requires a signed-in human',
  'requires the owner role',
  'requires explicit approval',
  'is disabled by policy',
  'awaiting your approval',
];

export interface ToolResultSignals {
  tool?: string;
  isError?: boolean;
  /** The tool's JSON body, already parsed where possible. */
  output?: unknown;
}

export interface ClassifiedToolResult {
  severity: Severity;
  /** What the row should say. Never "<tool> failed" for a gate. */
  label: string;
  /** The gate's own sentence, where it had one. */
  detail?: string;
}

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Reduce whatever a tool returned to a flat record carrying `error`/`code`/
 * `message`/`status` where they exist. Handles the three non-flat shapes this
 * system actually produces — an MCP content envelope (`[{type:'text',text}]`),
 * a bare array, and a nested `{ error: { code, message } }` — because each of
 * them used to fall through as `{}`, which classified a held gate as red.
 */
const bodyOf = (output: unknown, depth = 0): Record<string, unknown> => {
  if (depth > 4) return {};
  if (typeof output === 'string') {
    try {
      return bodyOf(JSON.parse(output), depth + 1);
    } catch {
      // Not JSON — the string itself is the message.
      return output.trim() ? { error: output } : {};
    }
  }
  if (Array.isArray(output)) {
    for (const entry of output) {
      const inner = bodyOf(entry, depth + 1);
      if (Object.keys(inner).length) return inner;
    }
    return {};
  }
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') return bodyOf(record.text, depth + 1);
    if (Array.isArray(record.content)) {
      const inner = bodyOf(record.content, depth + 1);
      if (Object.keys(inner).length) return { ...record, ...inner };
    }
    if (record.error && typeof record.error === 'object') {
      return { ...record, ...(record.error as Record<string, unknown>) };
    }
    return record;
  }
  return {};
};

/** Human tool names for the row label — the raw snake_case is machine noise. */
const TOOL_TITLES: Record<string, string> = {
  publish_workspace_run: 'Publishing',
  release_workspace_run: 'Releasing',
  check_workspace_run_readiness: 'Readiness check',
  run_workspace_workflow: 'The article workflow',
  get_workspace_run: 'Progress check',
};

export const toolTitle = (tool: string): string => TOOL_TITLES[tool] ?? tool.replaceAll('_', ' ');

export const classifyToolResult = (signals: ToolResultSignals): ClassifiedToolResult => {
  const tool = String(signals.tool ?? 'tool');
  const title = toolTitle(tool);
  if (!signals.isError) return { severity: 'ok', label: `${title} finished` };

  const body = bodyOf(signals.output);
  const code = `${readString(body.code)} ${readString(body.status)}`.toLowerCase().trim();
  const prose = `${readString(body.error)} ${readString(body.message)}`.toLowerCase().trim();
  const sentence = readString(body.error) || readString(body.message) || undefined;

  // A fatal code OUTRANKS every gate signal. This precedence is what stops a
  // dead step wearing a "waiting on you" label because its message happened to
  // name a node with "approval" in it.
  if (FATAL_ERROR_CODES.some((fatal) => code.includes(fatal))) {
    return { severity: 'failure', label: `${title} failed`, ...(sentence ? { detail: sentence } : {}) };
  }

  const gate = code
    ? GATE_CODES.some((candidate) => code.includes(candidate))
    : GATE_PHRASES.some((phrase) => prose.includes(phrase));

  if (gate) {
    return {
      severity: 'attention',
      // The gate held. Say what is waiting, not that something broke.
      label: `${title} is waiting on you`,
      ...(sentence ? { detail: sentence } : {}),
    };
  }
  return {
    severity: 'failure',
    label: `${title} failed`,
    ...(sentence ? { detail: sentence } : {}),
  };
};

/**
 * The human declining a proposed write is a normal outcome of the approval
 * protocol, not an error — it has always rendered as a red ✗.
 */
export const DENIED_SEVERITY: Severity = 'notice';
