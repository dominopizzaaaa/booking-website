'use client';

import { useRef, useState, type ReactNode } from 'react';
import {
  Award, CalendarClock, Check, GraduationCap, Languages, Loader2, MessageSquareQuote, Pencil, Plus, Sparkles, UsersRound, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { updateAuthAccount } from '@/lib/api';
import {
  absorbEntries, coachProfileChecklist, coachProfileError, coachProfileFromDraft, coachProfileLimits, coachingAgeGroupLabel,
  coachingAgeGroupOptions, coachingLevelLabel, coachingLevelOptions, distinctEntries, draftFromCoachProfile, emptyCoachProfile,
  parseLanguages, parseQualifications, profileIsEmpty, yearsCoachingLabel,
  type CoachProfileDetail, type CoachProfileDraft,
} from '@/lib/coach-profile';
import type { CoachProfile, CoachingLevel, WorkspaceUser } from '@/lib/types';
import { cn, initials } from '@/lib/utils';

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
      <p className="text-xs leading-relaxed text-[#59675c]">Students see this card on the booking page of every club you coach for.</p>
      <ProfileStrengthMeter profile={profile} className="mb-4 mt-3" />
      <CoachCardPreview name={user.name} sports={sports} profile={profile} />
    </div>
    {editing && <CoachProfileDialog user={user} onClose={() => setEditing(false)} refresh={refresh} />}
  </section>;
}

