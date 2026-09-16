'use client';

import { use } from 'react';
import { ManageBooking } from '@/components/public-booking';

export default function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <ManageBooking token={token} />;
}
