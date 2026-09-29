import type { Prisma, User } from '@prisma/client';
import { prisma } from './db.js';
import { config } from './config.js';
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  evaluateAccountPolicy,
  type AccountControl,
  type AccountPolicyDecision,
  type AccountStatus,
  type AccountType,
  type ProfileVisibility,
} from './children-policy.js';

type PolicyUser = Pick<User,
  'accountType' | 'dateOfBirth' | 'accountControl' | 'accountStatus' | 'profileVisibility'
>;

type PolicyDb = Pick<Prisma.TransactionClient, 'guardianChildLink'>;

/**
 * Consent validity is derived from immutable evidence, never from a client
 * boolean. Handover/deletion audit events do not replace the latest consent
 * decision for a link.
 */
export async function hasCurrentChildConsent(
  childUserId: string,
  db: PolicyDb = prisma,
) {
  const links = await db.guardianChildLink.findMany({
    where: { childUserId, status: 'ACTIVE' },
    select: {
      consentRecords: {
        where: { eventType: { in: ['GRANTED', 'RENEWED', 'WITHDRAWN'] } },
        orderBy: { sequence: 'desc' },
        take: 1,
        select: { eventType: true, privacyPolicyVersion: true },
      },
    },
  });
  return links.some(link => {
    const latest = link.consentRecords[0];
    return (latest?.eventType === 'GRANTED' || latest?.eventType === 'RENEWED')
      && latest.privacyPolicyVersion === CURRENT_PRIVACY_POLICY_VERSION;
  });
}

export async function loadAccountPolicy(
  user: PolicyUser & { id: string },
  options: { sessionCreatedAt?: Date | null; db?: PolicyDb } = {},
): Promise<AccountPolicyDecision> {
  const hasCurrentConsent = user.accountControl === 'GUARDIAN_MANAGED'
    ? await hasCurrentChildConsent(user.id, options.db ?? prisma)
    : false;
  const policy = evaluateAccountPolicy({
    accountType: user.accountType as AccountType,
    dateOfBirth: user.dateOfBirth,
    accountControl: user.accountControl as AccountControl,
    accountStatus: user.accountStatus as AccountStatus,
    profileVisibility: user.profileVisibility as ProfileVisibility,
    hasCurrentConsent,
    sessionCreatedAt: options.sessionCreatedAt,
  });
  if (config.familyFeatureEnabled || !policy.capabilities.familyManagement) return policy;
  return Object.freeze({
    ...policy,
    capabilities: Object.freeze({ ...policy.capabilities, familyManagement: false }),
  });
}
