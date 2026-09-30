import type { Metadata } from 'next';
import Link from 'next/link';
import { COURTLY_CONTACT_EMAIL } from '@/lib/policies';

export const metadata: Metadata = {
  title: 'Security reporting | Courtly',
  description: 'How to report a potential Courtly security issue.',
};

export default function SecurityPage() {
  return <main className="min-h-screen bg-[#f7f8f5] px-5 py-12 text-[#263a30] sm:px-8">
    <article className="mx-auto max-w-2xl rounded-3xl border border-[#dfe6da] bg-white p-7 shadow-[0_16px_45px_rgba(31,69,51,0.06)] sm:p-10">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#596f4f]">Courtly</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-[-0.5px] text-[#183c2e]">Report a security issue</h1>
      <p className="mt-5 leading-7 text-[#58675d]">If you believe you found a security issue affecting Courtly, email <a className="font-semibold text-[#365c43] underline underline-offset-2" href={`mailto:${COURTLY_CONTACT_EMAIL}`}>{COURTLY_CONTACT_EMAIL}</a>. This is the existing privacy/DPO contact and is being used as the public security contact until a dedicated channel is approved.</p>
      <p className="mt-4 leading-7 text-[#58675d]">Include a concise description, the affected page or feature, and safe steps to reproduce. Do not include passwords, complete payment-card details, access tokens, or personal data that is not necessary to explain the issue. Do not disrupt the service or access another person's data while testing.</p>
      <aside className="mt-6 rounded-2xl border border-[#eadccf] bg-[#fff8f1] p-5 text-sm leading-6 text-[#76523d]"><strong>This mailbox is not an emergency service.</strong> No response time is promised. If anyone is in immediate danger, contact the appropriate local emergency service.</aside>
      <p className="mt-7 text-sm"><Link className="font-semibold text-[#45673c] underline underline-offset-2" href="/legal">Read Courtly's legal and privacy documents</Link></p>
    </article>
  </main>;
}
