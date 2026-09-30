import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { RecentAuthProvider } from '@/components/account-security/recent-auth-provider';
import '@fontsource-variable/dm-sans';
import 'driver.js/dist/driver.css';
import './globals.css';
export const metadata: Metadata = { title: 'Courtly — Your coaching day, in sync', description: 'The thoughtful workspace for clubs and independent coaches. Bookings, students and locations, beautifully in sync.', applicationName: 'Courtly', appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Courtly' } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><RecentAuthProvider>{children}</RecentAuthProvider><Toaster position="bottom-right" richColors closeButton /></body></html>; }
