'use client';

import { Suspense, use } from 'react';
import { PublicBooking, PublicBookingLoading } from '@/components/public-booking';

export default function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  // The page reads "Book again" and search preselection from the query string.
  return (
    <Suspense fallback={<PublicBookingLoading />}>
      <PublicBooking slug={slug} />
    </Suspense>
  );
}
