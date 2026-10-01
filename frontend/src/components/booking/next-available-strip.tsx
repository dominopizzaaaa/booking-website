"use client";

import { useId } from "react";
import { LoaderCircle, Zap } from "lucide-react";
import { sameInstant } from "@/lib/club-profile";
import type { Slot } from "@/lib/types";
import { cn, shortDate, time } from "@/lib/utils";

export type NextAvailableState = { loading: boolean; slots: Slot[]; error: string };

/**
 * Re-booking starts from a known Class, coach and venue, so the fastest path
 * is the next few open times: one tap selects the day and the slot together.
 */
export function NextAvailableStrip({
  state,
  coachName,
  timezone,
  selectedStartAt,
  onChoose,
}: {
  state: NextAvailableState;
  coachName?: string;
  timezone: string;
  selectedStartAt: string;
  onChoose: (slot: Slot) => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="!mb-6 rounded-xl border border-[#dbe5d3] bg-[#f4f8ef] p-4"
    >
      <h3 id={headingId} className="flex items-center gap-2 !text-sm !font-semibold text-[#253c31]">
        <Zap size={15} aria-hidden="true" className="shrink-0 text-[#4f6a3f]" />
        {coachName ? `Next available with ${coachName}` : "Next available"}
      </h3>
      {state.loading ? (
        <p role="status" className="!mt-2 flex items-center gap-2 text-xs text-[#59675c]">
          <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
          Finding the next open times…
        </p>
      ) : state.error ? (
        <p className="!mt-2 text-xs leading-relaxed text-[#59675c]">
          The next open times couldn’t be loaded. Choose a day below instead.
        </p>
      ) : state.slots.length === 0 ? (
        <p className="!mt-2 text-xs leading-relaxed text-[#59675c]">
          No open times in the next four weeks for this coach and place. Try a later day below, or go back to change the coach or place.
        </p>
      ) : (
        <>
          <p className="!mt-1 text-xs leading-relaxed text-[#59675c]">
            Tap a time to choose it. You can still pick any other day below.
          </p>
          <ul className="!mt-3 flex flex-wrap gap-2">
            {state.slots.map((slot) => {
              const selected = sameInstant(slot.startAt, selectedStartAt);
              return (
                <li key={slot.startAt} className="min-w-[96px] flex-1 sm:flex-none">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChoose(slot)}
                    className={cn(
                      "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-xl border px-3 py-2 text-center transition",
                      selected
                        ? "border-[#174c3c] bg-[#174c3c] text-white"
                        : "border-[#d6e0d1] bg-white text-[#253c31] hover:border-[#9eaf94]",
                    )}
                  >
                    <span className={cn("text-[11px] font-medium", selected ? "text-[#e3eedc]" : "text-[#59675c]")}>
                      {shortDate(slot.startAt, timezone)}
                    </span>
                    <span className="whitespace-nowrap text-sm font-semibold">{time(slot.startAt, timezone)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
