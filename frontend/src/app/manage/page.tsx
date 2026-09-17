import { StudentApp } from '@/components/student-app';

export default async function StudentBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string | string[] }>;
}) {
  const params = await searchParams;
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  return <StudentApp slug={slug} />;
}
