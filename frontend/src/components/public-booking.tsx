"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  Home,
  Info,
  LoaderCircle,
  MapPin,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import {
  ApiError,
  api,
  createPublicBooking,
  loadPublicBusiness,
  loadSlots,
} from "@/lib/api";
import type {
  Booking,
  BookingResult,
  PublicBookingBusiness,
  PublicLocation,
  Participant,
  PublicBusiness,
  Service,
  Slot,
} from "@/lib/types";
import { cn, dateKey, money, shortDate, time } from "@/lib/utils";

const button =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#103d2f] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none";
const secondary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#dce3da] bg-white px-4 py-2.5 text-sm font-medium text-[#344d40] transition hover:border-[#bdcbbb] hover:bg-[#f3f6f1] disabled:cursor-not-allowed disabled:opacity-40";
const field =
  "!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base sm:!text-sm";
const panel =
  "min-w-0 rounded-2xl border border-[#e5e9e4] bg-white [&_*]:min-w-0 [&_p]:break-words [&_a]:min-h-11";
const venueMessage = "Venue to be arranged — booking does not reserve a court";
const steps = [
  "Lesson",
  "Coach & place",
  "Date & time",
  "Your details",
  "Review",
];

function plusDays(key: string, days: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayLabel(key: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-SG", {
    ...options,
    timeZone: "UTC",
  }).format(new Date(`${key}T12:00:00Z`));
}
function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
function conflictList(error: unknown): { date: string; reason: string }[] {
  if (
    !(error instanceof ApiError) ||
    !error.details ||
    typeof error.details !== "object"
  )
    return [];
  const conflicts = (error.details as { conflicts?: unknown }).conflicts;
  return Array.isArray(conflicts)
    ? conflicts.filter(
        (item): item is { date: string; reason: string } =>
          !!item &&
          typeof item === "object" &&
          typeof item.date === "string" &&
          typeof item.reason === "string",
      )
    : [];
}
function isPendingVenue(location?: PublicLocation) {
  return !!location?.requiresApproval;
}
function LocationIcon({
  location,
  size = 20,
}: {
  location?: PublicLocation;
  size?: number;
}) {
  const Icon =
    location?.type === "HOME"
      ? Home
      : location?.type === "ONLINE"
        ? Video
        : MapPin;
  return <Icon size={size} strokeWidth={1.7} />;
}

export function CourtlyLogo({ light = false }: { light?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[22px] font-bold tracking-[-1px] sm:gap-2.5 sm:text-[27px] sm:tracking-[-1.2px]",
        light ? "text-white" : "text-[#174c3c]",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full sm:h-8 sm:w-8",
          light ? "bg-[#d6e7b7] text-[#174c3c]" : "bg-[#174c3c] text-[#d8e9bb]",
        )}
      >
        <CircleDot
          className="h-6 w-6 sm:h-[26px] sm:w-[26px]"
          strokeWidth={1.4}
        />
      </span>
      Courtly
      <span className="-ml-1 mt-2 h-1.5 w-1.5 rounded-full bg-[#a6bb7d]" />
    </span>
  );
}

