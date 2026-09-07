/**
 * W3.1 — the card a wall gets, wherever it is shown.
 *
 * THE THING IT REPLACES. `<EmptyState severity="error" title="That did not go
 * through" message={error} />` — a red X and a sentence, for a failure whose
 * remedy the engine had already computed down to the dollar. Wolf's rule, and
 * the one this component is built around: RED IS FOR A WALL WHERE NOTHING CAN
 * BE DONE. Everything with a remedy is amber and carries the buttons.
 *
 * It renders `blockage.v1` and nothing else. The buttons come from
 * `remedyButtons` (`lib/admin/blockage.ts`) — one pure table shared with the
 * Requests card and the chat transcript, so all three surfaces say "Raise to
 * $1.50 for this attempt" in the same words with the same Owner gate. This
 * component decides nothing about the network: `onResolve` is a plain callback,
 * the same posture `RequestActivity`'s run card already takes.
 */
import { useState } from 'react';

import { Badge, Button } from './primitives';
import { IconAlertCircle, IconAlertTriangle } from './icons';
import {
  hasActionableRemedy,
  remedyButtons,
  type Blockage,
  type RemedyButton,
} from '@core/lib/admin/blockage';

export interface BlockageCardProps {
  blockage: Blockage;
  isOwner: boolean;
  /** Called with the remedy the human pressed. The host owns the network call. */
  onResolve: (button: RemedyButton) => void | Promise<void>;
  /** True while a resolution is in flight — every button disables together. */
  busy?: boolean;
  /**
   * The one-line hint that a typed answer works too (D5). Shown only where a
   * chat is actually reachable; on a page with no chat beside it, promising
   * "tell the agent" would be a dead end.
   */
  chatHint?: string;
  /** Set when the card is inside a chat transcript, which has its own frame. */
  variant?: 'page' | 'transcript';
}

const KIND_WORDS: Record<Blockage['kind'], string> = {
  budget: 'This step needs a higher spending limit',
  approval: 'This is waiting for your decision',
  limit: 'This step ran into a configured limit',
  config: 'Something is not set up yet',
  auth: 'A credential is missing or refused',
  validation: 'This could not start with what it was given',
  other: 'This step stopped',
};

/**
 * The technical sentence, once, for the person who wants it — never the
 * headline. An editor reads the plain line above; an operator opens this.
 */
const DetailLine = ({ blockage }: { blockage: Blockage }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${blockage.code}: ${blockage.message}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard the browser refuses is not worth an error state — the text
      // is on screen and selectable either way.
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="adm-focusable text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)] underline"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide detail' : 'What exactly happened?'}
        </button>
        {open ? (
          <button
            type="button"
            className="adm-focusable inline-flex items-center gap-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </div>
      {open ? (
        <p className="rounded-[var(--adm-radius-sm)] bg-[var(--adm-surface-sunken)] px-2 py-1 font-mono text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {blockage.code}: {blockage.message}
        </p>
      ) : null}
    </div>
  );
};

export function BlockageCard({
  blockage,
  isOwner,
  onResolve,
  busy = false,
  chatHint,
  variant = 'page',
}: BlockageCardProps) {
  const buttons = remedyButtons(blockage, { isOwner });
  // Amber whenever ANYTHING can be done — including by someone else. A wall an
  // editor cannot clear but an Owner can is still not a dead end, and painting
  // it red would say it was.
  const actionable = hasActionableRemedy(blockage);
  const tone = actionable
    ? {
        border: 'border-[var(--adm-warning)]',
        surface: 'bg-[var(--adm-warning-soft)]',
        text: 'text-[var(--adm-warning-text)]',
        icon: <IconAlertTriangle size={18} />,
      }
    : {
        border: 'border-[var(--adm-danger)]',
        surface: 'bg-[var(--adm-danger-soft)]',
        text: 'text-[var(--adm-danger-text)]',
        icon: <IconAlertCircle size={18} />,
      };

  return (
    <div
      className={`flex flex-col gap-3 rounded-[var(--adm-radius-md)] border ${tone.border} ${tone.surface} px-3 py-3 ${
        variant === 'transcript' ? 'text-[length:var(--adm-text-sm)]' : ''
      }`}
      role="group"
      aria-label="Something needs your decision"
    >
      <div className="flex items-start gap-2">
        <span className={tone.text}>{tone.icon}</span>
        <div className="flex flex-1 flex-col gap-1">
          <p className={`text-[length:var(--adm-text-sm)] font-medium ${tone.text}`}>{KIND_WORDS[blockage.kind]}</p>
          {/* The ENGINE's own next-step sentence when it wrote one — it names
              the real figures, so paraphrasing it here would only risk saying
              a different number from the button underneath. */}
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
            {blockage.operator_action ?? blockage.message}
          </p>
        </div>
        <Badge tone="neutral">{blockage.scope.node_id}</Badge>
      </div>

      {buttons.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {buttons.map((button) => (
            <Button
              key={button.remedy_id}
              size="sm"
              variant={button.primary && !button.disabledReason ? 'primary' : 'secondary'}
              disabled={busy || Boolean(button.disabledReason)}
              // The refusal reason IS the tooltip: a disabled button with no
              // explanation is the failure mode this whole card exists to end.
              title={button.disabledReason}
              onClick={() => void onResolve(button)}
            >
              {button.label}
            </Button>
          ))}
        </div>
      ) : null}

      {/* The honest reason, in text and not only on hover, for the viewer who
          cannot press the thing they most need. */}
      {buttons.some((button) => button.disabledReason) ? (
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          {buttons.find((button) => button.disabledReason)?.disabledReason}
        </p>
      ) : null}

      {chatHint ? <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{chatHint}</p> : null}

      <DetailLine blockage={blockage} />
    </div>
  );
}