export function CoachCardPreview({ name, sports, profile }: { name: string; sports: readonly string[]; profile: CoachProfile }) {
  const years = yearsCoachingLabel(profile.coachingSince);
  const empty = profileIsEmpty(profile, sports);
  return <article aria-label={`Preview of ${name}'s coach card`} className="overflow-hidden rounded-2xl border border-[#e3e8df] bg-white shadow-[0_1px_2px_#1d3a2b0d,0_12px_28px_-16px_#1d3a2b33]">
    {/* A quiet, true-to-proportion court diagram: says "sport" without a photo. */}
    <div aria-hidden="true" className="relative h-[72px] overflow-hidden bg-[linear-gradient(135deg,#d6e5cb_0%,#e8eedd_52%,#f1e8d8_100%)]">
      <span className="absolute right-4 top-2 h-14 w-[122px] rounded-[2px] border border-white/80">
        <span className="absolute inset-y-0 left-1/2 w-px bg-white/90" />
        <span className="absolute inset-x-0 top-[12%] h-px bg-white/60" />
        <span className="absolute inset-x-0 bottom-[12%] h-px bg-white/60" />
        <span className="absolute inset-y-[12%] left-[23%] w-px bg-white/60" />
        <span className="absolute inset-y-[12%] right-[23%] w-px bg-white/60" />
        <span className="absolute left-[23%] right-[23%] top-1/2 h-px bg-white/60" />
      </span>
    </div>
    <div className="px-4 pb-4 sm:px-5 sm:pb-5">
      <span aria-hidden="true" className="relative -mt-8 grid h-14 w-14 place-items-center rounded-full bg-[#e8dccc] text-base font-semibold tracking-wide text-[#6f5738] shadow-sm ring-4 ring-white">{initials(name)}</span>
      {/* Not a heading: the profile page already names this person once. */}
      <p className="!mt-2.5 break-words text-base font-semibold tracking-tight text-[#1f3a2c]">{name}</p>
      {sports.length > 0 && <p className="!mt-0.5 text-xs font-medium text-[#59675c]">{sports.join(' · ')}</p>}
      {years && <p className="!mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-[#f4efe5] px-2.5 py-1 text-xs font-medium text-[#6a5232]"><CalendarClock size={12} aria-hidden="true" />{years}</p>}
      {profile.bio ? <p className="!mt-3.5 whitespace-pre-line break-words text-sm leading-relaxed text-[#3b4d41]">{profile.bio}</p>
        : empty ? <p className="!mt-3.5 rounded-xl border border-dashed border-[#d5ddd0] bg-[#fafbf8] px-3 py-2.5 text-xs leading-relaxed text-[#59675c]">Only your name appears until you add a few details.</p> : null}
      {(profile.coachingLevels.length > 0 || profile.coachingAgeGroups.length > 0) && <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#59675c]">Coaches</p>
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Levels and age groups coached">
          {profile.coachingLevels.map(level => <li key={level} className="rounded-full bg-[#e9f1e2] px-2.5 py-1 text-xs font-medium text-[#2c4a35]">{coachingLevelLabel(level)}</li>)}
          {profile.coachingAgeGroups.map(group => <li key={group} className="rounded-full bg-[#e8eef4] px-2.5 py-1 text-xs font-medium text-[#3d566b]">{coachingAgeGroupLabel(group)}</li>)}
        </ul>
      </div>}
      {profile.languages.length > 0 && <p className="!mt-3.5 flex items-start gap-2 text-xs leading-relaxed text-[#3b4d41]"><Languages size={14} className="mt-px shrink-0 text-[#6f8a68]" aria-hidden="true" /><span className="min-w-0 break-words">Speaks {profile.languages.join(', ')}</span></p>}
      {profile.qualifications.length > 0 && <div className="mt-4 rounded-xl border border-[#efe7d8] bg-[#fcf9f3] p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-[#6a5232]"><Award size={14} aria-hidden="true" />Self-reported qualifications</p>
        <ul className="mt-2 space-y-1">{profile.qualifications.map(item => <li key={item} className="flex gap-2 text-xs leading-relaxed text-[#3b4d41]"><span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#b39363]" /><span className="min-w-0 break-words">{item}</span></li>)}</ul>
        <p className="!mt-2 text-[11px] leading-relaxed text-[#6b5a40]">Provided by the coach. Courtly does not verify qualifications.</p>
      </div>}
    </div>
  </article>;
}

function ProfileStrengthMeter({ profile, className }: { profile: CoachProfile; className?: string }) {
  const checklist = coachProfileChecklist(profile);
  const done = checklist.filter(item => item.done).length;
  const complete = done === checklist.length;
  return <div className={cn('flex items-center gap-3', className)}>
    <span aria-hidden="true" className="flex flex-1 gap-1">
      {checklist.map(item => <span key={item.key} className={cn('h-1.5 flex-1 rounded-full transition-colors duration-300', item.done ? 'bg-[#4f8a4b]' : 'bg-[#e2e8dd]')} />)}
    </span>
    <span className={cn('shrink-0 text-xs font-medium', complete ? 'text-[#2f6b3a]' : 'text-[#4d5e51]')}>
      {complete ? 'Profile complete' : `${done} of ${checklist.length} details added`}
    </span>
  </div>;
}

/** Editor-only guidance; students see just the level name. */
const levelDetails: Record<CoachingLevel, string> = {
  BEGINNER: 'New to the game',
  INTERMEDIATE: 'Building consistency',
  ADVANCED: 'Tactics and match play',
  COMPETITIVE: 'Tournament players',
};

const detailPrompts: Record<CoachProfileDetail, string> = {
  bio: 'Write a short bio',
  levels: 'Choose the levels you coach',
  ageGroups: 'Choose the age groups you coach',
  languages: 'Add the languages you coach in',
  experience: 'Add the year you started coaching',
  qualifications: 'List a qualification',
};

const detailFields: Record<CoachProfileDetail, string> = {
  bio: 'coach-bio',
  levels: `coach-level-${coachingLevelOptions[0].value}`,
  ageGroups: `coach-age-${coachingAgeGroupOptions[0].value}`,
  languages: 'coach-languages',
  experience: 'coach-since',
  qualifications: 'coach-qualifications',
};

/** "Juniors (under 13)" reads better as a name with a quieter range beside it. */
function splitQualifier(label: string) {
  const match = /^(.+?)\s*\((.+)\)$/u.exec(label);
  return match ? { title: match[1], detail: match[2] } : { title: label, detail: '' };
}

// The global form-control rules in globals.css are unlayered, so restyling
// them from Tailwind's layered utilities needs the `!` modifier.
const fieldClass = '!rounded-xl !border-[#d9e1d5] !px-3.5 transition-[border-color,box-shadow] duration-150 placeholder:text-[#7b877d] hover:!border-[#bccab6] focus:!border-[#3f6f55] focus:!shadow-[0_0_0_4px_#3f6f5524]';
// The real checkbox covers its whole option, so a click anywhere on it is a
// click on the control itself and keyboard focus lands on the option.
const optionInputClass = 'absolute inset-0 z-10 !m-0 !h-full !w-full cursor-pointer opacity-0 disabled:cursor-not-allowed';
const optionClass = (checked: boolean, disabled: boolean) => cn(
  'relative !mb-0 cursor-pointer border bg-white transition-[border-color,background-color,box-shadow] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#327a5a] has-[:focus-visible]:ring-offset-2',
  checked ? 'border-[#2f5e48] bg-[#f3f8ef] shadow-[inset_0_0_0_1px_#2f5e48]' : 'border-[#e1e7dc] hover:border-[#b9c8b0] hover:bg-[#fbfcfa]',
  disabled && 'cursor-not-allowed opacity-60',
);
// Mobile dialogs give every button a 44px minimum; these stay compact and
// reach a comfortable touch target through the transparent ::after instead.
const removeButtonClass = 'relative grid !min-h-0 shrink-0 place-items-center rounded-full text-[#4f6a3f] transition-colors after:absolute after:-inset-2.5 hover:bg-[#d5e4c9] hover:text-[#1f3d2b] disabled:pointer-events-none';

function CoachProfileDialog({ user, onClose, refresh }: { user: WorkspaceUser; onClose: () => void; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState<CoachProfileDraft>(() => draftFromCoachProfile(user.coachProfile));
  const [saved] = useState(() => JSON.stringify(coachProfileFromDraft(draftFromCoachProfile(user.coachProfile))));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const preview = coachProfileFromDraft(draft);
  const dirty = JSON.stringify(preview) !== saved;
  const currentYear = new Date().getFullYear();
  const set = (change: Partial<CoachProfileDraft>) => { setDraft(current => ({ ...current, ...change })); setError(''); };
  const toggle = <T extends string>(list: T[], value: T, checked: boolean) => checked ? [...list.filter(item => item !== value), value] : list.filter(item => item !== value);
  const focusDetail = (detail: CoachProfileDetail) => document.getElementById(detailFields[detail])?.focus();

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

  const bioLength = draft.bio.length;
  const bioTone = bioLength >= coachProfileLimits.bio ? 'text-[#b3483a]' : bioLength >= coachProfileLimits.bio * 0.9 ? 'text-[#8a5a14]' : 'text-[#59675c]';
  const year = preview.coachingSince;
  const yearsCoaching = year !== null && Number.isInteger(year) && year >= coachProfileLimits.coachingSinceMin && year <= currentYear ? currentYear - year : null;

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="flex max-w-5xl flex-col overflow-hidden p-0" onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}>
      <div className="shrink-0 border-b border-[#e7ebe2] px-5 py-5 sm:px-7 sm:py-6">
        <div className="flex items-start gap-3.5">
          <span aria-hidden="true" className="hidden h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[linear-gradient(145deg,#2c5f49,#173f2f)] sm:grid text-[#e4edcb] shadow-[0_6px_16px_-6px_#173f2f80]"><Sparkles size={19} /></span>
          <div className="min-w-0">
            <DialogTitle className="!text-xl !leading-tight !tracking-[-0.02em] text-[#173f2f] sm:!text-[22px]">Edit coaching profile</DialogTitle>
            <DialogDescription className="!mt-1.5 max-w-xl text-sm leading-relaxed text-[#59675c]">This travels with your coach account to every club that adds you. Your email and phone are never shown.</DialogDescription>
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain md:flex md:overflow-hidden">
          <div className="min-w-0 md:flex-1 md:overflow-y-auto md:overscroll-contain">
            <fieldset disabled={saving} className="min-w-0 divide-y divide-[#edf0e9]">
              <EditorSection id="coach-section-story" icon={<MessageSquareQuote size={17} />} title="Your story" description="Students read this first, so make it sound like you.">
                <label htmlFor="coach-bio">Bio</label>
                <textarea id="coach-bio" rows={5} maxLength={coachProfileLimits.bio} value={draft.bio} onChange={event => set({ bio: event.target.value })} aria-describedby="coach-bio-hint coach-bio-count" placeholder="e.g. I'm a patient, technique-first coach who loves helping new players find their rhythm. Expect clear goals and plenty of rallying." className={cn(fieldClass, '!py-3 !leading-relaxed resize-y')} />
                <div className="mt-2 flex items-start justify-between gap-4">
                  <p id="coach-bio-hint" className="text-xs leading-relaxed text-[#59675c]">How you coach, who you love working with, and what students can expect.</p>
                  <p id="coach-bio-count" className={cn('shrink-0 text-xs font-medium tabular-nums', bioTone)}><span aria-hidden="true">{bioLength} / {coachProfileLimits.bio}</span><span className="sr-only">{bioLength} of {coachProfileLimits.bio} characters used</span></p>
                </div>
              </EditorSection>

              <EditorSection id="coach-section-fit" icon={<UsersRound size={17} />} title="Who you coach" description="Tick everyone you're happy to teach, so students can see at a glance whether you're a fit.">
                <fieldset className="min-w-0">
                  <legend className="text-sm font-semibold text-[#4d5e51]">Levels you coach</legend>
                  <div className="mt-2.5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                    {coachingLevelOptions.map((option, index) => {
                      const checked = draft.coachingLevels.includes(option.value);
                      const detailId = `coach-level-${option.value}-detail`;
                      return <label key={option.value} className={cn(optionClass(checked, saving), 'block rounded-xl p-3')}>
                        <input id={`coach-level-${option.value}`} type="checkbox" aria-label={option.label} aria-describedby={detailId} className={optionInputClass} checked={checked} onChange={event => set({ coachingLevels: toggle(draft.coachingLevels, option.value, event.target.checked) })} />
                        <span className="flex items-start justify-between gap-2">
                          <LevelBars step={index + 1} of={coachingLevelOptions.length} checked={checked} />
                          <TickMark checked={checked} />
                        </span>
                        <span className="mt-3 block text-sm font-semibold text-[#20382d]">{option.label}</span>
                        <span id={detailId} className="mt-0.5 block text-xs leading-snug text-[#59675c]">{levelDetails[option.value]}</span>
                      </label>;
                    })}
                  </div>
                </fieldset>
                <fieldset className="mt-6 min-w-0">
                  <legend className="text-sm font-semibold text-[#4d5e51]">Age groups you coach</legend>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {coachingAgeGroupOptions.map(option => {
                      const checked = draft.coachingAgeGroups.includes(option.value);
                      const { title, detail } = splitQualifier(option.label);
                      return <label key={option.value} className={cn(optionClass(checked, saving), '!inline-flex min-h-11 items-center gap-2 rounded-full py-2 pl-2.5 pr-4')}>
                        <input id={`coach-age-${option.value}`} type="checkbox" aria-label={option.label} className={optionInputClass} checked={checked} onChange={event => set({ coachingAgeGroups: toggle(draft.coachingAgeGroups, option.value, event.target.checked) })} />
                        <TickMark checked={checked} />
                        <span className="text-sm font-medium text-[#20382d]">{title}</span>
                        {detail && <span className="text-xs text-[#59675c]">{detail}</span>}
                      </label>;
                    })}
                  </div>
                </fieldset>
              </EditorSection>

              <EditorSection id="coach-section-experience" icon={<GraduationCap size={17} />} title="Experience" description="Languages, coaching years and the courses you've completed.">
                <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_11rem] md:grid-cols-1 lg:grid-cols-[minmax(0,1fr)_11rem]">
                  <LanguagesField initial={draft.languages} onChange={languages => set({ languages })} />
                  <div className="min-w-0">
                    <label htmlFor="coach-since">Coaching since</label>
                    <div className="relative">
                      <input id="coach-since" type="number" inputMode="numeric" min={coachProfileLimits.coachingSinceMin} max={currentYear} step={1} value={draft.coachingSince} onChange={event => set({ coachingSince: event.target.value })} aria-describedby="coach-since-hint" placeholder={String(currentYear - 5)} className={cn(fieldClass, '!pr-20 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none')} />
                      {/* The preview already states the years in words, so this stays visual. */}
                      {yearsCoaching !== null && <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-[#eef3e9] px-2 py-0.5 text-xs font-medium text-[#33533c]">{yearsCoaching === 0 ? 'New' : `${yearsCoaching} yr${yearsCoaching === 1 ? '' : 's'}`}</span>}
                    </div>
                    <p id="coach-since-hint" className="!mt-2 text-xs leading-relaxed text-[#59675c]">The year you started coaching. Leave blank to hide it.</p>
                  </div>
                </div>
                <QualificationsField initial={draft.qualifications} onChange={qualifications => set({ qualifications })} className="mt-6" />
              </EditorSection>
            </fieldset>
          </div>

          <aside aria-labelledby="coach-preview-heading" className="border-t border-[#e7ebe2] bg-[#f6f8f3] px-5 py-6 sm:px-7 md:w-[320px] md:shrink-0 md:overflow-y-auto md:overscroll-contain md:border-l md:border-t-0 md:px-6 lg:w-[360px]">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#3f8a45] ring-4 ring-[#3f8a45]/15" />
              <h3 id="coach-preview-heading" className="text-xs font-semibold uppercase tracking-[0.14em] text-[#405941]">Live preview</h3>
            </div>
            <p className="!mt-1 text-xs leading-relaxed text-[#59675c]">How your card appears on booking pages</p>
            <div className="mt-4"><CoachCardPreview name={user.name} sports={user.sports ?? []} profile={preview} /></div>
            <ProfileChecklist profile={preview} onAdd={focusDetail} className="mt-5" />
          </aside>
        </div>

        {error && <p role="alert" className="!mx-5 !my-3 shrink-0 rounded-xl border border-red-100 bg-red-50 px-3.5 py-3 text-xs leading-relaxed text-red-700 sm:!mx-7">{error}</p>}
        <div className="sticky bottom-0 flex shrink-0 items-center gap-2 border-t border-[#e7ebe2] bg-white px-5 py-3.5 sm:px-7">
          <p className="!mr-auto hidden items-center gap-2 text-xs text-[#59675c] sm:flex">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-full transition-colors', dirty ? 'bg-[#c0892c]' : 'bg-[#cfd8ca]')} />
            {dirty ? 'Unsaved changes' : 'No changes yet'}
          </p>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving} className="rounded-xl">Cancel</Button>
          <Button type="submit" disabled={saving} className="rounded-xl max-sm:flex-1 sm:min-w-[12rem]">{saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{saving ? 'Saving…' : 'Save coaching profile'}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

function EditorSection({ id, icon, title, description, children }: { id: string; icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="px-5 py-6 sm:px-7">
    <div className="mb-5 flex items-start gap-3">
      <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#eef3e9] text-[#3f6447]">{icon}</span>
      <div className="min-w-0 pt-0.5">
        <h3 id={id} className="text-[15px] tracking-tight text-[#20382d]">{title}</h3>
        <p className="!mt-0.5 text-xs leading-relaxed text-[#59675c]">{description}</p>
      </div>
    </div>
    {children}
  </section>;
}

function TickMark({ checked }: { checked: boolean }) {
  return <span aria-hidden="true" className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors duration-150', checked ? 'border-[#214e3e] bg-[#214e3e] text-white' : 'border-[#cbd5c5] bg-white text-transparent')}>
    <Check size={12} strokeWidth={3} />
  </span>;
}

/** Rising bars give the four levels an at-a-glance order. */
function LevelBars({ step, of, checked }: { step: number; of: number; checked: boolean }) {
  return <span aria-hidden="true" className="flex h-4 items-end gap-[3px]">
    {Array.from({ length: of }, (_, index) => <span key={index} style={{ height: `${((index + 1) / of) * 100}%` }} className={cn('w-1 rounded-full transition-colors duration-150', index < step ? (checked ? 'bg-[#214e3e]' : 'bg-[#93ad86]') : 'bg-[#e3e9df]')} />)}
  </span>;
}

function ProfileChecklist({ profile, onAdd, className }: { profile: CoachProfile; onAdd: (detail: CoachProfileDetail) => void; className?: string }) {
  const missing = coachProfileChecklist(profile).filter(item => !item.done);
  return <div className={cn('rounded-2xl border border-[#e3e8de] bg-white p-4', className)}>
    <p className="text-sm font-semibold text-[#20382d]">{missing.length ? 'Make your card stand out' : 'Ready for students'}</p>
    <ProfileStrengthMeter profile={profile} className="mt-2.5" />
    {missing.length > 0 && <ul aria-label="Details still to add" className="mt-3 grid gap-0.5 border-t border-[#eef1ea] pt-2">
      {missing.map(item => <li key={item.key}>
        <button type="button" onClick={() => onAdd(item.key)} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-1.5 text-left !text-sm font-medium text-[#214e3e] transition-colors hover:bg-[#f0f5ec]">
          <Plus size={14} aria-hidden="true" className="shrink-0" />{detailPrompts[item.key]}
        </button>
      </li>)}
    </ul>}
  </div>;
}

/**
 * A list entered one item at a time. The draft receives the serialised text,
 * so its parser — and the live preview — include an entry still being typed.
 */
function useEntryList(initial: () => string[], separator: RegExp, joiner: string, onChange: (text: string) => void) {
  const [entries, setEntries] = useState(initial);
  const [pending, setPending] = useState('');
  const [status, setStatus] = useState('');
  function update(next: string[], text: string, message: string) {
    setEntries(next);
    setPending(text);
    setStatus(message);
    onChange([...next, text].join(joiner));
  }
  return {
    entries, pending, status,
    type(text: string) {
      const next = absorbEntries(entries, text, separator);
      const added = next.entries.slice(entries.length);
      update(next.entries, next.pending, added.length ? `Added ${added.join(', ')}` : '');
    },
    commit() {
      const value = pending.trim();
      if (!value) return;
      const next = distinctEntries([...entries, value]);
      update(next, '', next.length > entries.length ? `Added ${value}` : `${value} is already listed`);
    },
    remove(entry: string) {
      update(entries.filter(item => item !== entry), pending, `Removed ${entry}`);
    },
  };
}

function EntryCount({ count, limit, noun }: { count: number; limit: number; noun: string }) {
  return <span className={cn('text-xs font-medium tabular-nums', count > limit ? 'text-[#b3483a]' : 'text-[#59675c]')}>
    <span aria-hidden="true">{count} / {limit}</span><span className="sr-only">{count} of {limit} {noun} added</span>
  </span>;
}

function LanguagesField({ initial, onChange }: { initial: string; onChange: (text: string) => void }) {
  const list = useEntryList(() => parseLanguages(initial), /,/u, ', ', onChange);
  const inputRef = useRef<HTMLInputElement>(null);
  return <div className="min-w-0">
    <div className="mb-[7px] flex items-baseline justify-between gap-3">
      <label htmlFor="coach-languages" className="!mb-0">Languages</label>
      <EntryCount count={list.entries.length} limit={coachProfileLimits.languages} noun="languages" />
    </div>
    {/* Clicking the padding around the chips should still reach the text box. */}
    <div onClick={event => { if (event.target === event.currentTarget) inputRef.current?.focus(); }} className="flex min-h-11 cursor-text flex-wrap items-center gap-1.5 rounded-xl border border-[#d9e1d5] bg-white p-1.5 transition-[border-color,box-shadow] duration-150 focus-within:border-[#3f6f55] focus-within:shadow-[0_0_0_4px_#3f6f5524] hover:border-[#bccab6]">
      {list.entries.length > 0 && <ul aria-label="Languages added" className="flex flex-wrap gap-1.5">
        {list.entries.map(entry => <li key={entry} className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-[#e9f1e2] py-1 pl-3 pr-1 text-sm font-medium text-[#2c4a35]">
          <span className="min-w-0 break-words">{entry}</span>
          <button type="button" aria-label={`Remove ${entry}`} onClick={() => { list.remove(entry); inputRef.current?.focus(); }} className={cn(removeButtonClass, 'h-6 w-6')}><X size={13} aria-hidden="true" /></button>
        </li>)}
      </ul>}
      <input
        ref={inputRef} id="coach-languages" value={list.pending} autoComplete="off" enterKeyHint="enter"
        onChange={event => list.type(event.target.value)}
        onBlur={list.commit}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); list.commit(); }
          else if (event.key === 'Backspace' && !list.pending && list.entries.length) { event.preventDefault(); list.remove(list.entries[list.entries.length - 1]); }
        }}
        aria-describedby="coach-languages-hint"
        placeholder={list.entries.length ? 'Add another' : 'English, Mandarin'}
        className="!min-h-8 min-w-[8rem] flex-1 !border-0 !bg-transparent !px-2 !py-1 !shadow-none placeholder:text-[#7b877d]"
      />
    </div>
    <p id="coach-languages-hint" className="!mt-2 text-xs leading-relaxed text-[#59675c]">Press Enter or type a comma after each one. Up to {coachProfileLimits.languages}.</p>
    <p role="status" className="sr-only">{list.status}</p>
  </div>;
}

function QualificationsField({ initial, onChange, className }: { initial: string; onChange: (text: string) => void; className?: string }) {
  // A textarea rather than an input so a pasted multi-line list keeps its
  // line breaks and splits into one qualification per line.
  const list = useEntryList(() => parseQualifications(initial), /\r?\n/u, '\n', onChange);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  return <div className={cn('min-w-0', className)}>
    <div className="mb-[7px] flex items-baseline justify-between gap-3">
      <label htmlFor="coach-qualifications" className="!mb-0">Qualifications <span className="font-normal text-[#59675c]">(self-reported)</span></label>
      <EntryCount count={list.entries.length} limit={coachProfileLimits.qualifications} noun="qualifications" />
    </div>
    {list.entries.length > 0 && <ul aria-label="Qualifications added" className="mb-2 grid gap-1.5">
      {list.entries.map(entry => <li key={entry} className="flex min-h-11 items-center gap-3 rounded-xl border border-[#ece5d7] bg-[#fdfbf7] py-1.5 pl-3 pr-1.5">
        <Award size={15} aria-hidden="true" className="shrink-0 text-[#a07c45]" />
        <span className="min-w-0 flex-1 break-words text-sm text-[#2b4134]">{entry}</span>
        <button type="button" aria-label={`Remove ${entry}`} onClick={() => { list.remove(entry); fieldRef.current?.focus(); }} className={cn(removeButtonClass, 'h-8 w-8 text-[#6b5a40] hover:bg-[#f1e9da] hover:text-[#4a3c26]')}><X size={14} aria-hidden="true" /></button>
      </li>)}
    </ul>}
    <div className="flex items-start gap-2">
      <textarea
        ref={fieldRef} id="coach-qualifications" rows={1} value={list.pending} enterKeyHint="enter"
        onChange={event => list.type(event.target.value)}
        onBlur={list.commit}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
          event.preventDefault();
          list.commit();
        }}
        aria-describedby="coach-qualifications-hint"
        placeholder={list.entries.length ? 'Add another' : 'e.g. ITF Level 1 Coach'}
        className={cn(fieldClass, 'resize-none [field-sizing:content]')}
      />
      <Button type="button" variant="outline" onClick={() => { list.commit(); fieldRef.current?.focus(); }} className="h-[42px] shrink-0 rounded-xl"><Plus size={15} aria-hidden="true" />Add</Button>
    </div>
    <p id="coach-qualifications-hint" className="!mt-2 text-xs leading-relaxed text-[#59675c]">Press Enter after each one, up to {coachProfileLimits.qualifications}. Students see these labelled as self-reported; Courtly does not verify them.</p>
    <p role="status" className="sr-only">{list.status}</p>
  </div>;
}
