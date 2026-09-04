/**
 * Article inspector → PDF card (T2.6). A THIN renderer, same discipline as
 * `PdfTemplatesPanel.tsx`: every decision (which of the five states this
 * article is in, which actions that state permits, how a quality-gate
 * report reads) lives in `@core/lib/admin/article-pdf-card`, tested there
 * with `node:test` — this component branches on nothing but that module's
 * output.
 *
 * DATA IN, NO NEW ENDPOINT. `nodes` is the article body the workspace
 * already loaded (`record.body.nodes`); `events` is the SAME per-object chat
 * transcript `ObjectWorkspace` already polls (`chat.events`) — the job and
 * verification records are read off whatever `render_article_pdf` /
 * `verify_pdf_content` tool_result this chat has actually seen (see the pure
 * module's header comment for the join this assumes and still needs
 * verifying against T2.3's real tools).
 *
 * Make PDF / Re-render / Verify have no browser-reachable endpoint (same
 * seam the templates panel's "Render sample" uses) — a click SEEDS this
 * object's own chat composer with a prompt naming the tool explicitly; nothing
 * auto-sends, so nothing is claimed before an agent actually reports back.
 * Detach is an ordinary content edit (clears the attaching field) and goes
 * through `EditSession` directly, same as "Set as site default" does.
 */
import { useState } from 'react';

import { Badge, Button, Card } from './primitives';
import { IconExternalLink } from './icons';
import { EditSession, type GetToken } from '@core/lib/edit-mode/verbs-client';
import type { ChatEventView } from '@core/lib/admin/chat-client';
import {
  buildArticlePdfCardView,
  buildArticlePdfPrompt,
  buildDetachPdfOp,
  extractLatestArticlePdfJob,
  extractLatestArticlePdfVerification,
  findAttachedPdf,
  type ArticlePdfActionId,
  type ArticlePdfNodeLike,
  type ArticlePdfState,
} from '@core/lib/admin/article-pdf-card';

const STATE_BADGE: Record<ArticlePdfState, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  none: { label: 'No PDF', tone: 'neutral' },
  rendering: { label: 'Rendering…', tone: 'info' },
  'attached-unverified': { label: 'Attached — not yet verified', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export interface ArticlePdfCardProps {
  /** Only rendered for `content_item` by the host — passed through so a
   *  future object type can opt in without this component guessing. */
  objectType: string;
  objectId: string;
  nodes: readonly ArticlePdfNodeLike[] | undefined;
  events: readonly ChatEventView[];
  getToken: GetToken;
  /** Prefills (never sends) this object's chat composer — `ObjectWorkspace`'s `composerSeed`. */
  onSeedComposer: (prompt: string) => void;
  /** Called after a successful Detach so the host re-reads the record. */
  onChanged: () => void | Promise<void>;
}

export function ArticlePdfCard({ objectType, objectId, nodes, events, getToken, onSeedComposer, onChanged }: ArticlePdfCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const attachment = findAttachedPdf(nodes);
  const job = extractLatestArticlePdfJob(events);
  const verification = extractLatestArticlePdfVerification(events);
  const view = buildArticlePdfCardView({ attachment, job, verification });
  const badge = STATE_BADGE[view.state];

  const runAction = async (action: ArticlePdfActionId) => {
    setError(undefined);
    if (action === 'detach') {
      if (!attachment) return; // state machine would not have offered this
      setBusy(true);
      const session = new EditSession(objectType, objectId, getToken);
      try {
        const checkout = await session.ensureCheckout();
        if (!checkout.ok) {
          setError(`This article is checked out by ${checkout.heldBy ?? 'someone else'}.`);
          return;
        }
        const result = await session.patch([buildDetachPdfOp(attachment)]);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        await onChanged();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'The PDF could not be detached.');
      } finally {
        await session.checkin().catch(() => undefined);
        setBusy(false);
      }
      return;
    }
    onSeedComposer(buildArticlePdfPrompt(action, { contentItemId: objectId, ...(job?.templateId ? { templateId: job.templateId } : {}) }));
  };

  return (
    <Card
      kicker="PDF"
      title="Attached PDF"
      actions={<Badge tone={badge.tone}>{badge.label}</Badge>}
    >
      <div className="flex flex-col gap-3">
        {view.reason ? (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-danger-text)]">{view.reason}</p>
        ) : null}

        {error ? <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-danger-text)]">{error}</p> : null}

        {view.openHref ? (
          <a
            href={view.openHref}
            target="_blank"
            rel="noreferrer"
            className="adm-focusable inline-flex w-fit items-center gap-1.5 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
          >
            <IconExternalLink size={16} /> Open PDF
          </a>
        ) : null}

        {view.qualityGateLines.length > 0 ? (
          <div className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-warning-soft)] px-3 py-2">
            <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-warning-text)]">
              Quality gate {view.qualityGatePassed === false ? '— warnings, not a failure' : 'notes'}
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {view.qualityGateLines.map((line, index) => (
                <li key={index} className="text-[length:var(--adm-text-sm)] text-[var(--adm-warning-text)]">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.actions.length === 0 && view.state === 'rendering' ? (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            A render is in progress. This card updates once the agent reports back.
          </p>
        ) : null}

        {view.actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {view.actions.map((action) => (
              <Button
                key={action.id}
                size="sm"
                variant={action.id === 'detach' ? 'secondary' : 'primary'}
                disabled={busy}
                loading={busy && action.id === 'detach'}
                onClick={() => void runAction(action.id)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export default ArticlePdfCard;
