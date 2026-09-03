/**
 * Voice dictation button for chat inputs (T3.4, design decision D7) — the
 * presentational half of dictation. All Web Speech API wiring lives in the
 * `useDictation` hook (packages/core/lib/admin/use-dictation.ts); callers
 * (see ChatComposer in chat.tsx) own that hook and only render this button
 * when `useDictation(...).supported` is true, so an unsupported browser
 * shows no mic at all — not a disabled button, not a tooltip explaining why.
 *
 * The listening state uses the accent tokens, never `danger`: under the D4
 * severity standard red is reserved for Error/Blocked, and "the mic is on" is
 * an active state, not a failure.
 */
import { IconButton, type ButtonSize } from './primitives';
import { IconMic } from './icons';

export interface MicButtonProps {
  listening: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Defaults to 'md' (unchanged) — `ChatComposer` passes 'sm' to sit flush with its other compact input-row controls. */
  size?: ButtonSize;
}

export function MicButton({ listening, onToggle, disabled, size }: MicButtonProps) {
  return (
    <IconButton
      label={listening ? 'Stop dictating' : 'Dictate with your voice'}
      aria-pressed={listening}
      icon={<IconMic size={size === 'sm' ? 16 : 18} />}
      variant="ghost"
      size={size}
      onClick={onToggle}
      disabled={disabled}
      className={
        listening ? 'animate-pulse bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]' : undefined
      }
    />
  );
}
