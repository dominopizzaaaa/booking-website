'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadChatUnread } from '@/lib/api';

const pollMs = 30_000;

/**
 * How many chats hold messages the signed-in person has not read. The badge
 * polls while the page is visible; an open chat reports fresher counts
 * through the setter whenever it marks a thread read.
 */
export function useChatUnread(enabled: boolean) {
  const [unreadThreads, setUnreadThreads] = useState(0);
  const requestGeneration = useRef(0);

  /**
   * Reserve the next unread-count write before its HTTP request begins. This
   * prevents a slow, older poll from restoring a count that a later read or
   * inbox refresh already cleared.
   */
  const beginUnreadRequest = useCallback(() => {
    const request = ++requestGeneration.current;
    return (count: number) => {
      if (request === requestGeneration.current) setUnreadThreads(count);
    };
  }, []);

  /**
   * A completed mark-read response is authoritative even when a list poll
   * began after it. Advance the generation at completion so neither that
   * stale poll nor an older request can restore the previous badge.
   */
  const commitUnreadNow = useCallback((count: number) => {
    requestGeneration.current += 1;
    setUnreadThreads(count);
  }, []);

  const refresh = useCallback(async () => {
    const commit = beginUnreadRequest();
    try {
      const result = await loadChatUnread();
      commit(result.unreadThreads);
    } catch {
      // The badge is advisory. A failed poll keeps the last known count
      // rather than interrupting the page with an error.
    }
  }, [beginUnreadRequest]);

  useEffect(() => {
    if (!enabled) {
      requestGeneration.current += 1;
      setUnreadThreads(0);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      requestGeneration.current += 1;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);

  return { unreadThreads, beginUnreadRequest, commitUnreadNow, refreshUnread: refresh };
}

export type BeginChatUnreadRequest = ReturnType<typeof useChatUnread>['beginUnreadRequest'];
