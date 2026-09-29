import Link from 'next/link';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, CircleDot, Info, Mail, ShieldCheck } from 'lucide-react';
import { COURTLY_CONTACT_EMAIL, POLICY_EFFECTIVE_DATE, POLICY_EFFECTIVE_DATE_LABEL } from '@/lib/policies';

export type PolicySectionLink = { id: string; label: string };

export function PolicyPage({ title, description, version, approved, sections, children }: {
  title: string;
  description: string;
  version: string;
  approved: boolean;
  sections: readonly PolicySectionLink[];
  children: ReactNode;
}) {
  return <article className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
    <Link href="/legal" className="inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-sm font-semibold text-[#45673c] underline-offset-4 hover:underline">
      <ArrowLeft size={15} aria-hidden="true" /> All policies
    </Link>
    <header className="mt-5 rounded-3xl border border-[#dfe7d8] bg-white px-6 py-8 shadow-[0_20px_60px_rgba(31,69,51,0.06)] sm:px-10 sm:py-11">
      <p className="!mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[#596f4f]">Courtly policy</p>
      <h1 className="!text-3xl !font-semibold !leading-tight !tracking-[-0.8px] text-[#183c2e] sm:!text-5xl">{title}</h1>
      <p className="!mt-5 max-w-3xl text-base leading-7 text-[#58675d] sm:text-lg">{description}</p>
      <dl id="version-information" className="mt-7 flex flex-wrap gap-x-8 gap-y-3 border-t border-[#e8ece5] pt-5 text-sm">
        <div><dt className="font-semibold text-[#314b3b]">Version</dt><dd className="mt-1 text-[#59675c]">{version}</dd></div>
        <div><dt className="font-semibold text-[#314b3b]">{approved ? 'Effective' : 'Proposed effective date'}</dt><dd className="mt-1 text-[#59675c]"><time dateTime={POLICY_EFFECTIVE_DATE}>{POLICY_EFFECTIVE_DATE_LABEL}</time></dd></div>
        <div><dt className="font-semibold text-[#314b3b]">Publication status</dt><dd className="mt-1 text-[#59675c]">{approved ? 'Approved current policy' : 'Review draft; production acceptance is closed'}</dd></div>
      </dl>
    </header>
    <div className="mt-8 grid items-start gap-8 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12">
      <aside className="rounded-2xl border border-[#e1e7dd] bg-[#f1f5ed] p-5 lg:sticky lg:top-5">
        <nav aria-label={`Sections in ${title}`}>
          <h2 className="!text-sm !font-semibold text-[#304b39]">On this page</h2>
          <ol className="mt-3 space-y-1">
            {sections.map((section, index) => <li key={section.id}>
              <a href={`#${section.id}`} className="flex min-h-10 items-start gap-2 rounded-lg px-2 py-2 text-sm leading-5 text-[#58675d] hover:bg-white hover:text-[#214e3e]">
                <span aria-hidden="true" className="w-4 shrink-0 text-[#586b50]">{index + 1}.</span>{section.label}
              </a>
            </li>)}
          </ol>
        </nav>
      </aside>
      <div className="min-w-0 space-y-10 text-base leading-7 text-[#46564c]">{children}</div>
    </div>
  </article>;
}

export function PolicySection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-6">
    <h2 id={`${id}-heading`} className="!text-2xl !font-semibold !leading-snug !tracking-[-0.4px] text-[#1f4433]">{title}</h2>
    <div className="mt-4 space-y-4 [&_a]:font-semibold [&_a]:text-[#356148] [&_a]:underline [&_a]:underline-offset-2 [&_h3]:!mt-6 [&_h3]:!text-lg [&_h3]:!font-semibold [&_h3]:text-[#2c4938] [&_li]:pl-1 [&_ol]:ml-6 [&_ol]:list-decimal [&_ol]:space-y-2 [&_p]:leading-7 [&_ul]:ml-6 [&_ul]:list-disc [&_ul]:space-y-2">{children}</div>
  </section>;
}

export function PolicyCallout({ title, tone = 'info', children }: { title: string; tone?: 'info' | 'safety'; children: ReactNode }) {
  const safety = tone === 'safety';
  const Icon = safety ? AlertTriangle : Info;
  return <aside className={`rounded-2xl border p-5 ${safety ? 'border-[#ead4c5] bg-[#fff8f2]' : 'border-[#d9e5d2] bg-[#f4f8f1]'}`}>
    <div className="flex items-start gap-3"><Icon size={19} className={`mt-1 shrink-0 ${safety ? 'text-[#9a5d3e]' : 'text-[#56784e]'}`} aria-hidden="true" /><div><h3 className="!mt-0 !text-base !font-semibold">{title}</h3><div className="mt-2 space-y-3 text-sm leading-6">{children}</div></div></div>
  </aside>;
}

export function RolesTable() {
  return <div role="region" aria-label="Courtly and club responsibilities" tabIndex={0} className="overflow-x-auto rounded-2xl border border-[#e2e7df] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#45673c]">
    <table className="w-full min-w-[600px] border-collapse text-left text-sm">
      <caption className="sr-only">Product functions recorded for Courtly and the selected club</caption>
      <thead className="bg-[#f4f7f1] text-[#304b39]"><tr><th scope="col" className="px-4 py-3 font-semibold">Courtly product functions</th><th scope="col" className="px-4 py-3 font-semibold">Selected club information</th></tr></thead>
      <tbody className="align-top"><tr><td className="border-t border-[#e2e7df] px-4 py-4">Provides account, discovery, booking, communication, recordkeeping, and—where enabled—payment technology under the Courtly product name.</td><td className="border-t border-[#e2e7df] px-4 py-4">Configures the Class, facility rental, or Package shown in Courtly, including its price, schedule, coach, venue, and product rules. These product facts do not decide contracting, supply, payment-recipient, refund, or tax roles.</td></tr></tbody>
    </table>
  </div>;
}

export function ContactBlock({ privacy = false }: { privacy?: boolean }) {
  return <div className="rounded-2xl border border-[#dce7d5] bg-white p-5 shadow-sm">
    <div className="flex items-start gap-3">
      {privacy ? <ShieldCheck size={20} className="mt-0.5 shrink-0 text-[#56784e]" aria-hidden="true" /> : <Mail size={20} className="mt-0.5 shrink-0 text-[#56784e]" aria-hidden="true" />}
      <div><h3 className="!mt-0 !text-base !font-semibold">{privacy ? 'Data Protection contact' : 'Contact Courtly'}</h3><p className="!mt-2 text-sm">Email <a href={`mailto:${COURTLY_CONTACT_EMAIL}`}>{COURTLY_CONTACT_EMAIL}</a>. Please do not include passwords, full payment-card details, or unnecessary sensitive information.</p></div>
    </div>
  </div>;
}

export function LegalBrand() {
  return <span className="inline-flex items-center gap-2 text-xl font-bold tracking-[-0.8px] text-[#174c3c]"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#174c3c] text-[#d8e9bb]"><CircleDot size={25} strokeWidth={1.4} aria-hidden="true" /></span>Courtly<span aria-hidden="true" className="mt-2 h-1.5 w-1.5 rounded-full bg-[#a6bb7d]" /></span>;
}
