import type { Metadata } from 'next';
import { ForgotPasswordPage } from '@/components/account-security/public-security-pages';

export const metadata: Metadata = {
  title: 'Forgot password', description: 'Request a secure Courtly password reset.',
  robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function Page() { return <ForgotPasswordPage />; }
