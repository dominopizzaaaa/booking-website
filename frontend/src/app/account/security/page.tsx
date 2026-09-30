import type { Metadata } from 'next';
import { SecurityCenter } from '@/components/account-security/security-center';

export const metadata: Metadata = {
  title: 'Account security', description: 'Manage Courtly sign-in security and active sessions.',
  robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function Page() { return <SecurityCenter />; }
