import type { Metadata } from 'next';
import { LegacyBooking } from '@/components/legacy-booking';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function LegacyManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <LegacyBooking token={token} />;
}
