"use client";

import { useId } from "react";
import { Check } from "lucide-react";
import { coachProfileDetails } from "@/lib/club-profile";
import type { PublicInstructor } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ClampedText } from "./clamped-text";
import { Disclosure } from "@/components/ui/progressive-disclosure";

/**
 * One coach in the "Find your coach" step. The selection button stays short
 * (name, specialty, experience) so its accessible name is readable; the public
 * coaching profile sits beside it. Profiles never carry contact details, and
 * qualifications are labelled as self-reported because nobody verifies them.
 */
export function CoachChoiceCard({
  coach,
  selected,
  onSelect,
  currentYear,
}: {
  coach: PublicInstructor;
  selected: boolean;
  onSelect: () => void;
  currentYear: number;
}) {
  const nameId = useId();
  const details = coachProfileDetails(coach.profile, currentYear);
  const rows: Array<{ label: string; value: string }> = [];
  if (details?.sports.length) rows.push({ label: details.sports.length === 1 ? "Sport" : "Sports", value: details.sports.join(", ") });
  if (details?.levels.length) rows.push({ label: "Levels", value: details.levels.join(", ") });
  if (details?.ageGroups.length) rows.push({ label: "Ages", value: details.ageGroups.join(", ") });
  if (details?.languages.length) rows.push({ label: details.languages.length === 1 ? "Language" : "Languages", value: details.languages.join(", ") });
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-white transition",
        selected
          ? "border-[#65885c] bg-[#f6f9f1] ring-1 ring-[#65885c]"
          : "border-[#e5e9e0] hover:border-[#b2c2a7]",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-h-[72px] w-full items-center gap-3 rounded-xl p-3.5 text-left sm:p-4"
      >
        <span
          aria-hidden="true"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#e8eedf] text-xs font-semibold text-[#4f6a3f]"
        >
          {coach.initials || coach.name.slice(0, 2)}
        </span>
        <span className="min-w-0 flex-1">
          <span id={nameId} className="block break-words text-sm font-semibold">
            {coach.name}
          </span>
          <span className="!mt-1 block text-[11px] leading-relaxed text-[#5f6d5c]">
            {coach.specialty || "Here to help you find your game"}
          </span>
          {details?.experience && (
            <span className="!mt-0.5 block text-[11px] font-medium text-[#3f5a46]">{details.experience}</span>
          )}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded-full border",
            selected ? "border-[#174c3c] bg-[#174c3c] text-white" : "border-[#c9d3c3]",
          )}
        >
          {selected && <Check size={13} />}
        </span>
      </button>
      {details && (details.bio || rows.length > 0 || details.qualifications.length > 0) && (
        <div className="border-t border-[#edf0e8] px-3.5 py-3 sm:px-4">
          <Disclosure
            title="Coach background"
            summary="Bio, coaching preferences and self-reported qualifications"
            className="border-0 bg-transparent"
            contentClassName="flex flex-col gap-3 !px-0 !pb-0"
          >
            {details.bio && (
              <ClampedText text={details.bio} describedBy={nameId} className="text-xs leading-relaxed text-[#3d5043]" />
            )}
            {rows.length > 0 && (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-relaxed">
                {rows.map((row) => (
                  <div key={row.label} className="contents">
                    <dt className="font-semibold text-[#5d6b5f]">{row.label}</dt>
                    <dd className="break-words text-[#2f4a3a]">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {details.qualifications.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[#5d6b5f]">Self-reported qualifications</p>
                <ul className="!mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-[#2f4a3a]">
                  {details.qualifications.map((qualification) => (
                    <li key={qualification} className="break-words">{qualification}</li>
                  ))}
                </ul>
              </div>
            )}
          </Disclosure>
        </div>
      )}
    </li>
  );
}
