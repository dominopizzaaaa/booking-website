'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import type { FamilyChild, FamilyChildInput, FamilyChildUpdateInput, ProfileVisibility } from '@/lib/types';
import { POLICY_PATHS } from '@/lib/policies';
import { familySports, familyUsernamePattern, singaporeCivilDate, validPastDate } from './family-helpers';

const field = '!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base sm:!text-sm';
type SubmitValues = FamilyChildInput | FamilyChildUpdateInput;

export function ChildForm({ child, policyVersion, busy, onSubmit, onCancel }: {
  child?: FamilyChild; policyVersion: string; busy: boolean; onSubmit: (values: SubmitValues) => Promise<void>; onCancel?: () => void;
}) {
  const editing = !!child;
  const [error, setError] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) alertRef.current?.focus(); }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const legalName = String(form.get('legalName') || '').trim();
    const displayName = String(form.get('displayName') || '').trim();
    const sports = familySports(String(form.get('sports') || ''));
    const profileVisibility = String(form.get('profileVisibility') || 'PRIVATE') as Extract<ProfileVisibility, 'PRIVATE' | 'CLUBS_ONLY'>;
    if (legalName.length < 2 || displayName.length < 2) { setError('Enter both the child’s legal name and display name using at least two characters.'); return; }
    if (!sports) { setError('Separate sports with single commas and add up to 20, using no more than 40 characters for each.'); return; }
    if (!['PRIVATE', 'CLUBS_ONLY'].includes(profileVisibility)) { setError('Choose a valid profile visibility.'); return; }
    if (editing) {
      setError('');
      await onSubmit({ legalName, displayName, sports, profileVisibility });
      return;
    }
    const username = String(form.get('username') || '').trim().toLowerCase();
    const dateOfBirth = String(form.get('dateOfBirth') || '');
    const relationship = String(form.get('relationship') || '').trim();
    if (!familyUsernamePattern.test(username)) { setError('Choose a username with 3–30 lowercase letters, numbers, or underscores.'); return; }
    if (!validPastDate(dateOfBirth)) { setError('Enter the child’s complete date of birth.'); return; }
    if (relationship.length < 2) { setError('Describe your relationship to the child.'); return; }
    if (form.get('legalGuardianConfirmed') !== 'on' || form.get('policyConsent') !== 'on') { setError('Confirm legal guardianship and consent to the current privacy policy.'); return; }
    setError('');
    await onSubmit({ legalName, displayName, username, dateOfBirth, sports, relationship, profileVisibility, legalGuardianConfirmed: true, privacyPolicyVersion: policyVersion });
  }

  return <form onSubmit={event => void submit(event)} noValidate className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <div><label htmlFor={editing ? `child-legal-${child.id}` : 'child-legal'}>Legal name</label><input id={editing ? `child-legal-${child.id}` : 'child-legal'} name="legalName" className={field} defaultValue={child?.legalName || ''} minLength={2} maxLength={120} autoComplete="off" required disabled={busy} /><p className="mt-1.5 text-xs leading-relaxed text-[#59675c]">Private. Used for safety, consent, and data requests.</p></div>
      <div><label htmlFor={editing ? `child-display-${child.id}` : 'child-display'}>Display name</label><input id={editing ? `child-display-${child.id}` : 'child-display'} name="displayName" className={field} defaultValue={child?.displayName || ''} minLength={2} maxLength={120} autoComplete="off" required disabled={busy} /><p className="mt-1.5 text-xs leading-relaxed text-[#59675c]">The name clubs may see when permitted.</p></div>
      {!editing && <><div><label htmlFor="child-username">Username</label><input id="child-username" name="username" className={field} minLength={3} maxLength={30} pattern="[a-z0-9_]{3,30}" autoCapitalize="none" autoCorrect="off" required disabled={busy} /><p className="mt-1.5 text-xs text-[#59675c]">Lowercase letters, numbers, and underscores. This cannot be edited here later.</p></div>
      <div><label htmlFor="child-date-of-birth">Date of birth</label><input id="child-date-of-birth" name="dateOfBirth" type="date" className={field} min="1900-01-01" max={singaporeCivilDate()} autoComplete="off" required disabled={busy} /><p className="mt-1.5 text-xs text-[#59675c]">Private and required to apply the correct protections.</p></div>
      <div className="sm:col-span-2"><label htmlFor="child-relationship">Your relationship to this child</label><input id="child-relationship" name="relationship" className={field} maxLength={60} placeholder="Parent, legal guardian…" required disabled={busy} /></div></>}
      <div className="sm:col-span-2"><label htmlFor={editing ? `child-sports-${child.id}` : 'child-sports'}>Sports <span className="font-normal text-[#59675c]">optional</span></label><input id={editing ? `child-sports-${child.id}` : 'child-sports'} name="sports" className={field} defaultValue={child?.sports.join(', ') || ''} maxLength={819} placeholder="Tennis, badminton, padel" disabled={busy} /><p className="mt-1.5 text-xs text-[#59675c]">Separate multiple sports with commas.</p></div>
      <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm font-semibold text-[#4d5e51]">Profile visibility</legend><div className="grid gap-2 sm:grid-cols-2">{([['PRIVATE', 'Private', 'Only you and authorised Courtly operations can access this profile.'], ['CLUBS_ONLY', 'Clubs only', 'Clubs involved in the child’s Courtly activity may see permitted profile details.']] as const).map(([value, label, description]) => <label key={value} className="flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border border-[#dfe5df] bg-white p-3.5"><input type="radio" name="profileVisibility" value={value} defaultChecked={(child?.profileVisibility ?? 'PRIVATE') === value} disabled={busy} className="mt-1" /><span><span className="block text-sm font-semibold text-[#304b39]">{label}</span><span className="mt-1 block text-xs leading-relaxed text-[#59675c]">{description}</span></span></label>)}</div></fieldset>
    </div>
    {!editing && <div className="space-y-3 rounded-xl border border-[#dfe7d8] bg-[#f3f7ef] p-4">
      <label className="flex cursor-pointer items-start gap-3 text-sm font-medium text-[#304b39]"><input type="checkbox" name="legalGuardianConfirmed" required disabled={busy} className="mt-1" /><span>I confirm that I am this child’s parent or legal guardian and may manage their Courtly profile.</span></label>
      <label className="flex cursor-pointer items-start gap-3 text-sm font-medium text-[#304b39]"><input type="checkbox" name="policyConsent" required disabled={busy} className="mt-1" /><span>I consent to the current <Link href={POLICY_PATHS.childPrivacy} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Child Privacy Notice</Link> (version {policyVersion}) and understand I can withdraw consent later.</span></label>
      <p className="text-xs leading-relaxed text-[#59675c]">A managed child has no email, password, or sign-in. Family manages identity, privacy, consent, exports, deletion requests, verified handover, and guardian-authorized Class booking. It does not let you buy Packages, reserve rentals, or make other purchases on the child’s behalf.</p>
    </div>}
    {error && <div ref={alertRef} tabIndex={-1} role="alert" className="rounded-xl border border-[#e4c7bc] bg-[#fff6f1] p-3.5 text-sm text-[#8a4937] outline-none">{error}</div>}
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{onCancel && <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}<Button type="submit" disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{editing ? 'Save profile' : 'Add child'}</Button></div>
  </form>;
}
