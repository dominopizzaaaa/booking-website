"use client";

import { useEffect, useId, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  CircleCheck,
  ExternalLink,
  Globe,
  Mail,
  MessageCircle,
  Phone,
  Wallet,
} from "lucide-react";
import {
  afterBookingSteps,
  clubContactLinks,
  plainCancellationNotice,
  type AfterBookingStep,
  type VenueConfirmation,
} from "@/lib/club-profile";
import type { ClubPublicSummary, PublicBookingBusiness } from "@/lib/types";
import { cn, money } from "@/lib/utils";
import { ClampedText } from "./clamped-text";
import { panel } from "./styles";

const stepIcons: Record<AfterBookingStep["id"], typeof CircleCheck> = {
  confirmation: CircleCheck,
  payment: Wallet,
  changes: CalendarClock,
  chat: MessageCircle,
};
const contactIcons = { email: Mail, phone: Phone, website: Globe } as const;
const contactPrefix = { email: "Email", phone: "Call", website: "Website" } as const;

function clubInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");
}

/**
 * The "trust layer" above the booking wizard: who the club is, what it costs
 * from, who coaches, where, the cancellation notice, how to reach it, and what
 * happens once a booking is made. Every field is optional on the wire, so each
 * part disappears rather than rendering an empty promise.
 */
export function ClubDecisionHeader({
  business,
  summary,
  venueConfirmation,
  open,
  onOpenChange,
}: {
  business: PublicBookingBusiness;
  summary: ClubPublicSummary;
  venueConfirmation: VenueConfirmation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const headingId = useId();
  const detailsId = useId();
  const contacts = clubContactLinks(business);
  const description = business.description?.trim() ?? "";
  const facts: Array<{ label: string; value: string }> = [];
  if (summary.sports.length) facts.push({ label: summary.sports.length === 1 ? "Sport" : "Sports", value: summary.sports.join(", ") });
  if (summary.priceFrom !== null) facts.push({ label: "Classes from", value: `${money(summary.priceFrom, business.currency)} / class` });
  if (summary.coachCount > 0) facts.push({ label: "Coaches", value: `${summary.coachCount} coach${summary.coachCount === 1 ? "" : "es"}` });
  if (summary.areas.length) facts.push({ label: summary.areas.length === 1 ? "Area" : "Areas", value: summary.areas.join(", ") });
  else if (summary.locationCount > 0) facts.push({ label: "Venues", value: `${summary.locationCount} venue${summary.locationCount === 1 ? "" : "s"}` });

  return (
    <section aria-labelledby={headingId} className="!mb-5 sm:!mb-8">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[#dce4d4] bg-[#eaf0df] text-sm font-semibold text-[#4f6a3f]"
        >
          {clubInitials(business.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="truncate !text-sm !font-semibold !leading-snug">
            {business.name}
          </h2>
          <p className="!mt-0.5 truncate text-[11px] text-[#5f6d5c]">
            {business.tagline || "A little more time doing what you love."}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => onOpenChange(!open)}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[#dce3da] bg-white px-3 text-xs font-semibold text-[#2f5a43] transition hover:bg-[#f3f6f1]"
        >
          Club details
          <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
        </button>
      </div>
      <div id={detailsId} hidden={!open} className={cn(panel, "!mt-4 flex flex-col gap-5 p-4 sm:p-6", !open && "hidden")}>
        {description && <ClampedText text={description} className="text-sm leading-relaxed text-[#3d5043]" />}
        {facts.length > 0 && (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {facts.map((fact) => (
              <div key={fact.label} className="rounded-xl bg-[#f4f7f0] px-3 py-2.5">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-[#5d6b5f]">{fact.label}</dt>
                <dd className="!mt-1 break-words text-sm font-semibold text-[#253c31]">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="flex items-start gap-2.5 text-sm leading-relaxed text-[#3d5043]">
          <CalendarClock size={17} aria-hidden="true" className="!mt-0.5 shrink-0 text-[#4f6a3f]" />
          <span>
            <span className="font-semibold">Cancellation: </span>
            <span>{plainCancellationNotice(business.cancellationHours)}</span>
          </span>
        </p>
        {contacts.length > 0 && (
          <div>
            <h3 className="!text-xs !font-semibold uppercase tracking-wider text-[#5d6b5f]">Contact the club</h3>
            <ul className="!mt-2 flex flex-wrap gap-2">
              {contacts.map((contact) => {
                const Icon = contactIcons[contact.kind];
                return (
                  <li key={contact.kind} className="min-w-0 max-w-full">
                    <a
                      href={contact.href}
                      {...(contact.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-[#d6e0d1] bg-white px-3.5 text-xs font-semibold text-[#2f5a43] transition hover:border-[#a9bb9f] hover:bg-[#f3f6f1]"
                    >
                      <Icon size={14} aria-hidden="true" className="shrink-0" />
                      <span className="sr-only">{contactPrefix[contact.kind]}: </span>
                      <span className="min-w-0 break-all">{contact.label}</span>
                      {contact.external && (
                        <>
                          <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
                          <span className="sr-only"> (opens in a new tab)</span>
                        </>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <AfterBookingExplainer
          steps={afterBookingSteps({
            clubName: business.name,
            cancellationHours: business.cancellationHours,
            venueConfirmation,
          })}
        />
      </div>
    </section>
  );
}

function AfterBookingExplainer({ steps }: { steps: AfterBookingStep[] }) {
  const contentId = useId();
  const [open, setOpen] = useState(false);
  // Wide screens have room to show the answers up front; phones keep the
  // header short and let the player open them.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(min-width: 640px)").matches) setOpen(true);
  }, []);
  return (
    <div className="border-t border-[#edf0e8] pt-4">
      <h3 className="!text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-left text-sm font-semibold text-[#253c31]"
        >
          What happens after booking
          <ChevronDown size={16} aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-180")} />
        </button>
      </h3>
      <ol id={contentId} hidden={!open} className={cn("!mt-2 gap-3 sm:grid-cols-2", open ? "grid" : "hidden")}>
        {steps.map((step) => {
          const Icon = stepIcons[step.id];
          return (
            <li key={step.id} className="flex items-start gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#eaf0df] text-[#4f6a3f]">
                <Icon size={15} aria-hidden="true" />
              </span>
              <span className="min-w-0 text-xs leading-relaxed text-[#3d5043]">
                <span className="block font-semibold text-[#253c31]">{step.title}</span>
                <span className="block">{step.text}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
