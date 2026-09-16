"use client";

import { useState } from "react";
import {
  CalendarDays,
  CalendarX2,
  Clock3,
  Copy,
  ExternalLink,
  Globe2,
  Link2,
  MapPin,
  Pencil,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { mutate } from "@/lib/api";
import { dateKey, shortDate, time } from "@/lib/utils";
import {
  Editor,
  Empty,
  Field,
  PageHeading,
  errorMessage,
  numeric,
  text,
  useManagementAction,
  type ManagementProps,
} from "./management-ui";

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const weekOrder = [1, 2, 3, 4, 5, 6, 0];
const localTime = (value: string) => time(`2026-01-05T${value}:00+08:00`);

export function AvailabilityView({ data, refresh }: ManagementProps) {
  const [instructorId, setInstructor] = useState(
    data.instructors.find((i) => i.active)?.id || "",
  );
  const [editor, setEditor] = useState<"weekly" | "exception">();
  const [showPast, setShowPast] = useState(false);
  const { busy, run } = useManagementAction(refresh);
  const rows = data.availability.filter((a) => a.instructorId === instructorId);
  const exceptions = data.exceptions
    .filter(
      (e) =>
        e.instructorId === instructorId &&
        (showPast || dateKey(e.date) >= dateKey()),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const selectedInstructor = data.instructors.find(
    (i) => i.id === instructorId,
  );
  return (
    <>
      <PageHeading
        title="Availability"
        description="Make space for the work you love. Set a weekly rhythm, then block out the days you need off."
        action={() => setEditor("weekly")}
        actionLabel="Add weekly hours"
      />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 rounded-xl border border-[#e5e9e0] bg-white p-4">
        <div className="w-full sm:max-w-72">
          <label htmlFor="availability-instructor">Instructor</label>
          <select
            id="availability-instructor"
            value={instructorId}
            onChange={(e) => setInstructor(e.target.value)}
          >
            <option value="" disabled>
              Select an instructor
            </option>
            {data.instructors.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {!i.active ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </div>
        <p className="flex items-center gap-2 rounded-full bg-[#f4f6f1] px-3 py-2 text-[11px] text-stone-500">
          <Globe2 size={13} />
          Singapore time · UTC+8
        </p>
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.45fr_1fr]">
        <section className="panel overflow-hidden">
          <div className="panel-heading">
            <div>
              <h2 className="text-[#294735]">Weekly hours</h2>
              <p className="mt-1 text-[11px] text-stone-500">
                Repeats every week for{" "}
                {selectedInstructor?.name || "your instructor"}
              </p>
            </div>
            <Clock3 size={17} className="text-[#9aa58b]" />
          </div>
          {!data.instructors.length ? (
            <Empty
              title="Start with your instructor roster"
              icon={CalendarDays}
            >
              Add an instructor in Team, then set their weekly working hours
              here.
            </Empty>
          ) : (
            <div>
              {weekOrder.map((day) => {
                const windows = rows
                  .filter((a) => a.dayOfWeek === day)
                  .sort((a, b) => a.startTime.localeCompare(b.startTime));
                return (
                  <div
                    key={day}
                    className="grid gap-3 border-t border-[#edf0e8] px-4 py-4 sm:grid-cols-[90px_1fr] sm:px-5"
                  >
                    <h3 className="pt-1 text-xs text-[#405941]">
                      {weekdays[day]}
                    </h3>
                    <div className="space-y-2">
                      {windows.length ? (
                        windows.map((row) => (
                          <div
                            key={row.id}
                            className="flex min-h-12 items-center justify-between gap-2 rounded-xl bg-[#f5f7f0] py-2 pl-3 pr-1.5"
                          >
                            <div>
                              <p className="text-xs font-medium text-[#344b39]">
                                {localTime(row.startTime)} –{" "}
                                {localTime(row.endTime)}
                              </p>
                              <p className="mt-1 flex items-center gap-1 text-[10px] text-stone-500">
                                <MapPin size={10} />
                                {data.locations.find(
                                  (l) => l.id === row.locationId,
                                )?.name || "Unavailable location"}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              aria-label={`Remove ${weekdays[day]} ${localTime(row.startTime)} availability`}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Remove ${weekdays[day]} ${localTime(row.startTime)}–${localTime(row.endTime)} weekly availability? Existing bookings will not be cancelled.`,
                                  )
                                )
                                  void run(
                                    `/availability/${row.id}`,
                                    "DELETE",
                                    undefined,
                                    "Weekly hours removed",
                                  );
                              }}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        ))
                      ) : (
                        <p className="py-1 text-[11px] text-stone-400">
                          Not available
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="border-t border-[#edf0e8] bg-[#fbfcfa] p-4">
            <p className="text-[10px] leading-relaxed text-stone-400">
              Available slots also respect service notice periods, lesson
              buffers, travel time, existing bookings, and blocked dates.
              Changing hours never cancels a booking.
            </p>
          </div>
        </section>
        <section className="panel overflow-hidden">
          <div className="panel-heading flex-wrap">
            <div>
              <h2 className="text-[#294735]">Blocked dates</h2>
              <p className="mt-1 text-[11px] text-stone-500">
                Full days away from the schedule
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditor("exception")}
              disabled={!instructorId}
              className="max-sm:w-full"
            >
              <Plus size={12} />
              Block date
            </Button>
          </div>
          {exceptions.length ? (
            <div className="space-y-3 px-4 pb-4 sm:px-5">
              {exceptions.map((exception) => (
                <div
                  className="flex min-h-14 items-start gap-3 rounded-xl border border-[#e6eae3] p-3"
                  key={exception.id}
                >
                  <span className="mt-0.5 text-[#9aaa8c]">
                    <CalendarX2 size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[#344b39]">
                      {shortDate(exception.date)}{" "}
                      {dateKey(exception.date).slice(0, 4)}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-stone-500">
                      {exception.reason || "Unavailable all day"}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Remove blocked date ${dateKey(exception.date)}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Unblock ${shortDate(exception.date)}? New bookings may become available on this date.`,
                        )
                      )
                        void run(
                          `/exceptions/${exception.id}`,
                          "DELETE",
                          undefined,
                          "Date unblocked",
                        );
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Nothing blocked out" icon={CalendarX2}>
              Add holidays, leave, or personal days. The entire date will be
              unavailable at every location.
            </Empty>
          )}
          <label className="m-0! flex min-h-12 cursor-pointer items-center gap-3 border-t border-[#edf0e8] px-5 py-4 text-[11px]! font-normal! hover:bg-[#fafbf8]">
            <input
              type="checkbox"
              checked={showPast}
              onChange={(e) => setShowPast(e.target.checked)}
            />
            Include past blocked dates
          </label>
        </section>
      </div>
      {editor === "weekly" && (
        <Editor
          title="Add weekly hours"
          description="Create one recurring working window at a location. Add separate windows for split shifts or different days."
          onClose={() => setEditor(undefined)}
          refresh={refresh}
          submitLabel="Add weekly hours"
          success="Weekly hours added"
          disabled={
            !data.instructors.some((i) => i.active) ||
            !data.locations.some((l) => l.active)
          }
          onSubmit={(form) => {
            const startTime = text(form, "startTime");
            const endTime = text(form, "endTime");
            const instructor = text(form, "hours-instructor");
            const day = numeric(form, "hours-day");
            if (startTime >= endTime)
              throw new Error(
                "End time must be later than start time. Add separate windows for shifts across midnight.",
              );
            if (
              data.availability.some(
                (a) =>
                  a.instructorId === instructor &&
                  a.dayOfWeek === day &&
                  a.startTime < endTime &&
                  a.endTime > startTime,
              )
            )
              throw new Error(
                "These hours overlap with an existing window for this instructor, including other locations.",
              );
            return mutate("/availability", "POST", {
              instructorId: instructor,
              locationId: text(form, "hours-location"),
              dayOfWeek: day,
              startTime,
              endTime,
            });
          }}
        >
          <div className="form-grid max-sm:grid-cols-1!">
            <Field label="Instructor" name="hours-instructor" wide>
              <select
                id="hours-instructor"
                name="hours-instructor"
                defaultValue={selectedInstructor?.active ? instructorId : ""}
                required
              >
                <option value="" disabled>
                  Select instructor
                </option>
                {data.instructors
                  .filter((i) => i.active)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Location" name="hours-location" wide>
              <select
                id="hours-location"
                name="hours-location"
                defaultValue=""
                required
              >
                <option value="" disabled>
                  Select location
                </option>
                {data.locations
                  .filter((l) => l.active)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Day of week" name="hours-day" wide>
              <select id="hours-day" name="hours-day" defaultValue="1" required>
                {weekOrder.map((day) => (
                  <option key={day} value={day}>
                    {weekdays[day]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Start time (Singapore)"
              name="startTime"
              type="time"
              defaultValue="09:00"
              required
            />
            <Field
              label="End time (Singapore)"
              name="endTime"
              type="time"
              defaultValue="18:00"
              required
            />
          </div>
          {(!data.instructors.some((i) => i.active) ||
            !data.locations.some((l) => l.active)) && (
            <p className="text-xs text-amber-800">
              Add an active instructor and location before creating weekly
              hours.
            </p>
          )}
        </Editor>
      )}
      {editor === "exception" && (
        <Editor
          title="Block a date"
          description="This instructor will be unavailable all day across every location. Existing bookings are not cancelled; review them separately."
          onClose={() => setEditor(undefined)}
          refresh={refresh}
          submitLabel="Block date"
          success="Date blocked"
          onSubmit={(form) =>
            mutate("/exceptions", "POST", {
              instructorId: text(form, "blocked-instructor"),
              date: text(form, "date"),
              reason: text(form, "reason"),
            })
          }
        >
          <div className="form-grid max-sm:grid-cols-1!">
            <Field label="Instructor" name="blocked-instructor" wide>
              <select
                id="blocked-instructor"
                name="blocked-instructor"
                defaultValue={instructorId}
                required
              >
                {data.instructors.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Date"
              name="date"
              type="date"
              min={dateKey()}
              defaultValue={dateKey()}
              required
              wide
            />
            <Field
              label="Reason"
              name="reason"
              required
              wide
              placeholder="e.g. Annual leave or tournament day"
            />
          </div>
        </Editor>
      )}
    </>
  );
}

export function SettingsView({ data, refresh }: ManagementProps) {
  const [editing, setEditing] = useState(false);
  const business = data.business;
  const bookingPath = `/book/${encodeURIComponent(business.slug)}`;
  const bookingUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${bookingPath}`
      : bookingPath;
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${bookingPath}`,
      );
      toast.success("Booking link copied");
    } catch (error) {
      toast.error(
        `Could not copy the link. Select and copy it manually. ${errorMessage(error)}`,
      );
    }
  }
  return (
    <>
      <PageHeading
        title="Settings"
        description="The small details that make this space yours. Keep your business and booking preferences up to date."
      />
      <div className="grid items-start gap-6 xl:grid-cols-[1.35fr_1fr]">
        <div className="space-y-6">
          <section className="panel overflow-hidden">
            <div className="panel-heading">
              <div className="flex items-center gap-2">
                <Settings2 size={16} className="text-[#8da078]" />
                <h2 className="text-[#294735]">Business details</h2>
              </div>
              {data.user.role !== "COACH" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={12} />
                  Edit
                </Button>
              )}
            </div>
            <div className="space-y-5 px-4 pb-5 sm:px-6 sm:pb-6">
              <div className="flex items-center gap-4">
                <span
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[#edf2e5] text-xl font-semibold"
                  style={{ color: business.color }}
                >
                  {business.name.slice(0, 1)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-[#294735]">
                    {business.name}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {business.tagline || "Your next chapter starts here."}
                  </p>
                </div>
              </div>
              <dl className="grid grid-cols-1 gap-5 border-t border-[#edf0e8] pt-5 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-[10px] text-stone-400">Business owner</dt>
                  <dd className="mt-1.5 font-medium">{business.ownerName}</dd>
                </div>
                <div>
                  <dt className="text-[10px] text-stone-400">Contact email</dt>
                  <dd className="mt-1.5 break-all">{business.email}</dd>
                </div>
                <div>
                  <dt className="text-[10px] text-stone-400">Currency</dt>
                  <dd className="mt-1.5">SGD · Singapore dollar</dd>
                </div>
                <div>
                  <dt className="text-[10px] text-stone-400">Timezone</dt>
                  <dd className="mt-1.5">Asia/Singapore · UTC+8</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[10px] text-stone-400">
                    Customer cancellation notice
                  </dt>
                  <dd className="mt-1.5">
                    {business.cancellationHours} hours before the lesson
                  </dd>
                </div>
              </dl>
              <p className="rounded-xl bg-[#f5f7f1] p-3 text-[11px] leading-relaxed text-stone-500">
                This workspace currently supports Singapore time and SGD.
                Currency, timezone, and account email are not editable here.
              </p>
            </div>
          </section>
          <section className="panel overflow-hidden">
            <div className="panel-heading">
              <div className="flex items-center gap-2">
                <Link2 size={16} className="text-[#8da078]" />
                <h2 className="text-[#294735]">Your booking link</h2>
              </div>
              <span className="badge">Public page</span>
            </div>
            <div className="px-4 pb-5 sm:px-6 sm:pb-6">
              <p className="mb-4 text-xs leading-relaxed text-stone-500">
                Share a single link so customers can see your services and book
                an available lesson.
              </p>
              <label htmlFor="settings-booking-link">Public booking URL</label>
              <input
                id="settings-booking-link"
                value={bookingUrl}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                className="text-xs!"
              />
              <div className="mt-3 grid grid-cols-1 gap-2 sm:flex">
                <Button size="sm" onClick={copy}>
                  <Copy size={13} />
                  Copy link
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={bookingPath} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} />
                    Preview booking page
                  </a>
                </Button>
              </div>
              <p className="mt-4 text-[10px] leading-relaxed text-stone-400">
                Your link stays the same when you rename the business. Slug
                editing is not available.
              </p>
            </div>
          </section>
        </div>
        <div className="space-y-6">
          <section className="panel overflow-hidden">
            <div className="panel-heading">
              <div className="flex items-center gap-2">
                <Unplug size={16} className="text-[#8da078]" />
                <h2 className="text-[#294735]">Integrations</h2>
              </div>
            </div>
            <div className="space-y-5 px-4 pb-5 sm:px-6 sm:pb-6">
              {[
                {
                  name: "Online payments",
                  description:
                    "No payment gateway is connected. Payments are recorded manually after you receive them offline.",
                },
                {
                  name: "External calendars",
                  description:
                    "Calendar sync is not connected. Your workspace schedule is the source for booking availability.",
                },
                {
                  name: "Email & SMS delivery",
                  description:
                    "External message delivery is not connected. Check in-app notifications and contact customers directly.",
                },
              ].map((integration) => (
                <div
                  key={integration.name}
                  className="border-b border-[#edf0e8] pb-5 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs text-[#344b39]">
                      {integration.name}
                    </h3>
                    <span className="badge bg-stone-100! text-stone-500!">
                      Not connected
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-stone-500">
                    {integration.description}
                  </p>
                </div>
              ))}
              <p className="text-[10px] text-stone-400">
                Connection setup will be available in a later release.
              </p>
            </div>
          </section>
          <section className="rounded-xl border border-[#e1e8d6] bg-[#eef3e6] p-5 sm:p-6">
            <ShieldCheck
              size={21}
              strokeWidth={1.4}
              className="mb-3 text-[#7c9169]"
            />
            <h2 className="text-[#294735]">Workspace access</h2>
            <p className="mt-2 text-xs leading-relaxed text-[#7e8c72]">
              Signed in as {data.user.name} ({data.user.role.toLowerCase()}).
              Instructor profiles do not grant account access. Owners manage
              staff logins in Your team; email invitations and subscription
              billing are not connected.
            </p>
            {business.isDemo && (
              <p className="mt-3 text-[11px] leading-relaxed text-[#7e8c72]">
                This is a demo workspace. No subscription or online payment is
                being charged.
              </p>
            )}
          </section>
        </div>
      </div>
      {editing && (
        <Editor
          title="Edit business details"
          description="Your business name and tagline appear on your public booking page. Existing booking links stay the same."
          onClose={() => setEditing(false)}
          refresh={refresh}
          success="Business details updated"
          onSubmit={(form) =>
            mutate("/business", "PATCH", {
              name: text(form, "name"),
              ownerName: text(form, "ownerName"),
              color: text(form, "color"),
              tagline: text(form, "tagline"),
              cancellationHours: numeric(form, "cancellationHours"),
            })
          }
        >
          <div className="form-grid max-sm:grid-cols-1!">
            <Field
              label="Business name"
              name="name"
              required
              defaultValue={business.name}
              wide
            />
            <Field
              label="Owner name"
              name="ownerName"
              required
              defaultValue={business.ownerName}
              wide
            />
            <Field
              label="Tagline"
              name="tagline"
              defaultValue={business.tagline}
              wide
            />
            <Field
              label="Brand colour"
              name="color"
              type="color"
              defaultValue={business.color}
              required
            />
            <Field
              label="Cancellation notice (hours)"
              name="cancellationHours"
              type="number"
              min="0"
              max="720"
              step="1"
              required
              defaultValue={business.cancellationHours}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-stone-500">
            Customers can self-cancel until this many hours before their lesson.
            This updates the policy; it does not cancel or change existing
            lessons.
          </p>
        </Editor>
      )}
    </>
  );
}
