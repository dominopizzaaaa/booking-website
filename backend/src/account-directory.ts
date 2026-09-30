import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { skipRateLimits } from './config.js';
import { sharedRateLimit } from './rate-limit.js';
import { prisma } from './db.js';
import { requireAuth } from './auth.js';
import { asyncRoute, HttpError, type AccountRequest } from './http.js';
import { loadAccountPolicy } from './account-policy.js';
import { CHILD_AGE, parseDateOfBirth, SINGAPORE_TIME_ZONE } from './children-policy.js';

const directoryQuery = z.object({
  q: z.string().trim().min(3).max(80)
    .refine(value => !value.startsWith('@') || value.length >= 4, 'Enter at least 3 username characters'),
}).strict();

const directoryAccountSelect = {
  id: true, name: true, username: true, accountType: true, sports: true,
  dateOfBirth: true, accountControl: true, accountStatus: true, profileVisibility: true,
} satisfies Prisma.UserSelect;

const registeredAccountSelect = {
  id: true, name: true, username: true, email: true, accountType: true, sports: true, passwordHash: true,
  dateOfBirth: true, accountControl: true, accountStatus: true, profileVisibility: true,
} satisfies Prisma.UserSelect;

/**
 * Cheap database prefilter for public identity candidates. The shared account
 * policy remains authoritative below; this bound keeps hidden child accounts
 * from displacing eligible results in the 20-row directory window.
 */
function discoverableAccountWhere(now: Date): Prisma.UserWhereInput {
  const oldestChildBirthday = DateTime.fromJSDate(now, { zone: SINGAPORE_TIME_ZONE })
    .startOf('day').minus({ years: CHILD_AGE }).toISODate();
  if (!oldestChildBirthday) throw new TypeError('Could not derive the current Singapore date');
  const minimumAgeDateOfBirth = parseDateOfBirth(oldestChildBirthday);
  return {
    passwordHash: { not: null },
    accountControl: 'SELF',
    accountStatus: 'ACTIVE',
    profileVisibility: 'PUBLIC',
    AND: [{
      OR: [
        // Legacy accounts without a reviewed DOB retain established access.
        { dateOfBirth: null },
        { dateOfBirth: { lte: minimumAgeDateOfBirth } },
      ],
    }],
  };
}

const accountDirectoryLimit = sharedRateLimit({
  name: 'account-directory',
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
  const now = new Date();
  const exact = await tx.user.findFirst({
    where: {
      ...discoverableAccountWhere(now),
      OR: [
        { username: { equals: canonical, mode: 'insensitive' } },
        { email: { equals: query.toLowerCase(), mode: 'insensitive' } },
      ],
    },
    select: registeredAccountSelect,
  });
  if (exact && (await loadAccountPolicy(exact, { db: tx })).publiclyDiscoverable) return exact;

  const nameMatches = await tx.user.findMany({
    where: {
      ...discoverableAccountWhere(now),
      name: { equals: query, mode: 'insensitive' },
    },
    select: registeredAccountSelect,
    orderBy: { id: 'asc' },
    take: 2,
  });
  const discoverableNameMatches = (await Promise.all(nameMatches.map(async account => ({
    account, policy: await loadAccountPolicy(account, { db: tx }),
  })))).filter(candidate => candidate.policy.publiclyDiscoverable).map(candidate => candidate.account);
  if (discoverableNameMatches.length > 1) {
    throw new HttpError(409, 'More than one account has this name. Use the exact username or email instead.');
  }
  return discoverableNameMatches[0] ?? null;
}

export const accountDirectoryRouter = Router();

accountDirectoryRouter.get('/accounts/search', requireAuth, accountDirectoryLimit, asyncRoute(async (req, res) => {
  const { q } = directoryQuery.parse(req.query);
  const usernameQuery = q.startsWith('@') ? q.slice(1) : q;
  const now = new Date();
  const accounts = await prisma.user.findMany({
    where: {
      id: { not: req.auth!.user.id },
      ...discoverableAccountWhere(now),
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
  const discoverableAccounts = (await Promise.all(accounts.map(async account => ({
    account, policy: await loadAccountPolicy(account),
  })))).filter(candidate => candidate.policy.publiclyDiscoverable);
  res.json(discoverableAccounts.map(({ account }) => ({
    name: account.name, username: account.username, accountType: account.accountType, sports: account.sports,
  })));
}));
