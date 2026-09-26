'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadChatUnread } from '@/lib/api';

const pollMs = 30_000;

/**
 * How many chats hold messages the signed-in person has not read. The badge
 * polls while the page is visible; an open chat reports fresher counts
 * through the setter whenever it marks a thread read.
 */
export function useChatUnread(enabled: boolean) {
  const [unreadThreads, setUnreadThreads] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const result = await loadChatUnread();
      setUnreadThreads(result.unreadThreads);
    } catch {
      // The badge is advisory. A failed poll keeps the last known count
      // rather than interrupting the page with an error.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);

  return { unreadThreads, setUnreadThreads, refreshUnread: refresh };
}
