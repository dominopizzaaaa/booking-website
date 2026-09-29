import type { Metadata } from 'next';
import { EmailVerificationPage } from '@/components/email-verification-page';

export const metadata: Metadata = {
  title: 'Verify email',
  description: 'Confirm the email address for a Courtly account.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function VerifyEmailPage() {
  return <EmailVerificationPage />;
}
