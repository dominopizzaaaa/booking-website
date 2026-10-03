import type { ChatThreadDetail, ChatThreadList, ChatThreadSummary } from './types';

/**
 * What one signed-in person last saw in Chat, so reopening the inbox or a
 * conversation paints at once while a fresh copy loads behind it. It lives in
 * page memory only, never browser storage, and holds one account at a time:
 * a different account's first use replaces it, and signing out clears it.
 * The server still authorizes every refresh, so a stale entry is only ever
 * shown to the person who already saw it, and only until that refresh lands.
 */
export type ChatInboxSnapshot = {
  threads: ChatThreadSummary[];
  nextCursor: string | null;
  accountChatAvailable: boolean;
};

/** Conversations kept, most recently opened first. */
export const cachedThreadLimit = 20;

let owner: string | null = null;
let inbox: ChatInboxSnapshot | null = null;
let inboxRequest: Promise<ChatThreadList> | null = null;
const threads = new Map<string, ChatThreadDetail>();

/** Who a cache entry belongs to; null when the account cannot be told apart. */
export function chatCacheScope(viewerType: string, username: string | null | undefined): string | null {
  return username ? `${viewerType}:${username}` : null;
}

function claim(scope: string) {
  if (owner === scope) return;
  owner = scope;
  inbox = null;
  inboxRequest = null;
  threads.clear();
}

export function cachedInbox(scope: string): ChatInboxSnapshot | null {
  return owner === scope ? inbox : null;
}

export function rememberInbox(scope: string, snapshot: ChatInboxSnapshot) {
  claim(scope);
  inbox = snapshot;
}

export function cachedThread(scope: string, threadId: string): ChatThreadDetail | null {
  if (owner !== scope) return null;
  const detail = threads.get(threadId);
  if (!detail) return null;
  // Reading a conversation keeps it among the ones remembered.
  threads.delete(threadId);
  threads.set(threadId, detail);
  return detail;
}

export function rememberThread(scope: string, detail: ChatThreadDetail) {
  claim(scope);
  threads.delete(detail.id);
  threads.set(detail.id, detail);
  for (const oldest of threads.keys()) {
    if (threads.size <= cachedThreadLimit) break;
    threads.delete(oldest);
  }
}

/** Drop a conversation the server says this person can no longer open. */
export function forgetThread(scope: string, threadId: string) {
  if (owner !== scope) return;
  threads.delete(threadId);
  if (inbox) inbox = { ...inbox, threads: inbox.threads.filter(thread => thread.id !== threadId) };
}

export function clearChatCache() {
  owner = null;
  inbox = null;
  inboxRequest = null;
  threads.clear();
}

/**
 * Load the inbox in the background so the first visit to Chat has it ready.
 * Does nothing while an inbox is already remembered or on its way.
 */
export function prefetchInbox(scope: string, load: () => Promise<ChatThreadList>) {
  claim(scope);
  if (inbox || inboxRequest) return;
  const request = load();
  inboxRequest = request;
  request.then(result => {
    if (owner === scope && inboxRequest === request) {
      rememberInbox(scope, {
        threads: result.threads, nextCursor: result.nextCursor, accountChatAvailable: result.accountChatAvailable,
      });
    }
  }, () => {
    // A failed prefetch only means Chat loads when it opens, as it would have.
  }).finally(() => {
    if (inboxRequest === request) inboxRequest = null;
  });
}

/**
 * A background inbox load still on its way, for an inbox that opens first to
 * adopt instead of asking again. Later refreshes always ask afresh, because
 * an older request cannot reflect what the person has just done.
 */
export function pendingInbox(scope: string): Promise<ChatThreadList> | null {
  return owner === scope ? inboxRequest : null;
}
