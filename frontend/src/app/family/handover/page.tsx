import { Suspense } from 'react';
import { FamilyHandoverPage } from '@/components/family/handover-page';

export default function HandoverPage() {
  return <Suspense fallback={<main className="grid min-h-screen place-items-center bg-[#f6f7f4] text-sm text-[#59675c]">Opening secure handover…</main>}><FamilyHandoverPage /></Suspense>;
}
