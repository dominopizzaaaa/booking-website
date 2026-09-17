import { CustomerApp } from '@/components/customer-app';

export default async function CustomerBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string | string[] }>;
}) {
  const params = await searchParams;
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  return <CustomerApp slug={slug} />;
}
