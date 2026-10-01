import { UsersRound } from 'lucide-react';
import { SELF_PLAYER } from '@/lib/player-view';
import type { FamilyBookingChild } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * "Viewing as" for a guardian. A native select keeps it keyboard-complete
 * and lets each phone use its own picker; the visible label folds away on a
 * narrow header but always remains the control's accessible name.
 */
export function PlayerSwitcher({
  players,
  value,
  onChange,
}: {
  players: FamilyBookingChild[];
  value: string;
  onChange: (value: string) => void;
}) {
  const viewingChild = value !== SELF_PLAYER;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <label htmlFor="student-player-switcher" className="sr-only !mb-0 whitespace-nowrap !text-[11px] !font-medium !text-[#59675c] md:not-sr-only">
        Viewing as
      </label>
      <span className="relative inline-flex min-w-0 items-center">
        <UsersRound size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-[#4f6847]" />
        <select
          id="student-player-switcher"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            // The unlayered form reset outranks layered utilities, hence the `!`.
            '!h-11 !min-h-11 !w-auto min-w-0 !max-w-[7.5rem] truncate !rounded-full !py-0 !pl-7 !pr-7 !text-base !font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2 sm:!max-w-[12rem] sm:!text-xs',
            viewingChild ? '!border-[#174c3c] !bg-[#e8efe0] !text-[#174c3c]' : '!border-[#dfe6da] !bg-white !text-[#344d40]',
          )}
        >
          <option value={SELF_PLAYER}>Me</option>
          {players.map(player => <option key={player.id} value={player.id}>{player.displayName}</option>)}
        </select>
      </span>
    </div>
  );
}
