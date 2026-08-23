/**
 * W19 T19.6 — the notification engine, in ONE place.
 *
 * Mounted once, in `AdminShell`, because the shell is on every admin page and
 * two surfaces racing to announce the same transition would double-fire. The
 * `/admin/requests` page owns only the browser-permission control, not the
 * firing.
 *
 * Four transitions notify and nothing else (`NOTIFYING_STATUSES`); dedup is
 * server-side per person (`last_notified`), so a second tab, another device
 * and a reload all stay quiet about something already seen. Muting silences
 * every channel at once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ToastOptions } from './overlays';
import { ackNotifications, type RequestRowView } from '@core/lib/admin/requests-client';
import {
  mergeSeen,
  notificationHeadline,
  notificationSentence,
  scanNotifications,
  titlePrefix,
  type PendingNotification,
} from '@core/lib/admin/request-logic';

export type BrowserPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export const browserPermission = (): BrowserPermission => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as BrowserPermission;
};

/**
 * Ask ONCE, and only from an explicit control the person clicked (plan §6.2) —
 * never on page load. A browser that has already answered is not asked again.
 */
export const requestBrowserPermission = async (): Promise<BrowserPermission> => {
  if (browserPermission() !== 'default') return browserPermission();
  try {
    return (await Notification.requestPermission()) as BrowserPermission;
  } catch {
    return 'denied';
  }
};

const deepLink = (requestId: string) => `/admin/requests/${encodeURIComponent(requestId)}`;

const fireBrowserNotification = (notification: PendingNotification) => {
  if (browserPermission() !== 'granted') return;
  try {
    const shown = new Notification(notificationHeadline(notification), {
      body: notificationSentence(notification),
      // The tag collapses repeats of the SAME request in the OS tray rather
      // than stacking one per poll.
      tag: `editorial-request-${notification.request_id}`,
    });
    shown.onclick = () => {
      window.focus();
      window.location.assign(deepLink(notification.request_id));
    };
  } catch {
    // A browser that refuses to construct one is not worth breaking the page over.
  }
};

export interface IngestOptions {
  /**
   * This person has no ledger yet. Everything currently unhappy would read as
   * "new", so the first ingest records it silently instead of stacking a toast
   * and a desktop notification per row.
   */
  firstContact?: boolean;
}

export interface UseRequestNotifications {
  /** Feed each poll's rows in; everything else is handled here. */
  ingest: (
    rows: readonly RequestRowView[],
    lastNotified: Record<string, string>,
    muted: readonly string[],
    options?: IngestOptions
  ) => void;
  /** Unread count, cleared when the person visits the requests surface. */
  unread: number;
  clearUnread: () => void;
}

export function useRequestNotifications(
  getToken: () => Promise<string>,
  toast: (options: ToastOptions) => void
): UseRequestNotifications {
  const [unread, setUnread] = useState(0);
  // Locally seen, so the second poll (which arrives before the ack round-trip
  // lands) does not re-announce what the first one just showed.
  const seenRef = useRef<Record<string, string>>({});
  const baseTitleRef = useRef<string | undefined>(undefined);

  const ingest = useCallback(
    (
      rows: readonly RequestRowView[],
      lastNotified: Record<string, string>,
      muted: readonly string[],
      options: IngestOptions = {}
    ) => {
      // A row counts as seen if EITHER ledger matches; the merge (and the
      // pruning of what has gone stale) is pure and lives in request-logic.
      const { seen, local } = mergeSeen(rows, lastNotified, seenRef.current);
      seenRef.current = local;
      const { notify: fresh, ack } = scanNotifications(rows, seen, muted);
      // Non-notifying moves are acked too — that is what lets a request return
      // to `needs_you` later and be announced again.
      if (Object.keys(ack).length > 0) void ackNotifications(getToken, ack).catch(() => undefined);
      if (fresh.length === 0) return;
      if (options.firstContact) {
        // Recorded, not announced. From the next poll on, only real changes are news.
        for (const notification of fresh) seenRef.current[notification.request_id] = notification.status;
        return;
      }

      for (const notification of fresh) {
        seenRef.current[notification.request_id] = notification.status;
        toast({
          title: notificationHeadline(notification),
          description: notificationSentence(notification),
          // Wolf's severity rule applies here too: `needs_you` and `stalled`
          // are amber (a turn signal), `failed` is the only red.
          tone: notification.status === 'failed' ? 'danger' : notification.status === 'done' ? 'success' : 'warning',
        });
        fireBrowserNotification(notification);
      }
      setUnread((count) => count + fresh.length);
    },
    [getToken, toast]
  );

  // The unread count in the tab title, so a background tab still says so.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (baseTitleRef.current === undefined) baseTitleRef.current = document.title.replace(/^\(\d+\)\s*/, '');
    const base = baseTitleRef.current;
    document.title = `${titlePrefix(unread)}${base}`;
    return () => {
      document.title = base;
    };
  }, [unread]);

  return { ingest, unread, clearUnread: useCallback(() => setUnread(0), []) };
}
