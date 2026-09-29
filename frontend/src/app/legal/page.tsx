import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpenText, ShieldCheck } from 'lucide-react';
import { POLICY_DOCUMENTS, POLICY_EFFECTIVE_DATE, POLICY_EFFECTIVE_DATE_LABEL } from '@/lib/policies';
import { loadLegalPublicationApproval } from '@/lib/legal-publication';

export const metadata: Metadata = {
  title: 'Legal & policies',
  description: 'Read the policies that apply when you use Courtly or book with a club through Courtly.',
};

const descriptions = {
  privacy: 'How Courtly handles personal data, who receives it, and the choices available to you.',
  childPrivacy: 'A layered, child-friendly explanation of guardian-managed profiles and child data.',
  terms: 'The agreement for accounts and use of the Courtly platform.',
  acceptableUse: 'Community conduct, child-safety expectations, prohibited use, and how to report a concern.',
  cancellationRefunds: 'How Class and facility cancellation windows, credit returns, and money refunds work.',
  packageTerms: 'How club Packages, credits, eligible activities, expiry, and refunds work.',
} satisfies Record<(typeof POLICY_DOCUMENTS)[number]['key'], string>;

export default async function LegalIndexPage() {
  const approved = await loadLegalPublicationApproval();
  return <div className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
    <header className="max-w-3xl">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-[#dce6d5] bg-[#edf3e7] text-[#54704c]"><BookOpenText size={23} aria-hidden="true" /></span>
      <p className="!mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-[#596f4f]">Clear rules, shared court</p>
      <h1 className="!mt-2 !text-4xl !font-semibold !leading-tight !tracking-[-1px] text-[#183c2e] sm:!text-5xl">Legal &amp; policies</h1>
      <p className="!mt-5 text-base leading-7 text-[#58675d] sm:text-lg">These documents describe Courtly’s product functions and the selected club information recorded for bookings, facility rentals, and Packages. Product labels do not decide unresolved contracting, supply, payment-recipient, refund, or tax roles.</p>
      <p className="!mt-3 text-sm text-[#647267]">{approved ? <>Current approved set: version {POLICY_EFFECTIVE_DATE}, effective <time dateTime={POLICY_EFFECTIVE_DATE}>{POLICY_EFFECTIVE_DATE_LABEL}</time>.</> : <>Policy set under review: version {POLICY_EFFECTIVE_DATE}, proposed effective date <time dateTime={POLICY_EFFECTIVE_DATE}>{POLICY_EFFECTIVE_DATE_LABEL}</time>. Production acceptance is closed until the backend confirms this exact version and content hash.</>}</p>
    </header>
    <div className="mt-10 grid gap-4 md:grid-cols-2">
      {POLICY_DOCUMENTS.map(document => <Link key={document.key} href={document.path} className="group flex min-h-40 flex-col rounded-2xl border border-[#dee6da] bg-white p-6 shadow-[0_12px_34px_rgba(31,69,51,0.04)] transition hover:border-[#b8cbaa] hover:shadow-[0_16px_40px_rgba(31,69,51,0.08)]">
        <h2 className="!text-lg !font-semibold text-[#244936]">{document.title}</h2><p className="!mt-2 flex-1 text-sm leading-6 text-[#59675c]">{descriptions[document.key]}</p><span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#45673c]">Read policy <ArrowRight size={15} className="transition group-hover:translate-x-0.5" aria-hidden="true" /></span>
      </Link>)}
    </div>
    <aside className="mt-10 flex items-start gap-3 rounded-2xl border border-[#dce7d5] bg-[#f1f6ed] p-5 text-sm leading-6 text-[#526359]"><ShieldCheck size={20} className="mt-0.5 shrink-0 text-[#56784e]" aria-hidden="true" /><p>Club-specific information shown before a booking or purchase—such as the selected club, checkout amount, venue, time, eligibility, and cancellation window—is transaction-specific product information. It does not by itself identify the contracting seller, service provider, payment recipient, refund owner, GST supplier, or final unavoidable price. Mandatory legal rights still apply.</p></aside>
  </div>;
}
