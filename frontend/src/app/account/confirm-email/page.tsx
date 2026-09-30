import type { Metadata } from 'next';
import { ConfirmEmailChangePage } from '@/components/account-security/public-security-pages';

export const metadata: Metadata = {
  title: 'Confirm email change', description: 'Confirm a new Courtly sign-in email.',
  robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function Page() { return <ConfirmEmailChangePage />; }
