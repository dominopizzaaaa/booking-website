'use client';

import { use } from 'react';
import { PublicBooking } from '@/components/public-booking';

export default function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return <PublicBooking slug={slug} />;
}
