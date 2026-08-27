/**
 * Voice dictation for chat inputs (T3.4, design decision D7): a
 * `useDictation` hook wrapping the browser's Web Speech API
 * (`SpeechRecognition` / `webkitSpeechRecognition`), plus the pure
 * transcript-merging helpers it's built on — kept separate so they're
 * testable without a browser (see use-dictation.test.ts).
 *
 * Browser-only, no server component and no per-site configuration — safe for
 * every `sites/<client>` in the fleet. Absent the API (any non-Chromium
 * browser today), `supported` stays false and callers render nothing extra.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

// ─── minimal Web Speech API surface (not in TS's default DOM lib) ─────────────

interface SpeechRecognitionAlternative {
  readonly transcript: string;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  /** e.g. 'not-allowed', 'no-speech', 'network', 'aborted'. */
  readonly error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function speechRecognitionCtor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/** True in any environment (SSR included) where the Web Speech API is unavailable. */
export function isDictationSupported(): boolean {
  return speechRecognitionCtor() !== undefined;
}

// ─── pure transcript merging (unit-tested without a browser) ──────────────────

/**
 * Tracks one dictation session against a text input: `committed` is text
 * that dictation will never touch again — whatever the user had typed
 * before the session started, plus every speech segment already finalized
 * — and `interim` is the not-yet-final tail currently being spoken, shown
 * live and discarded the moment it's replaced by a final result.
 */
export interface DictationBuffer {
  committed: string;
  interim: string;
}

/**
 * Join two pieces of text with a single space between them, without ever
 * introducing a double space or dropping a character. Handles the case
 * where either side is empty and the case where one side already carries
 * the boundary whitespace (Chrome's continuous-mode results are typically
 * pre-fixed with a leading space after the first segment).
 */
export function joinDictationText(base: string, addition: string): string {
  if (!addition) return base;
  if (!base) return addition.replace(/^\s+/, '');
  const needsSpace = !/\s$/.test(base) && !/^\s/.test(addition);
  return needsSpace ? `${base} ${addition}` : `${base}${addition}`;
}

/** Start a dictation session on top of whatever text is already in the input (empty or user-typed). */
export function startDictationBuffer(existingText: string): DictationBuffer {
  return { committed: existingText, interim: '' };
}

/** Replace the live preview with a fresh (still-not-final) interim transcript. Never touches `committed`. */
export function withInterimResult(buffer: DictationBuffer, interimText: string): DictationBuffer {
  return { committed: buffer.committed, interim: interimText };
}

/** Fold a finalized transcript segment into `committed` and clear the interim preview. */
export function withFinalResult(buffer: DictationBuffer, finalText: string): DictationBuffer {
  return { committed: joinDictationText(buffer.committed, finalText), interim: '' };
}

/** The text an input should display for the current buffer state — committed text plus any live interim preview. */
export function dictationText(buffer: DictationBuffer): string {
  return joinDictationText(buffer.committed, buffer.interim);
}

// ─── useDictation ───────────────────────────────────────────────────────────

export interface UseDictationOptions {
  /** The controlled input's current text. */
  value: string;
  /** Called with the merged text on every interim update and every finalized segment. */
  onChange: (next: string) => void;
  /** Web Speech `onerror` (e.g. 'not-allowed' when mic permission is denied). Recognition has already stopped by the time this fires. */
  onError?: (error: string) => void;
}

export interface UseDictationState {
  /** False in SSR and in any browser without the Web Speech API — render nothing when false. */
  supported: boolean;
  listening: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function useDictation({ value, onChange, onError }: UseDictationOptions): UseDictationState {
  // Starts false so the server-rendered and pre-hydration markup match
  // regardless of the actual browser (avoids a hydration mismatch on the
  // `client:load` islands this hook is used from); flips true right after
  // mount once the capability check can actually run.
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const bufferRef = useRef<DictationBuffer>(startDictationBuffer(value));
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  valueRef.current = value;
  onChangeRef.current = onChange;
  onErrorRef.current = onError;

  useEffect(() => setSupported(isDictationSupported()), []);

  // Keep the session's "committed" baseline in sync with hand-typed edits
  // made between utterances (i.e. whenever there's no live interim preview
  // overlaying the input) — otherwise text typed after dictating would be
  // lost the next time a final result lands.
  useEffect(() => {
    if (bufferRef.current.interim === '' && bufferRef.current.committed !== value) {
      bufferRef.current = startDictationBuffer(value);
    }
  }, [value]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || recognitionRef.current) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    bufferRef.current = startDictationBuffer(valueRef.current);
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      if (finalText) bufferRef.current = withFinalResult(bufferRef.current, finalText);
      bufferRef.current = withInterimResult(bufferRef.current, interimText);
      onChangeRef.current(dictationText(bufferRef.current));
    };
    recognition.onerror = (event) => {
      recognitionRef.current = null;
      setListening(false);
      onErrorRef.current?.(event.error);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  // Clean up the recognition instance on unmount.
  useEffect(
    () => () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    },
    []
  );

  return { supported, listening, start, stop, toggle };
}
