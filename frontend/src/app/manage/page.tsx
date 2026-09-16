import { CustomerBookings } from '@/components/public-booking';

export default async function CustomerBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string | string[] }>;
}) {
  const params = await searchParams;
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  return <CustomerBookings slug={slug} />;
}
