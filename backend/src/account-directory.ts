import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { skipRateLimits } from './config.js';
import { prisma } from './db.js';
import { requireAuth } from './auth.js';
import { asyncRoute, HttpError, type AccountRequest } from './http.js';

const directoryQuery = z.object({
  q: z.string().trim().min(3).max(80)
    .refine(value => !value.startsWith('@') || value.length >= 4, 'Enter at least 3 username characters'),
}).strict();

const directoryAccountSelect = {
  name: true, username: true, accountType: true, sports: true,
} satisfies Prisma.UserSelect;

const registeredAccountSelect = {
  id: true, name: true, username: true, email: true, accountType: true, sports: true, passwordHash: true,
} satisfies Prisma.UserSelect;

const accountDirectoryLimit = rateLimit({
  windowMs: 5 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  // Authentication runs first, so a shared network does not make one user's
  // directory activity consume another user's privacy-sensitive search quota.
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'Too many account searches. Please wait a moment.' },
});

export async function resolveRegisteredAccountIdentity(
  tx: Prisma.TransactionClient,
  rawQuery: string,
) {
  const query = rawQuery.trim();
  const canonical = query.toLowerCase().replace(/^@/, '');
  const exact = await tx.user.findFirst({
    where: {
      passwordHash: { not: null },
      OR: [
        { username: { equals: canonical, mode: 'insensitive' } },
        { email: { equals: query.toLowerCase(), mode: 'insensitive' } },
      ],
    },
    select: registeredAccountSelect,
  });
  if (exact) return exact;

  const nameMatches = await tx.user.findMany({
    where: {
      passwordHash: { not: null },
      name: { equals: query, mode: 'insensitive' },
    },
    select: registeredAccountSelect,
    orderBy: { id: 'asc' },
    take: 2,
  });
  if (nameMatches.length > 1) {
    throw new HttpError(409, 'More than one account has this name. Use the exact username or email instead.');
  }
  return nameMatches[0] ?? null;
}

export const accountDirectoryRouter = Router();

accountDirectoryRouter.get('/accounts/search', requireAuth, accountDirectoryLimit, asyncRoute(async (req, res) => {
  const { q } = directoryQuery.parse(req.query);
  const usernameQuery = q.startsWith('@') ? q.slice(1) : q;
  const accounts = await prisma.user.findMany({
    where: {
      passwordHash: { not: null },
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: usernameQuery, mode: 'insensitive' } },
        // Avoid turning partial email fragments into an account-enumeration
        // oracle while retaining the requested exact-email lookup.
        { email: { equals: q.toLowerCase(), mode: 'insensitive' } },
      ],
    },
    select: directoryAccountSelect,
    orderBy: [{ name: 'asc' }, { username: 'asc' }, { id: 'asc' }],
    take: 20,
  });
  res.json(accounts);
}));
