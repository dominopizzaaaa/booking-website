import type { Metadata } from 'next';
import { MfaChallengePage } from '@/components/account-security/public-security-pages';

export const metadata: Metadata = {
  title: 'Two-step verification', description: 'Complete secure sign-in to Courtly.',
  robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function Page() { return <MfaChallengePage />; }
