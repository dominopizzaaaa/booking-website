'use client';

import { useState } from 'react';
import { Award, Eye, Languages, Loader2, Pencil, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { updateAuthAccount } from '@/lib/api';
import {
  coachProfileError, coachProfileFromDraft, coachProfileLimits, coachingAgeGroupLabel, coachingAgeGroupOptions,
  coachingLevelLabel, coachingLevelOptions, draftFromCoachProfile, emptyCoachProfile, profileIsEmpty, yearsCoachingLabel,
  type CoachProfileDraft,
} from '@/lib/coach-profile';
import type { CoachProfile, WorkspaceUser } from '@/lib/types';
import { initials } from '@/lib/utils';

/**
 * The coach's portable profile: one account, shown on the booking page of
 * every club that has them on its roster. Qualifications are the coach's own
 * words, and both the editor and the preview say so.
 */
export function CoachProfilePanel({ user, refresh }: { user: WorkspaceUser; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const profile = user.coachProfile ?? emptyCoachProfile;
  const sports = user.sports ?? [];
  return <section className="panel overflow-hidden" aria-labelledby="coach-profile-heading">
    <div className="panel-heading flex-wrap">
      <div className="flex items-center gap-2"><Sparkles size={17} className="text-[#839677]" aria-hidden="true" /><h2 id="coach-profile-heading" className="text-[#294735]">Coaching profile</h2></div>
      <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil size={13} aria-hidden="true" />Edit coaching profile</Button>
    </div>
    <div className="px-5 pb-5 sm:px-6 sm:pb-6">
      <p className="mb-3 text-xs leading-relaxed text-[#59675c]">Students see this card on the booking page of every club you coach for.</p>
      <CoachCardPreview name={user.name} sports={sports} profile={profile} />
    </div>
    {editing && <CoachProfileDialog user={user} onClose={() => setEditing(false)} refresh={refresh} />}
  </section>;
}

export function CoachCardPreview({ name, sports, profile }: { name: string; sports: readonly string[]; profile: CoachProfile }) {
  const years = yearsCoachingLabel(profile.coachingSince);
  const empty = profileIsEmpty(profile, sports);
  return <article aria-label={`Preview of ${name}'s coach card`} className="rounded-2xl border border-[#e3e8df] bg-white p-4 shadow-sm">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#e8dccc] text-sm font-semibold text-[#6f5738]">{initials(name)}</span>
      <div className="min-w-0">
        {/* Not a heading: the profile page already names this person once. */}
        <p className="truncate text-sm font-semibold text-[#294735]">{name}</p>
        {sports.length > 0 && <p className="!mt-0.5 text-[11px] text-[#59675c]">{sports.join(' · ')}</p>}
        {years && <p className="!mt-0.5 text-[11px] text-[#59675c]">{years}</p>}
      </div>
    </div>
    {profile.bio ? <p className="!mt-3 whitespace-pre-line text-xs leading-relaxed text-[#3b4d41]">{profile.bio}</p>
      : empty ? <p className="!mt-3 text-xs italic text-[#59675c]">Only your name appears until you add a few details.</p> : null}
    {(profile.coachingLevels.length > 0 || profile.coachingAgeGroups.length > 0) && <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Levels and age groups coached">
      {profile.coachingLevels.map(level => <li key={level} className="badge">{coachingLevelLabel(level)}</li>)}
      {profile.coachingAgeGroups.map(group => <li key={group} className="badge completed">{coachingAgeGroupLabel(group)}</li>)}
    </ul>}
    {profile.languages.length > 0 && <p className="!mt-3 flex items-start gap-1.5 text-[11px] text-[#59675c]"><Languages size={13} className="mt-0.5 shrink-0" aria-hidden="true" />Speaks {profile.languages.join(', ')}</p>}
    {profile.qualifications.length > 0 && <div className="mt-3 rounded-xl bg-[#f7f9f4] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[#405941]"><Award size={13} aria-hidden="true" />Self-reported qualifications</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[11px] text-[#3b4d41]">{profile.qualifications.map(item => <li key={item}>{item}</li>)}</ul>
      <p className="!mt-1.5 text-[11px] text-[#59675c]">Provided by the coach. Courtly does not verify qualifications.</p>
    </div>}
  </article>;
}

function CoachProfileDialog({ user, onClose, refresh }: { user: WorkspaceUser; onClose: () => void; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<CoachProfileDraft>(() => draftFromCoachProfile(user.coachProfile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const preview = coachProfileFromDraft(draft);
  const currentYear = new Date().getFullYear();
  const set = (change: Partial<CoachProfileDraft>) => { setDraft(current => ({ ...current, ...change })); setError(''); };
  const toggle = <T extends string>(list: T[], value: T, checked: boolean) => checked ? [...list.filter(item => item !== value), value] : list.filter(item => item !== value);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const coachProfile = coachProfileFromDraft(draft);
    const problem = coachProfileError(coachProfile, currentYear);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError('');
    try {
      await updateAuthAccount({ coachProfile });
      toast.success('Coaching profile saved');
      try { await refresh(); } catch { /* the save succeeded; the next load will show it */ }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your coaching profile could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="max-w-3xl p-0" onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}>
      <div className="px-5 pt-5 sm:px-6 sm:pt-6">
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#173f2f]">Edit coaching profile</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">This travels with your coach account to every club that adds you. Your email and phone are never shown.</DialogDescription>
      </div>
      <form onSubmit={submit} className="mt-5">
        <div className="grid gap-5 px-5 sm:px-6 md:grid-cols-[minmax(0,1fr)_minmax(0,260px)]">
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <div>
              <label htmlFor="coach-bio">Bio</label>
              <textarea id="coach-bio" rows={4} maxLength={coachProfileLimits.bio} value={draft.bio} onChange={event => set({ bio: event.target.value })} aria-describedby="coach-bio-count" placeholder="How you coach, who you love working with, and what students can expect" />
              <p id="coach-bio-count" className="!mt-1 text-right text-[11px] text-[#59675c]">{draft.bio.length}/{coachProfileLimits.bio}</p>
            </div>
            <div>
              <label htmlFor="coach-languages">Languages</label>
              <input id="coach-languages" value={draft.languages} onChange={event => set({ languages: event.target.value })} aria-describedby="coach-languages-hint" placeholder="English, Mandarin" />
              <p id="coach-languages-hint" className="!mt-1 text-[11px] text-[#59675c]">Separate with commas. Up to {coachProfileLimits.languages}.</p>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-[#4d5e51]">Levels you coach</legend>
              <div className="grid grid-cols-2 gap-2">{coachingLevelOptions.map(option => <label key={option.value} className="mb-0 flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[#e1e7dc] px-3 text-xs font-medium text-[#344b39]"><input type="checkbox" checked={draft.coachingLevels.includes(option.value)} onChange={event => set({ coachingLevels: toggle(draft.coachingLevels, option.value, event.target.checked) })} />{option.label}</label>)}</div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-[#4d5e51]">Age groups you coach</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{coachingAgeGroupOptions.map(option => <label key={option.value} className="mb-0 flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[#e1e7dc] px-3 text-xs font-medium text-[#344b39]"><input type="checkbox" checked={draft.coachingAgeGroups.includes(option.value)} onChange={event => set({ coachingAgeGroups: toggle(draft.coachingAgeGroups, option.value, event.target.checked) })} />{option.label}</label>)}</div>
            </fieldset>
            <div>
              <label htmlFor="coach-qualifications">Qualifications (self-reported)</label>
              <textarea id="coach-qualifications" rows={3} value={draft.qualifications} onChange={event => set({ qualifications: event.target.value })} aria-describedby="coach-qualifications-hint" placeholder={'One per line, e.g.\nITF Level 1 Coach'} />
              <p id="coach-qualifications-hint" className="!mt-1 text-[11px] leading-relaxed text-[#59675c]">One per line, up to {coachProfileLimits.qualifications}. Students see these labelled as self-reported; Courtly does not verify them.</p>
            </div>
            <div>
              <label htmlFor="coach-since">Coaching since</label>
              <input id="coach-since" type="number" inputMode="numeric" min={coachProfileLimits.coachingSinceMin} max={currentYear} step={1} value={draft.coachingSince} onChange={event => set({ coachingSince: event.target.value })} aria-describedby="coach-since-hint" placeholder={String(currentYear - 5)} />
              <p id="coach-since-hint" className="!mt-1 text-[11px] text-[#59675c]">The year you started coaching. Leave blank to hide it.</p>
            </div>
          </fieldset>
          <div className="min-w-0">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[#405941]"><Eye size={14} aria-hidden="true" />How your card appears on booking pages</p>
            <CoachCardPreview name={user.name} sports={user.sports ?? []} profile={preview} />
          </div>
        </div>
        {error && <p role="alert" className="mx-5 mt-4 rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700 sm:mx-6">{error}</p>}
        <div className="sticky bottom-0 mt-6 flex justify-end gap-2 border-t border-[#e7ebe2] bg-white/95 px-5 py-4 backdrop-blur sm:px-6">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving} className="max-sm:flex-1">Cancel</Button>
          <Button type="submit" disabled={saving} className="max-sm:flex-1">{saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{saving ? 'Saving…' : 'Save coaching profile'}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
