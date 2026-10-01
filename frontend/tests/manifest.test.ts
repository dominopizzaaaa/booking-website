import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../src/app/manifest';

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicFile = (src: string) => join(frontend, 'public', src.replace(/^\//, ''));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read width and height from the PNG header's first (IHDR) chunk. */
function pngSize(path: string) {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).equals(pngSignature), `${path} is not a PNG`).toBe(true);
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('web app manifest', () => {
  const value = manifest();

  it('declares the fields browsers require before offering installation', () => {
    expect(value).toMatchObject({
      name: 'Courtly',
      short_name: 'Courtly',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(value.description?.length).toBeGreaterThan(0);
    for (const color of [value.background_color, value.theme_color]) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(value.start_url!.startsWith(value.scope!)).toBe(true);
  });

  it('references real PNG icons whose pixels match their declared sizes', () => {
    const icons = value.icons ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      const path = publicFile(icon.src);
      expect(existsSync(path), `${icon.src} is missing from frontend/public`).toBe(true);
      const [width, height] = String(icon.sizes).split('x').map(Number);
      expect(pngSize(path), icon.src).toEqual({ width, height });
    }
    const declared = (purpose: string) => icons.filter(icon => (icon.purpose ?? 'any').split(' ').includes(purpose)).map(icon => icon.sizes);
    expect(declared('any')).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(declared('maskable')).toContain('512x512');
  });

  it('keeps the Apple home-screen icon referenced by the root layout on disk', () => {
    const layout = readFileSync(join(frontend, 'src/app/layout.tsx'), 'utf8');
    const apple = /apple:\s*\[\{\s*url:\s*'([^']+)'/.exec(layout)?.[1];
    expect(apple).toBe('/icons/apple-touch-icon.png');
    expect(pngSize(publicFile(apple!))).toEqual({ width: 180, height: 180 });
    expect(layout).toMatch(/themeColor:\s*'#214e3e'/);
  });

  it('ships without a service worker so signed-in booking data is never served from an offline cache', () => {
    expect(existsSync(join(frontend, 'public/sw.js'))).toBe(false);
    expect(existsSync(join(frontend, 'public/service-worker.js'))).toBe(false);
  });
});
