import type { MetadataRoute } from 'next';

// Installable, but deliberately without a service worker: authenticated booking data must never be served stale from an offline cache.
export default function manifest(): MetadataRoute.Manifest {
  return {
    // '/' routes every account type: students to /manage, providers to their
    // workspace, and signed-out people to login.
    id: '/',
    name: 'Courtly',
    short_name: 'Courtly',
    description: 'Book Classes, follow your schedule, and read coach feedback from every club you train with.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'en',
    background_color: '#f7f8f5',
    theme_color: '#214e3e',
    categories: ['sports', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
