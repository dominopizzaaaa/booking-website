"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CalendarCheck, CheckCheck, Clock3, Info, LoaderCircle } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { waitlistPositionText } from "@/lib/club-profile";
import type { AccountWaitlistEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { button, secondary } from "./styles";

/**
 * Confirms joining a full group Class's waitlist. Joining books and charges
 * nothing; it explains the offer rules before the player commits, then points
 * to My bookings, where offers are confirmed.
 */
export function WaitlistDialog({
  open,
  onOpenChange,
  summary,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Group clinic with Casey Coach · Thu, 8 Oct, 12:00 PM at Centre Court". */
  summary: string;
  onConfirm: () => Promise<AccountWaitlistEntry>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState<AccountWaitlistEntry | null>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) return;
    setBusy(false);
    setError("");
    setEntry(null);
  }, [open]);
  useEffect(() => {
    if (entry) successHeading.current?.focus();
  }, [entry]);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setEntry(await onConfirm());
    } catch (err) {
      setError(err instanceof Error ? err.message : "You couldn’t join the waitlist. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="!max-w-md">
        {entry ? (
          <div className="flex flex-col gap-4">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-[#eaf2df] text-[#3f6a35]">
              <CheckCheck size={24} aria-hidden="true" />
            </span>
            <DialogTitle ref={successHeading} tabIndex={-1} className="!text-xl !font-semibold outline-none">
              You’re on the waitlist
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-[#3d5043]">
              {waitlistPositionText(entry.aheadCount)} If a place opens, we’ll notify you in Courtly and hold it for you for a limited time. Confirm it from My bookings.
            </DialogDescription>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href="/manage" className={cn(button, "sm:flex-1")}>
                Open My bookings
              </Link>
              <DialogClose className={cn(secondary, "sm:flex-1")}>Done</DialogClose>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <DialogTitle className="!text-xl !font-semibold">Join the waitlist?</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-[#3d5043]">{summary}</DialogDescription>
            <ul className="space-y-3 rounded-xl bg-[#f4f7f0] p-4 text-xs leading-relaxed text-[#3d5043]">
              <li className="flex gap-2.5">
                <Bell size={15} aria-hidden="true" className="!mt-0.5 shrink-0 text-[#4f6a3f]" />
                <span>If a place opens up, it’s offered to the waitlist in order and we notify you in Courtly.</span>
              </li>
              <li className="flex gap-2.5">
                <Clock3 size={15} aria-hidden="true" className="!mt-0.5 shrink-0 text-[#4f6a3f]" />
                <span>An offered place is held for you for a limited time, then passes to the next person.</span>
              </li>
              <li className="flex gap-2.5">
                <CalendarCheck size={15} aria-hidden="true" className="!mt-0.5 shrink-0 text-[#4f6a3f]" />
                <span>Confirm the offer in My bookings to take the place. Joining the waitlist doesn’t book or charge anything.</span>
              </li>
            </ul>
            {error && (
              <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-[#eedbd5] bg-[#fff7f3] p-3.5 text-sm leading-relaxed text-[#8a4937]">
                <Info size={16} aria-hidden="true" className="!mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose className={secondary} disabled={busy}>Not now</DialogClose>
              <button type="button" className={button} disabled={busy} onClick={() => void confirm()}>
                {busy && <LoaderCircle size={16} aria-hidden="true" className="animate-spin" />}
                {busy ? "Joining…" : "Join waitlist"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
