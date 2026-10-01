'use client';

import { AlertTriangle, Clock3, RefreshCw, WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { loadAccountPackageActivity } from '@/lib/api';
import {
  balanceText, creditDeltaDescription, creditEventLabel, formatCreditDelta, packageWarnings, type PackageWarning,
} from '@/lib/package-insights';
import type { AccountPackage, CreditEvent, PackageActivity } from '@/lib/types';
import { cn, shortDate, time } from '@/lib/utils';
import { ErrorNotice, LoadingScreen } from './shared';
import { primaryButton, secondaryButton } from './styles';

function warningClass(kind: PackageWarning['kind']) {
  return kind === 'expiring' ? 'bg-[#f6ebd5] text-[#70582e]' : 'bg-[#f8e8e3] text-[#8b4d3c]';
}

/** Low-balance and expiry chips; renders nothing when the package is fine. */
export function PackageWarnings({ pkg, nowMs, className }: {
  pkg: Pick<AccountPackage, 'state' | 'remainingCredits' | 'expiresAt' | 'name'>; nowMs: number; className?: string;
}) {
  const warnings = packageWarnings(pkg, nowMs);
  if (!warnings.length) return null;
  return (
    <ul aria-label={`${pkg.name} reminders`} className={cn('flex flex-wrap gap-1.5', className)}>
      {warnings.map(warning => (
        <li key={warning.kind} className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold', warningClass(warning.kind))}>
          {warning.kind === 'expiring'
            ? <Clock3 size={11} aria-hidden="true" />
            : <AlertTriangle size={11} aria-hidden="true" />}
          {warning.text}
        </li>
      ))}
    </ul>
  );
}

function eventWhen(event: CreditEvent) {
  const zone = event.session?.timezone;
  return `${shortDate(event.createdAt, zone)} at ${time(event.createdAt, zone)}`;
}

/**
 * Every change to a package's credits, oldest first, with the balance after
 * each one — the ledger the database keeps, read back in plain words. A
 * package that ran out of time with credits left ends with an "Expired
 * unused" line so the arithmetic always closes.
 */
export function PackageActivityDialog({
  pkg,
  onClose,
  onBuyAnother,
}: {
  pkg: Pick<AccountPackage, 'id' | 'name' | 'business'> | null;
  onClose: () => void;
  onBuyAnother?: () => void;
}) {
  const [activity, setActivity] = useState<PackageActivity | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const packageId = pkg?.id ?? null;

  useEffect(() => {
    if (!packageId) return;
    let ignore = false;
    setActivity(null);
    setError('');
    loadAccountPackageActivity(packageId)
      .then(value => { if (!ignore) setActivity(value); })
      .catch(caught => { if (!ignore) setError(caught instanceof Error ? caught.message : 'Package activity could not be loaded.'); });
    return () => { ignore = true; };
  }, [packageId, attempt]);

  if (!pkg) return null;
  const summary = activity?.package;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">{pkg.name} activity</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
          Every credit added, used, returned or expired at {pkg.business.name}.
        </DialogDescription>

        {error ? (
          <div className="mt-5 space-y-3">
            <ErrorNotice message={error} />
            <button type="button" className={secondaryButton} onClick={() => setAttempt(value => value + 1)}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </button>
          </div>
        ) : !activity ? (
          <LoadingScreen compact text="Loading credit activity…" />
        ) : (
          <>
            {summary && (
              <dl className="mt-5 grid grid-cols-3 gap-2 rounded-xl bg-[#f6f8f3] p-3 text-center">
                <div>
                  <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Left</dt>
                  <dd className="mt-1 text-base font-semibold text-[#34533e]">{summary.remainingCredits}</dd>
                </div>
                <div>
                  <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Used</dt>
                  <dd className="mt-1 text-base font-semibold text-[#34533e]">{summary.usedCredits}</dd>
                </div>
                <div>
                  <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Expires</dt>
                  <dd className="mt-1 text-xs font-semibold text-[#34533e]">{shortDate(summary.expiresAt)}</dd>
                </div>
              </dl>
            )}
            {activity.events.length === 0 ? (
              <p className="mt-5 rounded-xl border border-dashed border-[#dfe5dc] p-5 text-center text-xs text-[#59675c]">
                No credit changes have been recorded for this package yet.
              </p>
            ) : (
              <ol aria-label="Credit history, oldest first" className="mt-5 divide-y divide-[#edf0e9] rounded-xl border border-[#e4e9df]">
                {activity.events.map(event => (
                  <li key={event.id} className="flex items-start gap-3 p-3">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'grid h-9 min-w-9 shrink-0 place-items-center rounded-full px-1.5 text-xs font-bold tabular-nums',
                        event.delta > 0 ? 'bg-[#e4eedb] text-[#3f5e33]' : event.delta < 0 ? 'bg-[#f6e3dc] text-[#8b4d3c]' : 'bg-[#eceeea] text-[#59675c]',
                      )}
                    >
                      {formatCreditDelta(event.delta)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-[#304b39]">
                        {creditEventLabel(event.kind)}
                        <span className="sr-only">: {creditDeltaDescription(event.delta)}</span>
                      </p>
                      {event.session && (
                        <p className="!mt-0.5 text-xs text-[#59675c]">
                          {event.session.serviceName} · {shortDate(event.session.startAt, event.session.timezone)} at {time(event.session.startAt, event.session.timezone)}
                        </p>
                      )}
                      {event.note && <p className="!mt-0.5 text-xs italic text-[#59675c]">{event.note}</p>}
                      <p className="!mt-0.5 text-[11px] text-[#59675c]">{event.kind === 'EXPIRED' ? `Expired ${shortDate(event.createdAt)}` : eventWhen(event)}</p>
                    </div>
                    <p className="shrink-0 text-right text-[11px] font-semibold text-[#456049]">{balanceText(event.balanceAfter)}</p>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}

        <div className="mt-6 flex flex-wrap gap-2.5 border-t border-[#edf0e8] pt-5">
          {onBuyAnother && (
            <button type="button" className={primaryButton} onClick={onBuyAnother}>
              <WalletCards size={15} aria-hidden="true" /> Buy another package
            </button>
          )}
          <button type="button" className={secondaryButton} onClick={onClose}>Close</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
