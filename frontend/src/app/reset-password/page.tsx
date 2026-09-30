import type { Metadata } from 'next';
import { ResetPasswordPage } from '@/components/account-security/public-security-pages';

export const metadata: Metadata = {
  title: 'Reset password', description: 'Choose a new password for a Courtly account.',
  robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function Page() { return <ResetPasswordPage />; }
