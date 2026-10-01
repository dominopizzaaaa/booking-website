/*
 * The student app's visual vocabulary, shared by the shell and its feature
 * components so a new panel cannot drift from the existing calm palette.
 */

export const primaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#103d2f] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none';
export const secondaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#dce3da] bg-white px-4 py-2.5 text-sm font-medium text-[#344d40] transition hover:border-[#bdcbbb] hover:bg-[#f3f6f1] disabled:cursor-not-allowed disabled:opacity-45';
export const compactButton =
  'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-[#dce3da] bg-white px-3 text-xs font-semibold text-[#344d40] transition hover:border-[#bdcbbb] hover:bg-[#f3f6f1] disabled:cursor-not-allowed disabled:opacity-45';
export const panel =
  'min-w-0 rounded-2xl border border-[#e5e9e4] bg-white shadow-[0_8px_30px_rgba(29,57,43,0.035)] [&_*]:min-w-0 [&_p]:break-words';
export const field =
  '!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base sm:!text-sm';
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2';
export const eyebrow = 'text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]';

export function chipClass(active: boolean) {
  return [
    'min-h-10 rounded-full border px-4 py-2 text-xs font-semibold transition',
    focusRing,
    active ? 'border-[#174c3c] bg-[#174c3c] text-white' : 'border-[#d8e1d5] bg-white text-[#496353] hover:bg-[#f3f6f1]',
  ].join(' ');
}

export function statusClass(state: string) {
  if (state === 'Cancelled') return 'bg-[#f8e8e3] text-[#8b4d3c]';
  if (state === 'Awaiting confirmation' || state === 'Awaiting coach') return 'bg-[#f8eed3] text-[#70582e]';
  if (state === 'Completed') return 'bg-[#e8edf2] text-[#4f687d]';
  if (state === 'In progress') return 'bg-[#dfeee7] text-[#39705a]';
  return 'bg-[#e9f0df] text-[#4f6847]';
}
