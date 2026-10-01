'use client';

import type { Attendance } from '@/lib/types';
import { attendanceChoices, attendanceLabels } from '@/lib/run-class';
import { cn } from '@/lib/utils';

const selectedTone: Record<Attendance, string> = {
  UNMARKED: '',
  PRESENT: 'border-[#214e3e] bg-[#214e3e] text-white',
  LATE: 'border-[#7a5a1c] bg-[#7a5a1c] text-white',
  ABSENT: 'border-[#9b3d2f] bg-[#9b3d2f] text-white',
  EXCUSED: 'border-[#44617a] bg-[#44617a] text-white',
};

/**
 * Present / Late / Absent / Excused as a row of toggle buttons.
 *
 * Each choice saves immediately, so these are pressed-state buttons rather
 * than radios: moving focus with the keyboard must never send a request.
 */
export function AttendanceControl({ value, learnerName, disabled, locked, busyValue, onChange, size = 'md' }: {
  value: Attendance;
  learnerName: string;
  disabled?: boolean;
  /**
   * Temporarily refuse input while another save is in flight. Unlike
   * `disabled`, this keeps keyboard focus on the button that was pressed.
   */
  locked?: boolean;
  /** The choice currently being saved, shown as pending. */
  busyValue?: Attendance | null;
  onChange: (value: Attendance) => void;
  size?: 'sm' | 'md';
}) {
  return <div role="group" aria-label={`Attendance for ${learnerName}`} className="grid grid-cols-4 gap-1 rounded-xl bg-[#eef1ea] p-1">
    {attendanceChoices.map(choice => {
      const pressed = value === choice;
      return <button
        key={choice}
        type="button"
        aria-pressed={pressed}
        aria-disabled={locked || undefined}
        disabled={disabled}
        onClick={() => { if (!pressed && !locked) onChange(choice); }}
        className={cn(
          'min-w-0 rounded-lg border border-transparent px-1.5 font-semibold text-[#3b4d41] transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-progress',
          size === 'sm' ? 'min-h-9 text-xs' : 'min-h-11 text-sm',
          pressed && selectedTone[choice],
          busyValue === choice && 'animate-pulse',
        )}
      >{attendanceLabels[choice]}</button>;
    })}
  </div>;
}

/** Read-only attendance, for people who can see the roll but not change it. */
export function AttendanceBadge({ value }: { value: Attendance }) {
  const tone = value === 'PRESENT' ? '' : value === 'LATE' ? 'pending' : value === 'ABSENT' ? 'cancelled' : value === 'EXCUSED' ? 'completed' : 'bg-stone-100! text-stone-600!';
  return <span className={`badge ${tone}`}>{attendanceLabels[value]}</span>;
}
