import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import { RecentAuthProvider } from '@/components/account-security/recent-auth-provider';
import '@fontsource-variable/dm-sans';
import 'driver.js/dist/driver.css';
import './globals.css';
// Declaring `icons` replaces Next's file-based icon link, so app/icon.svg is listed explicitly beside the Apple home-screen icon.
export const metadata: Metadata = { title: 'Courtly — Your coaching day, in sync', description: 'The thoughtful workspace for clubs and independent coaches. Bookings, students and locations, beautifully in sync.', applicationName: 'Courtly', appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Courtly' }, icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }], apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] } };
export const viewport: Viewport = { themeColor: '#214e3e' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><RecentAuthProvider>{children}</RecentAuthProvider><Toaster position="bottom-right" richColors closeButton /></body></html>; }
