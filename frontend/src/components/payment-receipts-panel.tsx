'use client';

import { Download, ExternalLink, LoaderCircle, ReceiptText, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, loadPaymentReceipts, paymentReceiptDocumentUrl } from '@/lib/api';
import type { PaymentReceipt } from '@/lib/types';
import { cn, money, shortDate } from '@/lib/utils';

const panel = 'rounded-2xl border border-[#dfe7da] bg-white shadow-[0_12px_38px_rgba(40,63,48,0.06)]';
const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[#d7e0d1] bg-white px-3 text-xs font-semibold text-[#355644] transition hover:border-[#b6c7ad]';

function messageOf(error: unknown) {
  return error instanceof ApiError || error instanceof Error ? error.message : 'Payment receipts could not be loaded.';
}

function refundLabel(receipt: PaymentReceipt) {
  if (receipt.refundStatus === 'NONE') return receipt.paymentStatus === 'PAID' ? 'Paid' : 'Reversed';
  if (receipt.refundStatus === 'REFUNDED') return 'Refunded';
  if (receipt.refundStatus === 'PARTIALLY_REFUNDED') return `Partially refunded (${money(receipt.refundedAmount, receipt.currency)})`;
  if (receipt.refundStatus === 'PENDING') return 'Refund pending';
  if (receipt.refundStatus === 'FAILED') return 'Refund failed';
  return 'Refund cancelled';
}

export function PaymentReceiptsPanel({ className = '' }: { className?: string }) {
  const [receipts, setReceipts] = useState<PaymentReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function refresh() {
    setLoading(true);
    setError('');
    void loadPaymentReceipts()
      .then(result => setReceipts(result.receipts))
      .catch(reason => setError(messageOf(reason)))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  return (
    <section className={cn(panel, 'p-5 sm:p-6', className)} aria-labelledby="payment-receipts-heading">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf3e7] text-[#4f6847]"><ReceiptText size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="payment-receipts-heading" className="text-sm font-semibold text-[#3f4c42]">Payment receipts</h2>
          <p className="mt-1 text-xs leading-relaxed text-[#59675c]">Documents for confirmed online Class and Package payments. These are payment receipts, not tax invoices.</p>
        </div>
      </div>
      {loading ? <p role="status" className="mt-5 flex items-center gap-2 text-xs text-[#59675c]"><LoaderCircle size={14} className="animate-spin" /> Loading receipts…</p>
        : error ? <div className="mt-5"><p role="alert" className="text-xs text-[#8b4d3c]">{error}</p><button type="button" className={cn(button, 'mt-3')} onClick={refresh}><RefreshCw size={14} /> Try again</button></div>
          : receipts.length ? <div className="mt-5 divide-y divide-[#edf0e9] border-y border-[#edf0e9]">{receipts.map(receipt => (
            <article key={receipt.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-[#304b39]">{receipt.item.label}</p><p className="mt-1 text-[11px] text-[#59675c]">{receipt.merchant.tradingName} · {shortDate(receipt.issuedAt)}</p><p className="mt-1 font-mono text-[10px] text-[#59675c]">{receipt.receiptNumber}</p></div><div className="text-right"><p className="text-sm font-semibold text-[#304b39]">{money(receipt.amount, receipt.currency)}</p><p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-[#59675c]">{refundLabel(receipt)}</p></div></div>
              <div className="mt-3 flex flex-wrap gap-2"><a className={button} href={paymentReceiptDocumentUrl(receipt.id)} target="_blank" rel="noreferrer"><ExternalLink size={14} /> View</a><a className={button} href={paymentReceiptDocumentUrl(receipt.id, true)}><Download size={14} /> Download</a></div>
            </article>
          ))}</div> : <p className="mt-5 text-xs leading-relaxed text-[#59675c]">No online payment receipts have been issued yet.</p>}
    </section>
  );
}
