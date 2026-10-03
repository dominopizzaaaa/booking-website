import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedInbox, cachedThread, cachedThreadLimit, chatCacheScope, clearChatCache, forgetThread, pendingInbox, prefetchInbox,
  rememberInbox, rememberThread,
} from '../src/lib/chat-cache';
import { api } from '../src/lib/api';
import type { ChatThreadDetail, ChatThreadList, ChatThreadSummary } from '../src/lib/types';

const amelia = chatCacheScope('STUDENT', 'amelia_wong')!;
const marcus = chatCacheScope('COACH', 'marcus_tan')!;

const summary = (id: string): ChatThreadSummary => ({ id } as ChatThreadSummary);
const detail = (id: string): ChatThreadDetail => ({ id, messages: [] } as unknown as ChatThreadDetail);
const list = (...ids: string[]): ChatThreadList => ({
  threads: ids.map(summary), nextCursor: null, accountChatAvailable: true,
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => clearChatCache());
afterEach(() => vi.unstubAllGlobals());

describe('chat cache ownership', () => {
  it('needs a username to tell accounts apart', () => {
    expect(chatCacheScope('STUDENT', undefined)).toBeNull();
    expect(chatCacheScope('STUDENT', '')).toBeNull();
    expect(chatCacheScope('COACH', 'marcus_tan')).not.toBe(chatCacheScope('CLUB', 'marcus_tan'));
  });

  it('serves the inbox and conversations only to the account that saw them', () => {
    rememberInbox(amelia, list('a', 'b'));
    rememberThread(amelia, detail('a'));
    expect(cachedInbox(amelia)?.threads.map(thread => thread.id)).toEqual(['a', 'b']);
    expect(cachedThread(amelia, 'a')?.id).toBe('a');
    expect(cachedInbox(marcus)).toBeNull();
    expect(cachedThread(marcus, 'a')).toBeNull();
  });

  it("drops one account's chats as soon as another account uses the cache", () => {
    rememberInbox(amelia, list('a'));
    rememberThread(amelia, detail('a'));
    rememberThread(marcus, detail('m'));
    expect(cachedInbox(amelia)).toBeNull();
    expect(cachedThread(amelia, 'a')).toBeNull();
    expect(cachedThread(marcus, 'm')?.id).toBe('m');
  });

  it('forgets everything on sign-out, which is a client-side navigation', async () => {
    rememberInbox(amelia, list('a'));
    rememberThread(amelia, detail('a'));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ ok: true }),
    })));
    await api('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    expect(cachedInbox(amelia)).toBeNull();
    expect(cachedThread(amelia, 'a')).toBeNull();
  });
});

describe('remembered conversations', () => {
  it('keeps a bounded set, evicting the least recently opened', () => {
    for (let index = 0; index < cachedThreadLimit; index += 1) rememberThread(amelia, detail(`t${index}`));
    // Opening the oldest makes it the most recent, so the next one goes instead.
    expect(cachedThread(amelia, 't0')).not.toBeNull();
    rememberThread(amelia, detail('newest'));
    expect(cachedThread(amelia, 't0')).not.toBeNull();
    expect(cachedThread(amelia, 't1')).toBeNull();
    expect(cachedThread(amelia, 'newest')).not.toBeNull();
  });

  it('removes a revoked conversation from both the thread and the inbox', () => {
    rememberInbox(amelia, list('a', 'b'));
    rememberThread(amelia, detail('a'));
    forgetThread(amelia, 'a');
    expect(cachedThread(amelia, 'a')).toBeNull();
    expect(cachedInbox(amelia)?.threads.map(thread => thread.id)).toEqual(['b']);
  });
});

describe('inbox prefetch', () => {
  it('loads once in the background and remembers the result', async () => {
    const load = vi.fn(async () => list('a'));
    prefetchInbox(amelia, load);
    prefetchInbox(amelia, load);
    const pending = pendingInbox(amelia);
    expect(pending).not.toBeNull();
    expect(pendingInbox(marcus)).toBeNull();
    await pending;
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(cachedInbox(amelia)?.threads.map(thread => thread.id)).toEqual(['a']);
    expect(pendingInbox(amelia)).toBeNull();
    prefetchInbox(amelia, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing behind when the background load fails', async () => {
    prefetchInbox(amelia, async () => { throw new Error('offline'); });
    await expect(pendingInbox(amelia)).rejects.toThrow('offline');
    await settle();
    expect(cachedInbox(amelia)).toBeNull();
    expect(pendingInbox(amelia)).toBeNull();
  });

  it('does not keep a result that arrives after sign-out', async () => {
    let finish!: (result: ChatThreadList) => void;
    prefetchInbox(amelia, () => new Promise(resolve => { finish = resolve; }));
    clearChatCache();
    finish(list('a'));
    await settle();
    expect(cachedInbox(amelia)).toBeNull();
  });
});
