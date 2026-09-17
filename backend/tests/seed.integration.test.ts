import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBusiness } from '../src/seed.js';
import { prisma, verifyTestDatabase } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('seedBusiness', () => {
  it('snapshots the club money path on every seeded booking and student payment', async () => {
    const rollback = new Error('Roll back the seed fixture');

    await expect(prisma.$transaction(async tx => {
      const { business } = await seedBusiness(tx, {
        slug: `courtly-test-seed-${randomUUID()}`,
        isDemo: true,
      });
      expect(business.kind).toBe('CLUB');
      expect(await tx.booking.count({ where: { businessId: business.id } })).toBe(35);
      expect(await tx.booking.count({
        where: { businessId: business.id, paymentRoute: { not: 'CLUB' } },
      })).toBe(0);

      expect(await tx.payment.count({ where: { businessId: business.id } })).toBeGreaterThan(0);
      expect(await tx.payment.count({
        where: { businessId: business.id, kind: { not: 'STUDENT_TO_CLUB' } },
      })).toBe(0);

      throw rollback;
    }, { timeout: 60_000 })).rejects.toBe(rollback);
  }, 70_000);
});
