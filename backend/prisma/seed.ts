import { randomBytes } from 'node:crypto';
import { prisma } from '../src/db.js';
import { seedBusiness } from '../src/seed.js';

async function main() {
  // Stable identities belong only to this explicitly invoked CLI, never to demo requests.
  const slug = process.env.SEED_BUSINESS_SLUG?.trim() || 'marcus-tan';
  const ownerEmail = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase() || 'marcus@courtly.example';
  const businessName = process.env.SEED_BUSINESS_NAME?.trim() || 'Marcus Tan Racket Club';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new Error('SEED_BUSINESS_SLUG must be a URL-safe lowercase slug of at most 80 characters.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('SEED_OWNER_EMAIL must be a valid email address.');
  const generatedPassword = process.env.SEED_OWNER_PASSWORD ? undefined : randomBytes(18).toString('base64url');
  if (generatedPassword) process.env.SEED_OWNER_PASSWORD = generatedPassword;

  const result = await prisma.$transaction(async tx => {
    // Serialize concurrent runs without ever clearing or updating an existing tenant.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:seed:${slug}`}, 0))`;
    const existing = await tx.business.findUnique({ where: { slug } });
    if (existing) return { created: false as const, business: existing };
    if (await tx.user.findUnique({ where: { email: ownerEmail } })) {
      throw new Error(`The owner email ${ownerEmail} is already in use. Choose another SEED_OWNER_EMAIL; no data was changed.`);
    }
    const seeded = await seedBusiness(tx, { slug, ownerEmail, businessName, isDemo: false });
    return { created: true as const, ...seeded };
  }, { maxWait: 10_000, timeout: 60_000 });

  if (!result.created) {
    console.log(`Seed skipped: /book/${slug} already exists. Existing tenant data and credentials were left untouched.`);
    return;
  }
  console.log(`Created ${result.business.name} with 35 lessons in the current Asia/Singapore week.`);
  console.log(`Booking page: /book/${result.business.slug}`);
  console.log(`Owner sign-in email: ${ownerEmail}`);
  if (generatedPassword) console.log(`Generated owner password (save securely): ${generatedPassword}`);
  else console.log('Owner password: the supplied SEED_OWNER_PASSWORD.');
}

main().catch(error => {
  console.error('Courtly seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