export function PublicShell({
  business,
  children,
}: {
  business?: PublicBookingBusiness;
  children: ReactNode;
}) {
  return (
    <div
      className="min-h-screen overflow-x-clip bg-[#f6f7f4] text-[#1c3029] [&_label.sr-only]:!absolute [&_label.sr-only]:!m-[-1px] [&_label.sr-only]:!h-px [&_label.sr-only]:!w-px [&_label.sr-only]:!overflow-hidden"
      style={
        business?.color?.startsWith("#")
          ? { borderTop: `4px solid ${business.color}` }
          : undefined
      }
    >
      <header className="sticky top-0 z-40 border-b border-[#e5e9e4] bg-white/95 backdrop-blur-xl">
        <div className="!mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:min-h-20 sm:px-8">
          <Link
            className="inline-flex min-h-11 items-center"
            href={
              business ? `/book/${encodeURIComponent(business.slug)}` : "/login"
            }
            aria-label={
              business ? `${business.name} booking home` : "Courtly home"
            }
          >
            <CourtlyLogo />
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden text-xs text-[#829082] md:block">
              A little less admin. A lot more play.
            </span>
            <span className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-[#e5e9e4] bg-[#f6f8f2] px-2.5 py-1.5 text-[10px] font-medium text-[#617455] sm:px-3 sm:text-[11px]">
              <ShieldCheck size={13} />{" "}
              {business ? "Guest booking" : "Made for coaches"}
            </span>
          </div>
        </div>
      </header>
      {children}
      <footer className="!mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-[11px] text-[#8a9489] sm:flex-row sm:px-8">
        <span>Thoughtfully powered by Courtly</span>
        <span>
          {business
            ? `${business.name} · ${business.timezone.replaceAll("_", " ")}`
            : "Your coaching day, in sync."}
        </span>
      </footer>
    </div>
  );
}

function Loading({ text = "Getting everything ready…" }: { text?: string }) {
  return (
    <div
      role="status"
      className="flex min-h-72 flex-col items-center justify-center gap-4 text-sm text-[#7a877b]"
    >
      <LoaderCircle className="animate-spin text-[#174c3c]" size={26} />
      <span>{text}</span>
    </div>
  );
}
function ErrorNotice({
  message,
  conflicts = [],
}: {
  message: string;
  conflicts?: { date: string; reason: string }[];
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#eedbd5] bg-[#fff7f3] p-4 text-sm leading-relaxed text-[#925541]"
    >
      <div className="flex items-start gap-2.5">
        <Info size={17} className="!mt-0.5 shrink-0" />
        <span>{message}</span>
      </div>
      {conflicts.length > 0 && (
        <ul className="!mt-3 space-y-2 pl-7">
          {conflicts.map((conflict, i) => (
            <li key={`${conflict.date}-${i}`}>
              <strong>{conflict.date}</strong> — {conflict.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function DetailRow({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="!mt-0.5 text-[#85927f]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wider text-[#8a9487]">
          {title}
        </p>
        <div className="!mt-1 text-sm leading-relaxed text-[#415244]">
          {children}
        </div>
      </div>
    </div>
  );
}
function VenueNotice({ location }: { location?: PublicLocation }) {
  if (!isPendingVenue(location)) return null;
  return (
    <div className="flex gap-3 rounded-2xl border border-[#e8d9b4] bg-[#fff9e9] p-4 text-xs leading-relaxed text-[#7c6636]">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#f4e8c5] text-[#8a713b]">
        <Info size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[1.3px] text-[#9a8149]">
          Venue confirmation required
        </p>
        <strong className="!mt-1 block font-semibold text-[#6f5b30]">
          {venueMessage}
        </strong>
        <p className="!mt-1">
          Your coach will confirm the venue separately. This is a request for a
          lesson, not a facility reservation.
        </p>
      </div>
    </div>
  );
}

function DateSlots({
  date,
  onDateChange,
  slots,
  loading,
  error,
  onRetry,
  selected,
  onSelect,
  timezone,
  minimumDate,
}: {
  date: string;
  onDateChange: (date: string) => void;
  slots: Slot[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  selected: string;
  onSelect: (slot: Slot) => void;
  timezone: string;
  minimumDate: string;
}) {
  const [week, setWeek] = useState(date || minimumDate);
  const dates = Array.from({ length: 7 }, (_, i) => plusDays(week, i));
  const available = slots.filter((slot) => slot.available);
  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="!text-base !font-semibold">
          {dayLabel(week, { month: "long", year: "numeric" })}
        </h3>
        <div className="grid w-full min-w-0 grid-cols-[44px_44px_minmax(0,1fr)] gap-2 sm:w-auto sm:grid-cols-[44px_44px_146px]">
          <button
            type="button"
            className={cn(secondary, "!h-11 !min-h-11 !w-11 !px-0 !py-0")}
            disabled={week <= minimumDate}
            onClick={() =>
              setWeek(
                plusDays(week, -7) < minimumDate
                  ? minimumDate
                  : plusDays(week, -7),
              )
            }
            aria-label="Previous week"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className={cn(secondary, "!h-11 !min-h-11 !w-11 !px-0 !py-0")}
            onClick={() => setWeek(plusDays(week, 7))}
            aria-label="Next week"
          >
            <ChevronRight size={18} />
          </button>
          <div className="min-w-0 overflow-hidden rounded-xl">
            <label htmlFor="booking-date" className="!mb-0 sr-only">
              Choose a date
            </label>
            <input
              id="booking-date"
              aria-label="Choose a date"
              type="date"
              value={date}
              min={minimumDate}
              onChange={(event) => {
                if (event.target.value && event.target.value >= minimumDate) {
                  onDateChange(event.target.value);
                  setWeek(event.target.value);
                }
              }}
              className="!block !min-h-11 !w-full !min-w-0 !max-w-full !rounded-xl !px-2.5 !py-2 !text-base sm:!text-xs"
            />
          </div>
        </div>
      </div>
      <div className="-mx-5 flex snap-x snap-mandatory gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:grid sm:grid-cols-7 sm:px-0">
        {dates.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onDateChange(key)}
            aria-pressed={date === key}
            aria-label={dayLabel(key, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
            className={cn(
              "flex min-h-[76px] w-[54px] shrink-0 snap-start flex-col items-center justify-center gap-1.5 rounded-xl border px-1 py-2.5 transition sm:w-auto",
              date === key
                ? "border-[#174c3c] bg-[#174c3c] text-white shadow-sm"
                : "border-[#e5e9e4] bg-white text-[#8a9487] hover:border-[#a1b397] hover:bg-[#f8faf5]",
            )}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide sm:text-xs sm:normal-case sm:tracking-normal">
              {dayLabel(key, { weekday: "short" })}
            </span>
            <span
              className={cn(
                "text-xl font-semibold",
                date !== key && "text-[#3b5140]",
              )}
            >
              {dayLabel(key, { day: "numeric" })}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-[#eef0eb] pt-5">
        <div className="!mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="!text-sm">Available start times</h3>
          <span className="flex items-center gap-1 text-[11px] text-[#82907e]">
            <Clock3 size={12} /> {timezone.replaceAll("_", " ")}
          </span>
        </div>
        {loading ? (
          <div
            role="status"
            className="flex min-h-28 items-center justify-center gap-2 py-8 text-sm text-[#81907c]"
          >
            <LoaderCircle size={17} className="animate-spin" />
            Checking availability…
          </div>
        ) : error ? (
          <div className="space-y-3">
            <ErrorNotice message={error} />
            <button type="button" className={secondary} onClick={onRetry}>
              <RefreshCw size={15} />
              Retry availability
            </button>
          </div>
        ) : available.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#dfe6db] bg-[#f8faf5] px-5 py-9 text-center">
            <CalendarDays
              size={28}
              strokeWidth={1.5}
              className="!mx-auto mb-3 text-[#92a385]"
            />
            <h3 className="!text-sm">A little breather on the calendar</h3>
            <p className="!mx-auto mt-2 max-w-xs text-xs leading-relaxed text-[#83907d]">
              There are no available times on this date. Try another day, coach,
              or location.
            </p>
            <button
              type="button"
              onClick={() => {
                const next = plusDays(date, 1);
                onDateChange(next);
                if (!dates.includes(next)) setWeek(next);
              }}
              className="!mt-4 inline-flex min-h-11 items-center gap-1.5 px-2 text-xs font-semibold text-[#174c3c]"
            >
              Try the next day <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {available.map((slot) => (
              <button
                key={slot.startAt}
                type="button"
                aria-pressed={selected === slot.startAt}
                onClick={() => onSelect(slot)}
                className={cn(
                  "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-3 text-sm font-semibold transition sm:px-2",
                  selected === slot.startAt
                    ? "border-[#174c3c] bg-[#e8eee9] text-[#174c3c] ring-1 ring-[#174c3c]"
                    : "border-[#e5e9e4] bg-white text-[#5b6c58] hover:border-[#9eaf94]",
                )}
              >
                <span className="whitespace-nowrap">
                  {time(slot.startAt, timezone)}
                </span>
                {slot.placesRemaining > 1 && (
                  <span className="text-[9px] font-normal text-[#82907c]">
                    {slot.placesRemaining} places left
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function PublicBooking({ slug }: { slug: string }) {
  const [data, setData] = useState<PublicBusiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [instructorId, setInstructorId] = useState("");
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [customer, setCustomer] = useState({
    name: "",
    email: "",
    phone: "",
    parentName: "",
  });
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [repeatWeeks, setRepeatWeeks] = useState(1);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [conflicts, setConflicts] = useState<
    { date: string; reason: string }[]
  >([]);
  const [result, setResult] = useState<BookingResult | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const value = await loadPublicBusiness(slug);
      setData(value);
      setDate(dateKey(new Date(), value.business.timezone));
    } catch (error) {
      setLoadError(messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [slug]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!serviceId || !locationId || !instructorId || !date) return;
    let ignore = false;
    setSlotsLoading(true);
    setSlotsError("");
    setSlots([]);
    setSlot(null);
    loadSlots(slug, { serviceId, locationId, instructorId, date })
      .then((value) => {
        if (!ignore) setSlots(value.slots);
      })
      .catch((error) => {
        if (!ignore) setSlotsError(messageOf(error));
      })
      .finally(() => {
        if (!ignore) setSlotsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [slug, serviceId, locationId, instructorId, date, slotsVersion]);

  const service = data?.services.find((value) => value.id === serviceId);
  const location = data?.locations.find((value) => value.id === locationId);
  const instructor = data?.instructors.find(
    (value) => value.id === instructorId,
  );
  const mapping = service?.locations.find(
    (value) => value.locationId === locationId,
  );
  const price = mapping?.price ?? service?.price ?? 0;
  const duration = mapping?.duration ?? service?.duration ?? 0;
  const eligibleLocations =
    data?.locations.filter(
      (value) =>
        value.active &&
        service?.locations.some(
          (item) =>
            item.locationId === value.id &&
            item.instructorIds.some((id) =>
              data.instructors.some((coach) => coach.id === id && coach.active),
            ),
        ),
    ) ?? [];
  const eligibleInstructors =
    data?.instructors.filter(
      (value) => value.active && mapping?.instructorIds.includes(value.id),
    ) ?? [];
  const timezone = data?.business.timezone ?? "Asia/Singapore";
  const today = dateKey(new Date(), timezone);
  const canContinue =
    step === 0
      ? !!serviceId
      : step === 1
        ? !!locationId && !!instructorId
        : step === 2
          ? !!slot && !slotsLoading
          : true;
  const actionLabel =
    step === 3
      ? "Review booking"
      : step === 4
        ? isPendingVenue(location)
          ? "Request booking"
          : "Confirm booking"
        : "Continue";
  const mobileSummary =
    step === 0
      ? service
        ? `${service.name} selected`
        : "Choose a lesson to continue"
      : step === 1
        ? location && instructor
          ? `${location.name} · ${instructor.name}`
          : "Choose a place and coach"
        : step === 2
          ? slot
            ? `${shortDate(slot.startAt, timezone)} · ${time(slot.startAt, timezone)}`
            : "Choose an available time"
          : step === 3
            ? `${repeatWeeks} session${repeatWeeks > 1 ? "s" : ""} · ${money(price * repeatWeeks, data?.business.currency)}`
            : isPendingVenue(location)
              ? "Venue arranged separately"
              : `${repeatWeeks} session${repeatWeeks > 1 ? "s" : ""} · ${money(price * repeatWeeks, data?.business.currency)}`;

  function goTo(next: number) {
    setStep(next);
    setSubmitError("");
    setConflicts([]);
    requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  function chooseService(value: Service) {
    setServiceId(value.id);
    setLocationId("");
    setInstructorId("");
    setSlot(null);
    setAgreed(false);
    const valid = value.locations.filter(
      (item) =>
        data?.locations.some(
          (place) => place.id === item.locationId && place.active,
        ) &&
        item.instructorIds.some((id) =>
          data?.instructors.some((coach) => coach.id === id && coach.active),
        ),
    );
    if (valid.length === 1) {
      setLocationId(valid[0].locationId);
      const coaches = valid[0].instructorIds.filter((id) =>
        data?.instructors.some((coach) => coach.id === id && coach.active),
      );
      if (coaches.length === 1) setInstructorId(coaches[0]);
    }
  }
  function chooseLocation(id: string) {
    setLocationId(id);
    setSlot(null);
    setAgreed(false);
    const nextMapping = service?.locations.find(
      (value) => value.locationId === id,
    );
    const coaches =
      data?.instructors.filter(
        (value) =>
          value.active && nextMapping?.instructorIds.includes(value.id),
      ) ?? [];
    setInstructorId(
      coaches.some((value) => value.id === instructorId)
        ? instructorId
        : coaches.length === 1
          ? coaches[0].id
          : "",
    );
  }
  async function submit() {
    if (
      !data ||
      !service ||
      !location ||
      !instructor ||
      !slot ||
      !agreed ||
      saving
    )
      return;
    setSaving(true);
    setSubmitError("");
    setConflicts([]);
    try {
      const value = await createPublicBooking(slug, {
        serviceId,
        locationId,
        instructorId,
        startAt: slot.startAt,
        customer: {
          name: customer.name.trim(),
          email: customer.email.trim().toLowerCase(),
          phone: customer.phone.trim(),
          parentName: customer.parentName.trim(),
        },
        repeatWeeks,
        notes: notes.trim(),
        address: location.type === "HOME" ? address.trim() : undefined,
      });
      if (!value.bookings?.length) {
        setSubmitError(
          "Your booking could not be completed. Please choose another time.",
        );
        setConflicts(value.conflicts ?? []);
        return;
      }
      setResult(value);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setSubmitError(messageOf(error));
      setConflicts(conflictList(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return (
      <PublicShell>
        <Loading text="Finding your next great lesson…" />
      </PublicShell>
    );
  if (loadError || !data)
    return (
      <PublicShell>
        <main className="!mx-auto max-w-lg px-5 py-20">
          <div className={cn(panel, "space-y-5 p-8")}>
            <CalendarDays className="text-[#829777]" size={32} />
            <h1 className="!text-2xl">We couldn’t open this booking page</h1>
            <ErrorNotice
              message={loadError || "This business is not available."}
            />
            <button className={secondary} onClick={() => void load()}>
              <RefreshCw size={15} />
              Try again
            </button>
          </div>
        </main>
      </PublicShell>
    );
  if (result)
    return (
      <PublicShell business={data.business}>
        <BookingReceipt
          data={data}
          result={result}
          customerName={customer.name}
          location={location}
          onBookAgain={() => {
            setResult(null);
            setStep(0);
            setServiceId("");
            setLocationId("");
            setInstructorId("");
            setSlot(null);
            setRepeatWeeks(1);
            setAgreed(false);
            setSubmitError("");
          }}
        />
      </PublicShell>
    );

  const titles = [
    "Good days start with a lesson.",
    "Your coach. Your kind of place.",
    "Make a little time for your game.",
    "Let’s get to know you.",
    "All set for your next good game?",
  ];
  const subtitles = [
    "A little practice, a little progress, a whole lot of possibility. Find the right session for you.",
    "Find your match, on and off the court. Choose where and who you’d like to play with.",
    "Pick a day and a time that fits. Availability is checked directly with your coach’s schedule.",
    "Just a few details so your coach can get ready for your session.",
    "Take a moment to check the details. We’ll keep the rest simple.",
  ];
  return (
    <PublicShell business={data.business}>
      <main className="!mx-auto max-w-6xl px-4 pb-40 pt-5 sm:px-8 sm:pb-10 sm:pt-10">
        <div className="!mb-5 flex min-w-0 items-center gap-3 sm:!mb-8">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[#dce4d4] bg-[#eaf0df] text-sm font-semibold text-[#658051]">
            {data.business.name
              .split(/\s+/)
              .map((part) => part[0])
              .slice(0, 2)
              .join("")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {data.business.name}
            </p>
            <p className="!mt-0.5 truncate text-[11px] text-[#87927e]">
              {data.business.tagline ||
                "A little more time doing what you love."}
            </p>
          </div>
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-[#85917b] sm:flex">
            <Sparkles size={13} /> Your next chapter starts here
          </span>
        </div>
        <nav aria-label="Booking progress" className="!mb-7 sm:!mb-10">
          <div className="flex items-start">
            {steps.map((label, index) => (
              <div
                key={label}
                className={cn(
                  "flex min-w-0 items-start",
                  index < steps.length - 1 ? "flex-1" : "",
                )}
              >
                <button
                  type="button"
                  disabled={index > step || saving}
                  onClick={() => goTo(index)}
                  aria-current={step === index ? "step" : undefined}
                  className={cn(
                    "flex min-h-11 min-w-11 flex-col items-center justify-start gap-1.5 text-center text-[10px] leading-tight disabled:cursor-default sm:min-w-0 sm:flex-row sm:justify-center sm:gap-2 sm:text-xs",
                    index <= step ? "text-[#174c3c]" : "text-[#99a292]",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-semibold sm:h-7 sm:w-7",
                      index < step
                        ? "bg-[#e1eadb] text-[#507a42]"
                        : index === step
                          ? "bg-[#174c3c] text-white shadow-sm"
                          : "border border-[#dfe5da] bg-white",
                    )}
                  >
                    {index < step ? <Check size={13} /> : index + 1}
                  </span>
                  <span
                    className={cn(
                      "hidden whitespace-nowrap sm:inline",
                      index === step && "font-semibold",
                    )}
                  >
                    {label}
                  </span>
                  <span
                    className={cn(
                      "max-w-[64px] sm:hidden",
                      index !== step && "sr-only",
                    )}
                  >
                    {label}
                  </span>
                </button>
                {index < steps.length - 1 && (
                  <span
                    className={cn(
                      "mx-0.5 !mt-4 h-px min-w-0 flex-1 sm:mx-4",
                      index < step ? "bg-[#b4c3aa]" : "bg-[#e0e5da]",
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        </nav>
        <div className="!mb-6 sm:!mb-8">
          <p className="!mb-2 text-[10px] font-semibold uppercase tracking-[1.7px] text-[#8a987e]">
            Step {step + 1} of 5 · {steps[step]}
          </p>
          <h1
            ref={heading}
            tabIndex={-1}
            className="scroll-mt-28 !text-[27px] !font-medium !leading-[1.15] !tracking-[-0.8px] outline-none sm:scroll-mt-6 sm:!text-[36px] sm:!tracking-[-1px]"
          >
            {titles[step]}
          </h1>
          <p className="!mt-3 max-w-xl text-sm leading-relaxed text-[#84907f]">
            {subtitles[step]}
          </p>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_310px] lg:gap-8">
          <div className="min-w-0">
            {step === 0 && (
              <div className="space-y-3">
                {data.services.filter((value) => value.active).length === 0 ? (
                  <div className={cn(panel, "p-10 text-center")}>
                    <CircleDot
                      size={32}
                      className="!mx-auto mb-4 text-[#9aac8c]"
                    />
                    <h2 className="!text-lg">Good things are on their way</h2>
                    <p className="!mt-2 text-sm leading-relaxed text-[#87927f]">
                      There aren’t any lessons available to book yet. Please
                      check back soon.
                    </p>
                  </div>
                ) : (
                  data.services
                    .filter((value) => value.active)
                    .map((value) => {
                      const prices = value.locations
                        .filter(
                          (item) =>
                            data.locations.some(
                              (place) =>
                                place.id === item.locationId && place.active,
                            ) &&
                            item.instructorIds.some((id) =>
                              data.instructors.some(
                                (coach) => coach.id === id && coach.active,
                              ),
                            ),
                        )
                        .map((item) => item.price);
                      const bookable = prices.length > 0;
                      return (
                        <button
                          key={value.id}
                          type="button"
                          disabled={!bookable}
                          onClick={() => chooseService(value)}
                          aria-pressed={serviceId === value.id}
                          className={cn(
                            panel,
                            "group w-full p-4 text-left transition hover:border-[#acbea0] sm:p-6",
                            serviceId === value.id &&
                              "!border-[#688761] bg-[#fbfdf8] ring-1 ring-[#688761]",
                            !bookable && "cursor-not-allowed opacity-60",
                          )}
                        >
                          <div className="flex items-start gap-3.5 sm:gap-4">
                            <span
                              className={cn(
                                "grid h-11 w-11 shrink-0 place-items-center rounded-xl sm:h-12 sm:w-12",
                                value.type === "GROUP"
                                  ? "bg-[#eef0e2] text-[#8a9763]"
                                  : "bg-[#e8eee9] text-[#658776]",
                              )}
                            >
                              {value.type === "GROUP" ? (
                                <UsersRound size={22} strokeWidth={1.5} />
                              ) : (
                                <CircleDot size={24} strokeWidth={1.5} />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="!mb-1 flex flex-wrap items-center gap-2">
                                <span className="text-[10px] font-medium uppercase tracking-wider text-[#8d997f]">
                                  {value.category ||
                                    (value.type === "GROUP"
                                      ? "Better together"
                                      : "Space to grow")}
                                </span>
                                {value.type === "GROUP" && (
                                  <span className="rounded bg-[#f0f3e8] px-1.5 py-0.5 text-[9px] text-[#85906f]">
                                    Small group
                                  </span>
                                )}
                              </div>
                              <h2 className="!text-base !font-semibold sm:!text-lg">
                                {value.name}
                              </h2>
                              <p className="!mt-1.5 max-w-md text-xs leading-relaxed text-[#85917f]">
                                {value.description}
                              </p>
                              <div className="!mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-[#687b64] sm:!mt-4 sm:gap-x-4 sm:gap-y-2">
                                <span className="inline-flex items-center gap-1.5">
                                  <Clock3 size={13} />
                                  {value.duration} min
                                  {value.locations.some(
                                    (item) => item.duration !== value.duration,
                                  )
                                    ? " · varies by location"
                                    : ""}
                                </span>
                                <span className="inline-flex items-center gap-1.5">
                                  <UserRound size={13} />
                                  {value.type === "GROUP"
                                    ? `Up to ${value.capacity} players`
                                    : "Just you & your coach"}
                                </span>
                              </div>
                            </div>
                            <span
                              className={cn(
                                "mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full border",
                                serviceId === value.id
                                  ? "border-[#174c3c] bg-[#174c3c] text-white"
                                  : "border-[#dce3d6]",
                              )}
                            >
                              {serviceId === value.id && <Check size={13} />}
                            </span>
                          </div>
                          <div className="!mt-4 flex items-end justify-between gap-3 border-t border-[#eef1e9] pt-3.5 sm:!mt-5 sm:pt-4">
                            <span className="text-[10px] leading-snug text-[#8c9783] sm:text-[11px]">
                              {bookable
                                ? "A little progress, every session"
                                : "Not currently available"}
                            </span>
                            <span className="shrink-0 text-lg font-semibold tracking-tight text-[#36543b]">
                              {bookable && new Set(prices).size > 1 && (
                                <span className="mr-1 text-[10px] font-normal text-[#8b9682]">
                                  from
                                </span>
                              )}
                              {money(
                                bookable ? Math.min(...prices) : value.price,
                                data.business.currency,
                              )}
                              <span className="ml-1 text-[10px] font-normal text-[#899581]">
                                / session
                              </span>
                            </span>
                          </div>
                        </button>
                      );
                    })
                )}
              </div>
            )}
            {step === 1 && (
              <div className="space-y-5">
                <section className={cn(panel, "p-4 sm:p-6")}>
                  <div className="!mb-4 flex items-center gap-2 sm:!mb-5">
                    <MapPin size={17} className="text-[#8a9b7d]" />
                    <h2 className="!text-base">
                      Where would you like to play?
                    </h2>
                  </div>
                  <div className="space-y-3">
                    {eligibleLocations.map((value) => {
                      const option = service?.locations.find(
                        (item) => item.locationId === value.id,
                      );
                      return (
                        <button
                          type="button"
                          key={value.id}
                          onClick={() => chooseLocation(value.id)}
                          aria-pressed={locationId === value.id}
                          className={cn(
                            "flex min-h-20 w-full items-start gap-3 rounded-xl border p-3.5 text-left transition sm:gap-3.5 sm:p-4",
                            locationId === value.id
                              ? "border-[#65885c] bg-[#f6f9f1] ring-1 ring-[#65885c]"
                              : "border-[#e5e9e0] hover:border-[#b2c2a7]",
                          )}
                        >
                          <span className="!mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#edf2e7] text-[#859b72]">
                            <LocationIcon location={value} size={19} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="text-sm font-semibold">
                              {value.name}
                            </span>
                            <p className="!mt-1 text-xs leading-relaxed text-[#86917e]">
                              {value.type === "HOME"
                                ? "Your home or private court · add your address later"
                                : value.type === "ONLINE"
                                  ? "Join your coach online"
                                  : value.address ||
                                    "Venue details shared by your coach"}
                            </p>
                            <p className="!mt-2 text-[11px] font-medium text-[#58704f]">
                              {money(
                                option?.price ?? price,
                                data.business.currency,
                              )}{" "}
                              · {option?.duration ?? duration} minutes
                              {isPendingVenue(value)
                                ? " · Venue confirmation needed"
                                : ""}
                            </p>
                          </div>
                          <span
                            className={cn(
                              "mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full border",
                              locationId === value.id
                                ? "border-[#174c3c] bg-[#174c3c] text-white"
                                : "border-[#dce3d6]",
                            )}
                          >
                            {locationId === value.id && <Check size={13} />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {eligibleLocations.length === 0 && (
                    <p className="text-sm text-[#83907b]">
                      No locations are available for this lesson. Please choose
                      another lesson.
                    </p>
                  )}
                </section>
                <VenueNotice location={location} />
                <section className={cn(panel, "p-4 sm:p-6")}>
                  <div className="!mb-4 flex items-center gap-2 sm:!mb-5">
                    <UserRound size={17} className="text-[#8a9b7d]" />
                    <h2 className="!text-base">Find your coach</h2>
                  </div>
                  {!locationId ? (
                    <p className="rounded-xl bg-[#f7f9f4] p-4 text-sm text-[#87937e]">
                      Choose a location above to see your available coaches.
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {eligibleInstructors.map((value) => (
                        <button
                          type="button"
                          key={value.id}
                          onClick={() => {
                            setInstructorId(value.id);
                            setSlot(null);
                          }}
                          aria-pressed={instructorId === value.id}
                          className={cn(
                            "flex min-h-[72px] items-center gap-3 rounded-xl border p-3.5 text-left transition sm:p-4",
                            instructorId === value.id
                              ? "border-[#65885c] bg-[#f6f9f1] ring-1 ring-[#65885c]"
                              : "border-[#e5e9e0] hover:border-[#b2c2a7]",
                          )}
                        >
                          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#e8eedf] text-xs font-semibold text-[#738958]">
                            {value.initials || value.name.slice(0, 2)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold">
                              {value.name}
                            </span>
                            <span className="!mt-1 block text-[11px] leading-relaxed text-[#86917e]">
                              {value.specialty ||
                                "Here to help you find your game"}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "grid h-6 w-6 shrink-0 place-items-center rounded-full border",
                              instructorId === value.id
                                ? "border-[#174c3c] bg-[#174c3c] text-white"
                                : "border-[#dce3d6]",
                            )}
                          >
                            {instructorId === value.id && <Check size={13} />}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
            {step === 2 && (
              <section className={cn(panel, "p-5 sm:p-7")}>
                <DateSlots
                  date={date}
                  onDateChange={(value) => {
                    setDate(value);
                    setSlot(null);
                  }}
                  slots={slots}
                  loading={slotsLoading}
                  error={slotsError}
                  onRetry={() => setSlotsVersion((value) => value + 1)}
                  selected={slot?.startAt ?? ""}
                  onSelect={setSlot}
                  timezone={timezone}
                  minimumDate={today}
                />
                <div className="!mt-6 flex items-start gap-2 border-t border-[#edf0e8] pt-4 text-[11px] leading-relaxed text-[#8b9681]">
                  <Info size={14} className="!mt-0.5 shrink-0" />
                  <span>
                    {duration}-minute session
                    {service?.bufferMinutes
                      ? `, with ${service.bufferMinutes} minutes of breathing room between lessons`
                      : ""}
                    . Times are shown in the coach’s timezone.
                  </span>
                </div>
              </section>
            )}
            {step === 3 && (
              <form
                id="customer-details"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    customer.name.trim().length < 2 ||
                    !customer.phone.trim() ||
                    (location?.type === "HOME" && !address.trim())
                  )
                    return;
                  goTo(4);
                }}
                className="space-y-5"
              >
                <section className={cn(panel, "p-5 sm:p-7")}>
                  <h2 className="!mb-1 !text-base">
                    The person behind the booking
                  </h2>
                  <p className="!mb-6 text-xs text-[#89957f]">
                    No account needed. Just you, and your next session.
                  </p>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label htmlFor="customer-name">
                        Player’s full name{" "}
                        <span className="text-[#9aa58f]">*</span>
                      </label>
                      <input
                        id="customer-name"
                        className={field}
                        required
                        minLength={2}
                        maxLength={120}
                        pattern=".*\S.*\S.*"
                        title="Enter the player’s name using at least two non-space characters."
                        autoComplete="name"
                        placeholder="e.g. Alex Tan"
                        value={customer.name}
                        onChange={(event) =>
                          setCustomer({ ...customer, name: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label htmlFor="customer-email">
                        Email address <span className="text-[#9aa58f]">*</span>
                      </label>
                      <input
                        id="customer-email"
                        className={field}
                        type="email"
                        required
                        maxLength={254}
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={customer.email}
                        onChange={(event) =>
                          setCustomer({
                            ...customer,
                            email: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <label htmlFor="customer-phone">
                        Phone number <span className="text-[#9aa58f]">*</span>
                      </label>
                      <input
                        id="customer-phone"
                        className={field}
                        type="tel"
                        required
                        maxLength={40}
                        pattern=".*[0-9].*"
                        title="Enter a phone number with your country code."
                        autoComplete="tel"
                        placeholder="e.g. +65 9123 4567"
                        value={customer.phone}
                        onChange={(event) =>
                          setCustomer({
                            ...customer,
                            phone: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="parent-name">
                        Parent or guardian’s name{" "}
                        <span className="ml-1 font-normal text-[#99a28e]">
                          optional
                        </span>
                      </label>
                      <input
                        id="parent-name"
                        className={field}
                        maxLength={120}
                        placeholder="If you’re booking for a younger player"
                        value={customer.parentName}
                        onChange={(event) =>
                          setCustomer({
                            ...customer,
                            parentName: event.target.value,
                          })
                        }
                      />
                    </div>
                    {location?.type === "HOME" && (
                      <div className="sm:col-span-2">
                        <label htmlFor="customer-address">
                          Session address{" "}
                          <span className="text-[#9aa58f]">*</span>
                        </label>
                        <textarea
                          id="customer-address"
                          className={field}
                          required
                          maxLength={500}
                          autoComplete="street-address"
                          rows={3}
                          placeholder="Street address, unit number, postal code, and court access details"
                          value={address}
                          onChange={(event) => {
                            setAddress(event.target.value);
                            event.target.setCustomValidity(
                              event.target.value.trim()
                                ? ""
                                : "Please enter the session address.",
                            );
                          }}
                        />
                        <p className="!mt-1.5 text-[11px] text-[#89957f]">
                          Please make sure your coach can access the court or
                          training space.
                        </p>
                      </div>
                    )}
                    <div className="sm:col-span-2">
                      <label htmlFor="booking-notes">
                        Anything your coach should know?{" "}
                        <span className="ml-1 font-normal text-[#99a28e]">
                          optional
                        </span>
                      </label>
                      <textarea
                        id="booking-notes"
                        className={field}
                        rows={3}
                        maxLength={2000}
                        placeholder="Your experience, goals, or anything that helps us prepare…"
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                      />
                    </div>
                  </div>
                </section>
                <section className={cn(panel, "p-5 sm:p-7")}>
                  <h2 className="!text-base">
                    Make a good thing a regular thing
                  </h2>
                  <p className="!mb-5 mt-2 text-xs leading-relaxed text-[#89957f]">
                    Book the same time each week. Every date is checked before
                    your booking is confirmed.
                  </p>
                  <div className="grid grid-cols-3 gap-2.5">
                    {[1, 4, 8].map((count) => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => {
                          setRepeatWeeks(count);
                          setAgreed(false);
                        }}
                        aria-pressed={repeatWeeks === count}
                        className={cn(
                          "rounded-xl border px-2 py-4 text-center transition",
                          repeatWeeks === count
                            ? "border-[#65885c] bg-[#f1f6eb] ring-1 ring-[#65885c]"
                            : "border-[#e5e9e0] hover:border-[#b2c2a7]",
                        )}
                      >
                        <span className="block text-sm font-semibold">
                          {count === 1 ? "Just this once" : `${count} weeks`}
                        </span>
                        <span className="!mt-1.5 block text-[10px] text-[#89957f]">
                          {count === 1
                            ? "One great session"
                            : `${count} weekly sessions`}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="!mt-4 flex justify-between text-xs text-[#7e8f71]">
                    <span>
                      {repeatWeeks} session{repeatWeeks > 1 ? "s" : ""} ×{" "}
                      {money(price, data.business.currency)}
                    </span>
                    <span className="font-semibold text-[#3b5f3a]">
                      {money(price * repeatWeeks, data.business.currency)}
                    </span>
                  </div>
                </section>
              </form>
            )}
            {step === 4 && (
              <div className="space-y-5">
                <section className={cn(panel, "overflow-hidden")}>
                  <div className="flex items-center justify-between border-b border-[#edf0e8] bg-[#fafbf7] px-5 py-4 sm:px-7">
                    <h2 className="!text-base">Your session, at a glance</h2>
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-[#8a987c]">
                      <CheckCheck size={14} />
                      Nearly there
                    </span>
                  </div>
                  <div className="grid gap-6 p-5 sm:grid-cols-2 sm:p-7">
                    <DetailRow
                      icon={<CircleDot size={18} />}
                      title="Your lesson"
                    >
                      {service?.name}
                      <p className="text-xs text-[#8b9781]">
                        {duration} minutes ·{" "}
                        {service?.type === "GROUP"
                          ? "Group session"
                          : "Private session"}
                      </p>
                    </DetailRow>
                    <DetailRow
                      icon={<UserRound size={18} />}
                      title="Your coach"
                    >
                      {instructor?.name}
                    </DetailRow>
                    <DetailRow
                      icon={<CalendarDays size={18} />}
                      title={repeatWeeks > 1 ? "First session" : "Your session"}
                    >
                      {slot && shortDate(slot.startAt, timezone)}
                      <p className="text-xs text-[#8b9781]">
                        {slot &&
                          `${time(slot.startAt, timezone)} – ${time(slot.endAt, timezone)}`}{" "}
                        · {timezone}
                      </p>
                    </DetailRow>
                    <DetailRow
                      icon={<LocationIcon location={location} size={18} />}
                      title="The place"
                    >
                      {location?.name}
                      <p className="break-words text-xs text-[#8b9781]">
                        {location?.type === "HOME"
                          ? address
                          : location?.address}
                      </p>
                    </DetailRow>
                    <DetailRow icon={<UserRound size={18} />} title="Player">
                      {customer.name}
                      <p className="break-all text-xs text-[#8b9781]">
                        {customer.email}
                      </p>
                      <p className="text-xs text-[#8b9781]">{customer.phone}</p>
                      {customer.parentName && (
                        <p className="!mt-1 text-xs text-[#8b9781]">
                          Parent / guardian: {customer.parentName}
                        </p>
                      )}
                    </DetailRow>
                    <DetailRow
                      icon={<RefreshCw size={18} />}
                      title="A little consistency"
                    >
                      {repeatWeeks === 1
                        ? "One session"
                        : `${repeatWeeks} weekly sessions`}
                      <p className="text-xs text-[#8b9781]">
                        {repeatWeeks > 1
                          ? "Same day, same time, every week"
                          : "One step toward your next best game"}
                      </p>
                    </DetailRow>
                    {notes && (
                      <div className="sm:col-span-2">
                        <DetailRow
                          icon={<MessageCircle size={18} />}
                          title="A note for your coach"
                        >
                          <p className="whitespace-pre-wrap break-words">
                            {notes}
                          </p>
                        </DetailRow>
                      </div>
                    )}
                  </div>
                  {repeatWeeks > 1 && (
                    <div className="border-t border-[#edf0e8] px-5 py-4 sm:px-7">
                      <p className="!mb-2 text-[10px] font-medium uppercase tracking-wider text-[#8b9781]">
                        Your weekly dates
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {Array.from({ length: repeatWeeks }, (_, i) => (
                          <span
                            key={i}
                            className="rounded-lg bg-[#f1f5ea] px-2.5 py-1.5 text-[11px] text-[#71865f]"
                          >
                            {dayLabel(plusDays(date, i * 7), {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-[#edf0e8] px-5 py-5 sm:px-7">
                    <span className="text-sm text-[#7b8a70]">
                      Total · {repeatWeeks} session{repeatWeeks > 1 ? "s" : ""}
                    </span>
                    <span className="text-xl font-semibold tracking-tight text-[#315633]">
                      {money(price * repeatWeeks, data.business.currency)}
                    </span>
                  </div>
                </section>
                <VenueNotice location={location} />
                <section className={cn(panel, "p-5 sm:p-6")}>
                  <div className="!mb-4 flex gap-3">
                    <ShieldCheck
                      size={20}
                      className="!mt-0.5 shrink-0 text-[#829974]"
                    />
                    <div>
                      <h3 className="!text-sm">
                        Simple, clear, and good to know
                      </h3>
                      <p className="!mt-1.5 text-xs leading-relaxed text-[#89957f]">
                        Payment is arranged directly with {data.business.name}.
                        No payment is collected here. Please cancel or
                        reschedule at least {data.business.cancellationHours}{" "}
                        hours before your session.
                      </p>
                    </div>
                  </div>
                  <label className="!mb-0 !flex cursor-pointer items-start gap-3 !text-xs !font-normal !leading-relaxed !text-[#64775b]">
                    <input
                      type="checkbox"
                      checked={agreed}
                      onChange={(event) => setAgreed(event.target.checked)}
                      className="!mt-0.5 !h-4 !w-4 shrink-0"
                    />
                    <span>
                      I’ve checked my details and understand the cancellation
                      policy.{isPendingVenue(location) && ` ${venueMessage}.`}
                    </span>
                  </label>
                </section>
                {submitError && (
                  <div className="space-y-3">
                    <ErrorNotice message={submitError} conflicts={conflicts} />
                    <button
                      type="button"
                      className="inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-[#174c3c]"
                      onClick={() => {
                        setSlot(null);
                        setSlotsVersion((value) => value + 1);
                        goTo(2);
                      }}
                    >
                      <CalendarDays size={14} />
                      Choose a different time
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="!mt-6 hidden items-center justify-between gap-4 sm:flex">
              <button
                type="button"
                className={cn(secondary, step === 0 && "invisible")}
                disabled={step === 0 || saving}
                onClick={() => goTo(step - 1)}
              >
                <ArrowLeft size={15} />
                Back
              </button>
              {step === 3 ? (
                <button
                  type="submit"
                  form="customer-details"
                  className={button}
                >
                  Review booking <ArrowRight size={15} />
                </button>
              ) : step === 4 ? (
                <button
                  type="button"
                  className={button}
                  disabled={!agreed || saving}
                  onClick={() => void submit()}
                >
                  {saving ? (
                    <>
                      <LoaderCircle size={16} className="animate-spin" />
                      Booking your session…
                    </>
                  ) : (
                    <>
                      {actionLabel} <ArrowRight size={15} />
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className={button}
                  disabled={!canContinue}
                  onClick={() => goTo(step + 1)}
                >
                  Continue <ArrowRight size={15} />
                </button>
              )}
            </div>
            <p className="!mt-4 text-right text-[10px] text-[#98a08f]">
              {step === 4
                ? "No online payment. Just a little commitment to your game."
                : "Good things, one step at a time."}
            </p>
          </div>
          <aside className="hidden space-y-4 lg:sticky lg:top-28 lg:block">
            <div className={cn(panel, "overflow-hidden")}>
              <div className="border-b border-[#edf0e8] px-6 py-5">
                <div className="!mb-1 flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#98af7e]" />
                  <p className="text-[10px] font-medium uppercase tracking-[1.5px] text-[#89967e]">
                    Your next good game
                  </p>
                </div>
                <h2 className="!text-lg !font-medium">
                  A little time, just for you.
                </h2>
              </div>
              <div className="space-y-5 px-6 py-6">
                <DetailRow icon={<CircleDot size={17} />} title="Lesson">
                  {service?.name || (
                    <span className="text-[#a0aa95]">
                      Choose something you’ll love
                    </span>
                  )}
                  {service && (
                    <p className="text-[11px] text-[#8d9983]">
                      {duration} minutes ·{" "}
                      {service.type === "GROUP" ? "Group" : "Private"}
                    </p>
                  )}
                </DetailRow>
                <DetailRow icon={<UserRound size={17} />} title="Coach">
                  {instructor?.name || (
                    <span className="text-[#a0aa95]">
                      Your perfect match awaits
                    </span>
                  )}
                </DetailRow>
                <DetailRow icon={<MapPin size={17} />} title="Place">
                  {location?.name || (
                    <span className="text-[#a0aa95]">
                      Find your favourite spot
                    </span>
                  )}
                </DetailRow>
                <DetailRow icon={<CalendarDays size={17} />} title="When">
                  {slot ? (
                    <>
                      {shortDate(slot.startAt, timezone)}
                      <p className="text-[11px] text-[#8d9983]">
                        {time(slot.startAt, timezone)} · {timezone}
                      </p>
                      {repeatWeeks > 1 && (
                        <p className="!mt-1 text-[11px] text-[#789263]">
                          Repeats weekly · {repeatWeeks} sessions
                        </p>
                      )}
                    </>
                  ) : (
                    <span className="text-[#a0aa95]">
                      A time that works for you
                    </span>
                  )}
                </DetailRow>
              </div>
              <div className="border-t border-[#edf0e8] bg-[#fafbf7] px-6 py-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#849077]">
                    {repeatWeeks > 1
                      ? `Total for ${repeatWeeks} sessions`
                      : "Session total"}
                  </span>
                  <span className="text-2xl font-semibold tracking-tight text-[#385838]">
                    {service
                      ? money(price * repeatWeeks, data.business.currency)
                      : "—"}
                  </span>
                </div>
                <p className="!mt-2 text-[10px] leading-relaxed text-[#929d86]">
                  {service && !mapping
                    ? "Final price depends on your chosen location."
                    : "Payment arranged directly with your coach."}
                </p>
              </div>
            </div>
            <div className="flex gap-3 rounded-2xl border border-[#e3e8d9] bg-[#eef3e5] p-5">
              <Sparkles size={18} className="!mt-0.5 shrink-0 text-[#8ea36d]" />
              <div>
                <h3 className="!text-xs !font-semibold text-[#6f8555]">
                  The best investment is in you.
                </h3>
                <p className="!mt-1.5 text-[11px] leading-relaxed text-[#8a9979]">
                  Show up, find your rhythm, and enjoy a little progress every
                  time.
                </p>
              </div>
            </div>
          </aside>
        </div>
        <div
          className="fixed inset-x-0 bottom-0 z-50 border-t border-[#dfe5dc] bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 shadow-[0_-12px_30px_rgba(28,48,41,0.09)] backdrop-blur-xl sm:hidden"
          role="region"
          aria-label="Booking actions"
        >
          <div className="!mx-auto max-w-lg">
            <div className="!mb-2 flex min-w-0 items-center justify-between gap-3 px-0.5">
              <p className="min-w-0 truncate text-[11px] font-medium text-[#748370]">
                {mobileSummary}
              </p>
              <p className="shrink-0 text-xs font-semibold text-[#253c31]">
                {service
                  ? money(price * repeatWeeks, data.business.currency)
                  : "Select your lesson"}
              </p>
            </div>
            <div className="flex min-w-0 gap-2.5">
              {step > 0 && (
                <button
                  type="button"
                  aria-label="Back"
                  className={cn(secondary, "!h-12 !w-12 !shrink-0 !px-0")}
                  disabled={saving}
                  onClick={() => goTo(step - 1)}
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              {step === 3 ? (
                <button
                  type="submit"
                  form="customer-details"
                  className={cn(button, "!min-h-12 !min-w-0 !flex-1 !px-4")}
                >
                  Review booking <ArrowRight size={15} />
                </button>
              ) : step === 4 ? (
                <button
                  type="button"
                  className={cn(button, "!min-h-12 !min-w-0 !flex-1 !px-4")}
                  disabled={!agreed || saving}
                  onClick={() => void submit()}
                >
                  {saving ? (
                    <LoaderCircle size={16} className="animate-spin" />
                  ) : null}
                  <span className="truncate">
                    {saving ? "Booking…" : actionLabel}
                  </span>
                  {!saving && <ArrowRight size={15} className="shrink-0" />}
                </button>
              ) : (
                <button
                  type="button"
                  className={cn(button, "!min-h-12 !min-w-0 !flex-1 !px-4")}
                  disabled={!canContinue}
                  onClick={() => goTo(step + 1)}
                >
                  Continue <ArrowRight size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </PublicShell>
  );
}

function BookingReceipt({
  data,
  result,
  customerName,
  location,
  onBookAgain,
}: {
  data: PublicBusiness;
  result: BookingResult;
  customerName: string;
  location?: PublicLocation;
  onBookAgain: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const first = result.bookings[0];
  const pending = result.bookings.some(
    (booking) => booking.status === "PENDING",
  );
  const token =
    result.managementToken ||
    first.participants.find((participant) => participant.managementToken)
      ?.managementToken;
  const managePath = token ? `/manage/${encodeURIComponent(token)}` : "";
  const manageUrl = managePath ? `${origin}${managePath}` : "";
  const shareText = `${pending ? "My lesson request" : "My next lesson"} with ${data.business.name}: ${first.serviceName}, ${shortDate(first.startAt, data.business.timezone)} at ${time(first.startAt, data.business.timezone)} (${data.business.timezone}), with ${first.instructorName}. ${first.locationName}.${isPendingVenue(location) ? ` ${venueMessage}.` : ""}`;
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(manageUrl);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError(
        "Copy the booking link from the field below to keep it safe.",
      );
    }
  }
  return (
    <main className="!mx-auto max-w-2xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="!mb-8 text-center">
        <span className="!mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full border border-[#d9e5cd] bg-[#eaf2df] text-[#69884c]">
          {pending ? (
            <Clock3 size={30} strokeWidth={1.5} />
          ) : (
            <Check size={32} strokeWidth={1.7} />
          )}
        </span>
        <p className="!mb-2 text-[10px] font-semibold uppercase tracking-[2px] text-[#8c9c7d]">
          A little progress starts here
        </p>
        <h1 className="!text-3xl !font-medium !tracking-tight sm:!text-4xl">
          {pending ? "Your request is in." : "You’re on the calendar."}
        </h1>
        <p className="!mx-auto mt-3 max-w-md text-sm leading-relaxed text-[#85927a]">
          {pending
            ? `Thanks, ${customerName.split(" ")[0]}. Your coach will review your request. Check this page for the latest status.`
            : `Looking forward to seeing you, ${customerName.split(" ")[0]}. Here’s to finding your rhythm, one session at a time.`}
        </p>
      </div>
      <div className={cn(panel, "overflow-hidden")}>
        <div className="flex items-center justify-between border-b border-[#edf0e7] bg-[#fafbf7] px-6 py-5">
          <h2 className="!text-base">Your booking receipt</h2>
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-medium",
              pending
                ? "bg-[#f8eed3] text-[#a28747]"
                : "bg-[#eaf2e1] text-[#789258]",
            )}
          >
            {pending ? "Awaiting confirmation" : "Confirmed"}
          </span>
        </div>
        <div className="space-y-6 p-6 sm:p-8">
          <DetailRow icon={<CircleDot size={19} />} title="The lesson">
            {first.serviceName} with {first.instructorName}
            <p className="text-xs text-[#8b9780]">
              {result.bookings.length} session
              {result.bookings.length > 1 ? "s" : ""} · {first.locationName}
            </p>
          </DetailRow>
          <div className="space-y-3">
            {result.bookings.map((booking, i) => (
              <div
                key={booking.id}
                className="flex items-center gap-3 rounded-xl border border-[#e7ecdf] bg-[#f8faf4] p-3.5"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#eaf0df] text-[11px] font-medium text-[#85966e]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {shortDate(booking.startAt, data.business.timezone)}
                  </p>
                  <p className="!mt-1 text-[11px] text-[#8b977e]">
                    {time(booking.startAt, data.business.timezone)} –{" "}
                    {time(booking.endAt, data.business.timezone)} ·{" "}
                    {data.business.timezone}
                  </p>
                </div>
                {booking.participants.find((person) => person.managementToken)
                  ?.managementToken ? (
                  <Link
                    className="inline-flex min-h-10 shrink-0 items-center gap-1 text-[11px] font-medium text-[#698454]"
                    href={`/manage/${encodeURIComponent(booking.participants.find((person) => person.managementToken)!.managementToken!)}`}
                    aria-label={`Manage session on ${shortDate(booking.startAt, data.business.timezone)}`}
                  >
                    Manage <ArrowRight size={12} />
                  </Link>
                ) : (
                  <Check size={15} className="shrink-0 text-[#91a67a]" />
                )}
              </div>
            ))}
          </div>
          <VenueNotice location={location} />
          <div className="flex justify-between border-t border-[#edf0e7] pt-5">
            <span className="text-sm text-[#7e8d70]">
              Total · pay your coach directly
            </span>
            <span className="text-xl font-semibold text-[#375833]">
              {money(
                result.bookings.reduce(
                  (total, booking) =>
                    total + (booking.participants[0]?.price ?? booking.price),
                  0,
                ),
                data.business.currency,
              )}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-[#8d9881]">
            No payment has been collected by Courtly. Please arrange payment
            directly with {data.business.name}.
          </p>
        </div>
      </div>
      {result.conflicts?.length ? (
        <div className="!mt-5">
          <ErrorNotice
            message="Some requested dates were not booked. The confirmed sessions are listed above."
            conflicts={result.conflicts}
          />
        </div>
      ) : null}
      {token && (
        <div className="!mt-5 rounded-2xl border border-[#dfe7d4] bg-[#eef4e5] p-5 sm:p-6">
          <div className="!mb-4 flex gap-3">
            <ShieldCheck size={19} className="shrink-0 text-[#8a9e74]" />
            <div>
              <h3 className="!text-sm text-[#627e4a]">
                Keep your booking link somewhere safe
              </h3>
              <p className="!mt-1.5 text-xs leading-relaxed text-[#869675]">
                This private link lets you view and manage your booking. No
                sign-in needed. Anyone with the link can manage it, so only
                share it with someone you trust.
              </p>
            </div>
          </div>
          <label htmlFor="receipt-link" className="sr-only">
            Private management link
          </label>
          <input
            id="receipt-link"
            value={manageUrl}
            readOnly
            onFocus={(event) => event.target.select()}
            className="!min-h-10 !rounded-lg !border-[#dce5d1] !bg-white/70 !text-xs !text-[#6c805c]"
          />
          <div className="!mt-3 flex flex-wrap gap-2">
            <Link href={managePath} className={button}>
              Manage booking <ArrowRight size={14} />
            </Link>
            <button
              type="button"
              className={secondary}
              onClick={() => void copyLink()}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Link copied" : "Copy link"}
            </button>
          </div>
          {copyError && (
            <p role="status" className="!mt-3 text-xs text-[#7c8a6e]">
              {copyError}
            </p>
          )}
        </div>
      )}
      <div className="!mt-6 flex flex-col justify-center gap-3 sm:flex-row">
        <a
          className={secondary}
          href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
          target="_blank"
          rel="noreferrer"
        >
          <MessageCircle size={16} />
          Share session on WhatsApp <ExternalLink size={12} />
        </a>
        <button type="button" className={secondary} onClick={onBookAgain}>
          Book another session <ArrowRight size={15} />
        </button>
      </div>
      <p className="!mt-5 text-center text-[10px] text-[#9aa48e]">
        A good game is always worth making time for.
      </p>
    </main>
  );
}

// The management link is a guest credential; never require a workspace session here.
type ManagedBooking = {
  business: PublicBookingBusiness;
  booking: Booking;
  participant: Participant;
  location?: PublicLocation;
  bookings?: Booking[];
  canCancel?: boolean;
  canReschedule?: boolean;
};

export function ManageBooking({ token }: { token: string }) {
  const [data, setData] = useState<ManagedBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [conflicts, setConflicts] = useState<
    { date: string; reason: string }[]
  >([]);
  const [action, setAction] = useState<"none" | "cancel" | "reschedule">(
    "none",
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [version, setVersion] = useState(0);
  const path = `/manage/${encodeURIComponent(token)}`;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const value = await api<ManagedBooking>(
        `/manage/${encodeURIComponent(token)}`,
      );
      setData(value);
      setDate(dateKey(new Date(), value.business.timezone));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (action !== "reschedule" || !data || !date) return;
    let ignore = false;
    setSlotsLoading(true);
    setSlotsError("");
    setSlots([]);
    setSlot(null);
    loadSlots(data.business.slug, {
      serviceId: data.booking.serviceId,
      instructorId: data.booking.instructorId,
      locationId: data.booking.locationId,
      date,
    })
      .then((value) => {
        if (!ignore)
          setSlots(
            value.slots.filter(
              (value) => value.startAt !== data.booking.startAt,
            ),
          );
      })
      .catch((err) => {
        if (!ignore) setSlotsError(messageOf(err));
      })
      .finally(() => {
        if (!ignore) setSlotsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [action, data, date, version]);
  async function perform(kind: "cancel" | "reschedule") {
    if (busy || (kind === "reschedule" && !slot)) return;
    setBusy(true);
    setActionError("");
    setConflicts([]);
    try {
      const value = await api<ManagedBooking>(`${path}/${kind}`, {
        method: "POST",
        body: JSON.stringify(
          kind === "reschedule" ? { startAt: slot!.startAt } : {},
        ),
      });
      setData(value);
      setSlot(null);
      setAction("none");
      setNotice(
        kind === "cancel"
          ? "Your booking has been cancelled. Your coach’s schedule has been updated."
          : "Your session has been rescheduled. The new details are below.",
      );
    } catch (err) {
      setActionError(messageOf(err));
      setConflicts(conflictList(err));
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <PublicShell>
        <Loading text="Opening your booking…" />
      </PublicShell>
    );
  if (error || !data)
    return (
      <PublicShell>
        <main className="!mx-auto max-w-lg px-5 py-16">
          <section className={cn(panel, "space-y-5 p-7")}>
            <ShieldCheck size={30} className="text-[#93a582]" />
            <h1 className="!text-2xl">Let’s find your booking</h1>
            <ErrorNotice
              message={error || "This management link is not available."}
            />
            <p className="text-xs leading-relaxed text-[#86947a]">
              Check that you’ve opened the full private link from your booking
              receipt. If it no longer works, please contact your coach.
            </p>
            <button className={secondary} onClick={() => void load()}>
              <RefreshCw size={15} />
              Try again
            </button>
          </section>
        </main>
      </PublicShell>
    );
  const { booking, business, participant } = data;
  const location = data.location;
  const cancelled =
    booking.status === "CANCELLED" ||
    (participant as Participant & { cancelled?: boolean }).cancelled === true;
  const pending = booking.status === "PENDING";
  const started = new Date(booking.startAt).getTime() <= Date.now();
  const insideWindow =
    new Date(booking.startAt).getTime() - Date.now() <
    business.cancellationHours * 3_600_000;
  const canCancel =
    !cancelled &&
    booking.status !== "COMPLETED" &&
    (data.canCancel ?? (!started && !insideWindow));
  const canReschedule =
    !cancelled &&
    booking.status !== "COMPLETED" &&
    (data.canReschedule ?? (!started && !insideWindow));
  return (
    <PublicShell business={business}>
      <main className="!mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
        <div className="!mb-8">
          <Link
            href={`/book/${encodeURIComponent(business.slug)}`}
            className="!mb-6 inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-[#7c8f6d]"
          >
            <ArrowLeft size={14} />
            Back to {business.name}
          </Link>
          <p className="!mb-2 text-[10px] font-semibold uppercase tracking-[2px] text-[#8d9b80]">
            A little room to stay in sync
          </p>
          <h1 className="!text-3xl !font-medium !tracking-tight sm:!text-4xl">
            Your next good game.
          </h1>
          <p className="!mt-3 text-sm text-[#86937c]">
            Your booking details, all in one place. No sign-in needed.
          </p>
        </div>
        {notice && (
          <div
            role="status"
            className="!mb-5 flex items-start gap-2.5 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm leading-relaxed text-[#66834d]"
          >
            <CheckCheck size={18} className="!mt-0.5 shrink-0" />
            {notice}
          </div>
        )}
        {actionError && action === "none" && (
          <div className="!mb-5">
            <ErrorNotice message={actionError} conflicts={conflicts} />
          </div>
        )}
        <section className={cn(panel, "overflow-hidden")}>
          <div className="flex items-center justify-between gap-4 border-b border-[#edf0e8] bg-[#fafbf7] px-6 py-5">
            <h2 className="!text-base">{business.name}</h2>
            <span
              className={cn(
                "rounded-full px-3 py-1.5 text-[10px] font-medium",
                cancelled
                  ? "bg-[#f8e8e3] text-[#a67260]"
                  : pending
                    ? "bg-[#f8eed3] text-[#9b844b]"
                    : booking.status === "COMPLETED"
                      ? "bg-[#e8edf2] text-[#728696]"
                      : "bg-[#e9f0df] text-[#77905c]",
              )}
            >
              {cancelled
                ? "Cancelled"
                : pending
                  ? "Awaiting confirmation"
                  : booking.status === "COMPLETED"
                    ? "Completed"
                    : "Confirmed"}
            </span>
          </div>
          <div className="p-6 sm:p-8">
            <div className="!mb-7 flex items-center gap-4">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[#eaf0e2] text-[#869d6f]">
                <CircleDot size={29} strokeWidth={1.5} />
              </span>
              <div>
                <h2 className="!text-xl">{booking.serviceName}</h2>
                <p className="!mt-1.5 text-xs text-[#88967d]">
                  With {booking.instructorName} ·{" "}
                  {Math.round(
                    (new Date(booking.endAt).getTime() -
                      new Date(booking.startAt).getTime()) /
                      60000,
                  )}{" "}
                  minutes
                </p>
              </div>
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <DetailRow icon={<CalendarDays size={18} />} title="When">
                {shortDate(booking.startAt, business.timezone)}
                <p className="text-xs text-[#89977d]">
                  {time(booking.startAt, business.timezone)} –{" "}
                  {time(booking.endAt, business.timezone)}
                </p>
                <p className="text-[10px] text-[#9aa48e]">
                  {business.timezone}
                </p>
              </DetailRow>
              <DetailRow
                icon={<LocationIcon location={location} size={18} />}
                title="Where"
              >
                {booking.locationName}
                <p className="break-words text-xs text-[#89977d]">
                  {booking.address || location?.address}
                </p>
              </DetailRow>
              <DetailRow icon={<UserRound size={18} />} title="Player">
                {participant?.name || "Your session"}
                <p className="break-all text-xs text-[#89977d]">
                  {participant?.email}
                </p>
              </DetailRow>
              <DetailRow icon={<ShieldCheck size={18} />} title="Session price">
                {money(participant?.price ?? booking.price, business.currency)}
                <p className="text-xs text-[#89977d]">
                  {participant?.paid
                    ? "Marked paid by your coach"
                    : "Payment arranged with your coach"}
                </p>
              </DetailRow>
            </div>
            {pending && (
              <div className="!mt-6">
                <div className="flex gap-2.5 rounded-xl border border-[#eee5ce] bg-[#fcf8ec] p-4 text-xs leading-relaxed text-[#897344]">
                  <Info size={16} className="!mt-0.5 shrink-0" />
                  <div>
                    <strong>{venueMessage}</strong>
                    <p className="!mt-1">
                      Please wait for the venue and lesson to be confirmed by
                      your coach.
                    </p>
                  </div>
                </div>
              </div>
            )}
            {participant.notes && (
              <div className="!mt-6 rounded-xl bg-[#f7f9f3] p-4">
                <p className="!mb-1 text-[10px] font-medium uppercase tracking-wide text-[#96a08a]">
                  What you shared
                </p>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[#7d8d71]">
                  {participant.notes}
                </p>
              </div>
            )}
          </div>
        </section>
        {action === "none" && (
          <section className={cn(panel, "mt-5 p-6")}>
            <h2 className="!text-base">Plans change. We get it.</h2>
            <p className="!mt-2 text-xs leading-relaxed text-[#87967b]">
              {cancelled
                ? "This booking is cancelled. We’d love to see you another time."
                : `Please make changes at least ${business.cancellationHours} hours before your session. Changes here apply to this session only.`}
            </p>
            {!cancelled && booking.type === "GROUP" && !canReschedule && (
              <p className="!mt-3 text-xs leading-relaxed text-[#849575]">
                To move your place in a group session, please contact your
                coach.
              </p>
            )}
            {!cancelled && !canCancel && !canReschedule && (
              <p className="!mt-3 rounded-xl bg-[#f6f8f2] p-3 text-xs leading-relaxed text-[#849575]">
                {started
                  ? "This session has already started or finished."
                  : "This session is within the cancellation window."}{" "}
                Please contact your coach about any changes.
              </p>
            )}
            <div className="!mt-5 flex flex-wrap gap-3">
              {canReschedule && (
                <button
                  className={secondary}
                  onClick={() => {
                    setAction("reschedule");
                    setActionError("");
                    setNotice("");
                    setDate(dateKey(booking.startAt, business.timezone));
                  }}
                >
                  <CalendarDays size={16} />
                  Reschedule session
                </button>
              )}
              {canCancel && (
                <button
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#edddd7] px-4 py-2.5 text-xs font-medium text-[#a37565] transition hover:bg-[#fff7f3]"
                  onClick={() => {
                    setAction("cancel");
                    setActionError("");
                    setNotice("");
                  }}
                >
                  <X size={15} />
                  Cancel booking
                </button>
              )}
              {cancelled && (
                <Link
                  href={`/book/${encodeURIComponent(business.slug)}`}
                  className={button}
                >
                  Find a new session <ArrowRight size={15} />
                </Link>
              )}
            </div>
          </section>
        )}
        {action === "cancel" && (
          <section
            role="region"
            aria-label="Confirm cancellation"
            className="!mt-5 rounded-2xl border border-[#e7d4ca] bg-[#fffcf9] p-6"
          >
            <h2 className="!text-lg">Cancel this session?</h2>
            <p className="!mt-2 text-sm leading-relaxed text-[#958273]">
              This will release your place in {booking.serviceName} on{" "}
              {shortDate(booking.startAt, business.timezone)} at{" "}
              {time(booking.startAt, business.timezone)}. This action cannot be
              undone.
            </p>
            <p className="!mt-3 text-xs leading-relaxed text-[#a09586]">
              Other sessions in a weekly series are not changed. If you have
              paid your coach, please contact them directly about their refund
              policy.
            </p>
            {actionError && (
              <div className="!mt-4">
                <ErrorNotice message={actionError} />
              </div>
            )}
            <div className="!mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() => setAction("none")}
              >
                Keep my booking
              </button>
              <button
                type="button"
                disabled={busy}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#a46d56] px-5 py-3 text-sm font-semibold text-white hover:bg-[#8b5945] disabled:opacity-50"
                onClick={() => void perform("cancel")}
              >
                {busy ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <X size={15} />
                )}
                Yes, cancel this session
              </button>
            </div>
          </section>
        )}
        {action === "reschedule" && (
          <section className={cn(panel, "mt-5 p-5 sm:p-7")}>
            <div className="!mb-6 flex items-center justify-between">
              <div>
                <h2 className="!text-lg">Find a better time</h2>
                <p className="!mt-2 text-xs text-[#8b987f]">
                  Same lesson, coach, and location. Just a fresh start time.
                </p>
              </div>
              <button
                className={cn(secondary, "!px-2.5")}
                aria-label="Close reschedule"
                disabled={busy}
                onClick={() => setAction("none")}
              >
                <X size={17} />
              </button>
            </div>
            <DateSlots
              date={date}
              onDateChange={(value) => {
                setDate(value);
                setSlot(null);
              }}
              slots={slots}
              loading={slotsLoading}
              error={slotsError}
              onRetry={() => setVersion((value) => value + 1)}
              selected={slot?.startAt ?? ""}
              onSelect={setSlot}
              timezone={business.timezone}
              minimumDate={dateKey(new Date(), business.timezone)}
            />
            {slot && (
              <div className="!mt-5 rounded-xl bg-[#f0f5e8] p-4 text-xs leading-relaxed text-[#7d9169]">
                Your new session:{" "}
                <strong>
                  {shortDate(slot.startAt, business.timezone)},{" "}
                  {time(slot.startAt, business.timezone)}
                </strong>
                . Your current time is kept until this change succeeds.
              </div>
            )}
            {actionError && (
              <div className="!mt-5">
                <ErrorNotice message={actionError} conflicts={conflicts} />
              </div>
            )}
            <div className="!mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() => setAction("none")}
              >
                Keep original time
              </button>
              <button
                type="button"
                className={button}
                disabled={!slot || busy || slotsLoading}
                onClick={() => void perform("reschedule")}
              >
                {busy ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <Check size={15} />
                )}
                Confirm new time
              </button>
            </div>
          </section>
        )}
        <div className="!mt-7 flex items-start gap-2.5 px-1 text-[11px] leading-relaxed text-[#96a08a]">
          <ShieldCheck size={15} className="!mt-0.5 shrink-0" />
          This is your private booking link. Keep it safe — anyone with this
          link can manage this booking.
        </div>
      </main>
    </PublicShell>
  );
}
