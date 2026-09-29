import type { AccountRequiredAction, AgeBand, FamilyChild } from '@/lib/types';

export const familyUsernamePattern = /^[a-z0-9_]{3,30}$/;
const singaporeDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Return Courtly's policy date, independent of the browser or server timezone. */
export function singaporeCivilDate(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  const parts = singaporeDateFormatter.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function familySports(value: string): string[] | null {
  if (!value.trim()) return [];
  const entries = value.split(',').map(sport => sport.trim());
  if (entries.some(sport => !sport) || entries.length > 20 || entries.some(sport => sport.length > 40)) return null;
  const seen = new Set<string>();
  return entries.filter(sport => {
    const key = sport.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validPastDate(value: string, today = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.getUTCFullYear() >= 1900
    && parsed.toISOString().slice(0, 10) === value
    && value <= singaporeCivilDate(today);
}

export function ageBandLabel(value: AgeBand | string | null | undefined): string {
  if (value === 'CHILD') return 'Child';
  if (value === 'TEEN') return 'Teen';
  if (value === 'ADULT') return 'Adult';
  return 'Age not reviewed';
}

export function childStatusLabel(child: Pick<FamilyChild, 'accountStatus' | 'accountControl'>): string {
  if (child.accountStatus === 'DELETION_REQUESTED') return 'Deletion requested';
  if (child.accountStatus === 'CONSENT_REQUIRED') return 'Consent required';
  return child.accountControl === 'GUARDIAN_MANAGED' ? 'Managed by guardian' : 'Self-managed';
}

export function hasCurrentFamilyConsent(child: FamilyChild, policyVersion: string): boolean {
  return child.link.status === 'ACTIVE'
    && child.accountStatus === 'ACTIVE'
    && child.consent?.status !== 'WITHDRAWN'
    && child.consent?.withdrawnAt == null
    && child.consent?.policyVersion === policyVersion;
}

/** The API supplies the age band; the browser never calculates handover age. */
export function canStartFamilyHandover(child: FamilyChild, policyVersion: string): boolean {
  return (child.ageBand === 'TEEN' || child.ageBand === 'ADULT')
    && child.accountControl === 'GUARDIAN_MANAGED'
    && hasCurrentFamilyConsent(child, policyVersion)
    && child.link.permissions.includes('HANDOVER_MANAGE')
    && child.handover?.status !== 'PENDING';
}

export function requiredActionCopy(action: AccountRequiredAction | null | undefined) {
  switch (action) {
    case 'CONSENT_REQUIRED':
      return { title: 'Guardian consent needs attention', detail: 'A parent or guardian must renew consent in Family before this account can continue.' };
    case 'GUARDIAN_SESSION_STALE':
      return { title: 'Ask your guardian to sign in', detail: 'This managed account needs a fresh guardian session before it can continue.' };
    case 'HANDOVER_REQUIRED':
      return { title: 'Account handover required', detail: 'Finish the verified handover before using this account independently.' };
    case 'DELETION_REQUESTED':
      return { title: 'Deletion request pending', detail: 'This account is restricted immediately while the deletion request awaits separate human review.' };
    case 'PARENT_ACCOUNT_REQUIRED':
      return { title: 'A parent or guardian must create this profile', detail: 'Children under 13 cannot create an independent sign-in. An adult can add a managed child from Family.' };
    default:
      return { title: 'Account action required', detail: 'Review your account before continuing.' };
  }
}
