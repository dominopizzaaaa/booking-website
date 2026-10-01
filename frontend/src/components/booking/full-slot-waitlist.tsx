"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { CheckCheck, LogIn, UsersRound } from "lucide-react";
import { waitlistPositionText } from "@/lib/club-profile";
import type { AccountWaitlistEntry, Slot } from "@/lib/types";
import { time } from "@/lib/utils";
import { SeeMoreButton } from "@/components/ui/progressive-disclosure";

/**
 * Full group times, listed after the bookable ones. They are deliberately not
 * radios in the start-time group: a full Class cannot be booked, only queued.
 */
export function FullSlotWaitlist({
  slots,
  timezone,
  mode,
  signInHrefFor,
  joinedEntryFor,
  onJoin,
}: {
  slots: Slot[];
  timezone: string;
  /** "join" for a signed-in self-managed student, "sign-in" for a visitor. */
  mode: "join" | "sign-in";
  signInHrefFor: (slot: Slot) => string;
  joinedEntryFor: (slot: Slot) => AccountWaitlistEntry | undefined;
  onJoin: (slot: Slot) => void;
}) {
  const headingId = useId();
  const listId = useId();
  const [showAll, setShowAll] = useState(false);
  if (slots.length === 0) return null;
  const visibleSlots = showAll ? slots : slots.slice(0, 4);
  return (
    <section aria-labelledby={headingId} className="!mt-6 border-t border-[#eef0eb] pt-5">
      <h3 id={headingId} className="flex items-center gap-2 !text-sm">
        <UsersRound size={15} aria-hidden="true" className="shrink-0 text-[#4f6a3f]" />
        Full group times
      </h3>
      <p className="!mt-1.5 text-xs leading-relaxed text-[#59675c]">
        {mode === "join"
          ? "These Classes are full. Join a waitlist and, if a place opens, Courtly offers it to you to confirm."
          : "These Classes are full. Sign in to join a waitlist and be offered a place if one opens."}
      </p>
      <ul id={listId} className="!mt-3 space-y-2">
        {visibleSlots.map((slot) => {
          const label = time(slot.startAt, timezone);
          const entry = joinedEntryFor(slot);
          return (
            <li
              key={slot.startAt}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-[#e5e9e0] bg-[#fbfcf9] px-3.5 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="whitespace-nowrap text-sm font-semibold text-[#253c31]">{label}</span>
                <span className="rounded-full bg-[#fbefd2] px-2 py-0.5 text-[11px] font-semibold text-[#6b5320]">Full</span>
              </span>
              {entry ? (
                <span className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-[#2f5a43]">
                  <CheckCheck size={15} aria-hidden="true" />
                  On the waitlist · {waitlistPositionText(entry.aheadCount)}
                </span>
              ) : mode === "join" ? (
                <button
                  type="button"
                  onClick={() => onJoin(slot)}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#c9d6c2] bg-white px-3.5 text-xs font-semibold text-[#174c3c] transition hover:bg-[#f3f6f1]"
                >
                  Join waitlist<span className="sr-only"> for {label}</span>
                </button>
              ) : (
                <Link
                  href={signInHrefFor(slot)}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#c9d6c2] bg-white px-3.5 text-xs font-semibold text-[#174c3c] transition hover:bg-[#f3f6f1]"
                >
                  <LogIn size={14} aria-hidden="true" />
                  Sign in to join waitlist<span className="sr-only"> for {label}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {slots.length > 4 && (
        <SeeMoreButton
          expanded={showAll}
          onToggle={() => setShowAll((value) => !value)}
          controls={listId}
          hiddenCount={slots.length - visibleSlots.length}
          noun="full times"
          className="!mt-2"
        />
      )}
    </section>
  );
}
