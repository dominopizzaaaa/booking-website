import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LegalBrand } from '@/components/legal/policy-page';
import { COURTLY_CONTACT_EMAIL, POLICY_DOCUMENTS } from '@/lib/policies';

export const metadata: Metadata = {
  title: { default: 'Legal & policies | Courtly', template: '%s | Courtly' },
  description: 'Courtly privacy, service, safety, cancellation, refund, and package policies.',
};

export default function LegalLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[#f7f8f5] text-[#263a30]">
    <a href="#legal-content" className="sr-only fixed left-3 top-3 z-50 rounded-lg bg-white px-4 py-3 font-semibold text-[#174c3c] shadow-lg focus:not-sr-only">Skip to policy content</a>
    <header className="border-b border-[#e1e7dd] bg-white">
      <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
        <Link href="/login" aria-label="Courtly sign in" className="inline-flex min-h-11 items-center"><LegalBrand /></Link>
        <Link href="/legal" className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-[#45673c] hover:bg-[#f3f6ef]">Legal &amp; policies</Link>
      </div>
    </header>
    <main id="legal-content">{children}</main>
    <footer className="border-t border-[#dfe6da] bg-[#edf3e9]">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:px-10">
        <nav aria-label="Legal documents" className="flex flex-wrap gap-x-5 gap-y-2">{POLICY_DOCUMENTS.map(document => <Link key={document.key} href={document.path} className="inline-flex min-h-10 items-center text-sm font-medium text-[#45634c] underline-offset-4 hover:underline">{document.shortTitle}</Link>)}</nav>
        <p className="!mt-5 text-sm leading-6 text-[#59675c]">Questions about these policies? Email <a className="font-semibold text-[#365c43] underline underline-offset-2" href={`mailto:${COURTLY_CONTACT_EMAIL}`}>{COURTLY_CONTACT_EMAIL}</a>.</p>
      </div>
    </footer>
  </div>;
}
