'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Building2, Loader2, MessageCircle, Search, UserRound, UsersRound } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { createAccountChat, searchAccounts } from '@/lib/api';
import type { AccountDirectoryUser, ChatThreadDetail } from '@/lib/types';
import { cn, initials } from '@/lib/utils';

type NewConversationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (threadId: string, thread?: ChatThreadDetail) => void;
  viewerUsername?: string;
};

const accountLabels = { STUDENT: 'Student', COACH: 'Coach', CLUB: 'Club' } as const;
const accountIcons = { STUDENT: UserRound, COACH: UsersRound, CLUB: Building2 } as const;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'That conversation could not be opened. Please try again.';
}

function searchableLength(value: string) {
  const trimmed = value.trim();
  return (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).length;
}

/** Search public account profiles without mixing discovery into the inbox filter. */
export function NewConversationDialog({ open, onOpenChange, onCreated, viewerUsername }: NewConversationDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AccountDirectoryUser[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openingUsername, setOpeningUsername] = useState<string | null>(null);
  const request = useRef(0);
  const searchId = useId();
  const helpId = useId();

  useEffect(() => {
    if (open) return;
    request.current += 1;
    setQuery('');
    setResults([]);
    setSearched(false);
    setLoading(false);
    setError('');
    setOpeningUsername(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const value = query.trim();
    if (searchableLength(value) < 3) {
      request.current += 1;
      setResults([]);
      setSearched(false);
      setLoading(false);
      setError('');
      return;
    }

    const current = ++request.current;
    setLoading(true);
    setSearched(false);
    setError('');
    const timer = window.setTimeout(() => {
      void searchAccounts(value)
        .then(accounts => {
          if (current !== request.current) return;
          setResults(accounts.filter(account => account.username.toLowerCase() !== viewerUsername?.toLowerCase()));
          setSearched(true);
        })
        .catch(cause => {
          if (current !== request.current) return;
          setResults([]);
          setSearched(true);
          setError(messageOf(cause));
        })
        .finally(() => {
          if (current === request.current) setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, query, viewerUsername]);

  async function openConversation(account: AccountDirectoryUser) {
    if (openingUsername) return;
    setOpeningUsername(account.username);
    setError('');
    try {
      const result = await createAccountChat(account.username);
      onOpenChange(false);
      onCreated(result.threadId, result.thread);
    } catch (cause) {
      setError(messageOf(cause));
      setOpeningUsername(null);
    }
  }

  return <Dialog open={open} onOpenChange={next => { if (!openingUsername) onOpenChange(next); }}>
    <DialogContent className="max-w-lg" onEscapeKeyDown={event => { if (openingUsername) event.preventDefault(); }}>
      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#e8efe0] text-[#214e3e]"><MessageCircle size={20} aria-hidden="true" /></span>
      <DialogTitle className="!mt-4 text-lg font-semibold text-[#263a30]">New conversation</DialogTitle>
      <DialogDescription className="!mt-2 text-xs leading-relaxed text-[#59675c]">
        Find a student, coach or club by name or username. Your existing conversation opens if you have already messaged them.
      </DialogDescription>

      <div className="mt-5">
        <label htmlFor={searchId}>Find an account</label>
        <div className="relative">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#59675c]" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Name, @username or exact email"
            className="!rounded-xl !pl-10"
            autoComplete="off"
            autoFocus
            aria-describedby={helpId}
          />
        </div>
        <p id={helpId} className="!mt-2 text-[11px] leading-relaxed text-[#59675c]">Enter at least 3 characters. Account results are separate from the conversation filter.</p>
      </div>

      <div className="mt-4 min-h-24" aria-live="polite">
        {loading ? <p role="status" className="flex items-center justify-center gap-2 rounded-xl bg-[#f5f7f1] p-5 text-xs text-[#59675c]"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Searching accounts…</p>
          : error ? <p role="alert" className="rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-3 text-xs leading-relaxed text-[#8b4d3c]">{error}</p>
            : searched && !results.length ? <p className="rounded-xl bg-[#f5f7f1] p-5 text-center text-xs leading-relaxed text-[#59675c]">No accounts match that search.</p>
              : results.length ? <ul aria-label="Account search results" className="max-h-[min(48dvh,24rem)] space-y-2 overflow-y-auto overscroll-contain pr-1">
                {results.map(account => {
                  const Icon = accountIcons[account.accountType];
                  const opening = openingUsername === account.username;
                  return <li key={`${account.accountType}-${account.username}`}>
                    <button
                      type="button"
                      onClick={() => void openConversation(account)}
                      disabled={!!openingUsername}
                      className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-[#e1e6df] bg-white px-3 py-2.5 text-left transition hover:border-[#bdcab8] hover:bg-[#f7f9f4] disabled:opacity-60"
                    >
                      <span aria-hidden="true" className={cn(
                        'grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-semibold',
                        account.accountType === 'CLUB' ? 'bg-[#e7edf3] text-[#49667b]' : 'bg-[#e8dccc] text-[#6f5738]',
                      )}>{account.accountType === 'CLUB' ? <Icon size={18} /> : initials(account.name)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-semibold text-[#263a30]">{account.name}</span>
                          <span className="badge shrink-0 !py-0.5">{accountLabels[account.accountType]}</span>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-[#59675c]">@{account.username}{account.sports.length ? ` · ${account.sports.join(', ')}` : ''}</span>
                      </span>
                      {opening ? <Loader2 size={16} className="shrink-0 animate-spin text-[#214e3e]" aria-label="Opening conversation" /> : <MessageCircle size={17} className="shrink-0 text-[#5f7a51]" aria-hidden="true" />}
                    </button>
                  </li>;
                })}
              </ul>
                : <p className="rounded-xl bg-[#f5f7f1] p-5 text-center text-xs leading-relaxed text-[#59675c]">Search results will appear here.</p>}
      </div>
    </DialogContent>
  </Dialog>;
}
