import { randomBytes } from 'node:crypto';
import { prisma } from '../src/db.js';
import { seedBusiness } from '../src/seed.js';

async function main() {
  // Stable identities belong only to this explicitly invoked CLI, never to demo requests.
  const slug = process.env.SEED_BUSINESS_SLUG?.trim() || 'marcus-tan';
  const clubEmail = process.env.SEED_CLUB_EMAIL?.trim().toLowerCase() || 'marcus@courtly.example';
  const businessName = process.env.SEED_BUSINESS_NAME?.trim() || 'Marcus Tan Racket Club';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new Error('SEED_BUSINESS_SLUG must be a URL-safe lowercase slug of at most 80 characters.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clubEmail)) throw new Error('SEED_CLUB_EMAIL must be a valid email address.');
  const generatedPassword = process.env.SEED_CLUB_PASSWORD ? undefined : randomBytes(18).toString('base64url');
  if (generatedPassword) process.env.SEED_CLUB_PASSWORD = generatedPassword;

  const result = await prisma.$transaction(async tx => {
    // Serialize concurrent runs without ever clearing or updating an existing tenant.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:seed:${slug}`}, 0))`;
    const existing = await tx.business.findUnique({ where: { slug } });
    if (existing) return { created: false as const, business: existing };
    if (await tx.user.findUnique({ where: { email: clubEmail } })) {
      throw new Error(`The club email ${clubEmail} is already in use. Choose another SEED_CLUB_EMAIL; no data was changed.`);
    }
    const seeded = await seedBusiness(tx, { slug, clubEmail, businessName, isDemo: false });
    return {
      created: true as const,
      business: seeded.business,
      clubAccount: seeded.clubAccount,
      clubMembership: seeded.clubMembership,
    };
  }, { maxWait: 10_000, timeout: 60_000 });

  if (!result.created) {
    console.log(`Seed skipped: /book/${slug} already exists. Existing tenant data and credentials were left untouched.`);
    return;
  }
  console.log(`Created ${result.business.name} with 35 lessons in the current Asia/Singapore week.`);
  console.log(`Booking page: /book/${result.business.slug}`);
  console.log(`Club sign-in email: ${clubEmail}`);
  if (generatedPassword) console.log(`Generated club password (save securely): ${generatedPassword}`);
  else console.log('Club password: the supplied SEED_CLUB_PASSWORD.');
}

main().catch(error => {
  console.error('Courtly seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
