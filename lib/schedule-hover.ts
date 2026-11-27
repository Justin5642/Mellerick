// What the schedule board's hover card says about a booking (25 Nov 2026).
//
// Justin: "if we can add a function so we can hover over it on the web app
// with the mouse, it brings up all the job's details, so we don't have to
// click into the job. We can just at a glance see the full address and
// everything." The card (components/schedule/booking-hover-card.tsx) only
// draws what this returns. Pure — no React, no I/O; tested in
// tests/unit/schedule-hover.test.ts.
//
// NO MONEY, ever: everything here is names, addresses, times, hours and
// free text the board already holds for the viewer. There is no field for a
// PO value, an amount or a rate, and none may be added (HANDOVER §2).
import { isMissed, missedDetailText, NOT_ATTENDED } from "./booking-attendance";
import { billingName, attentionName } from "@/lib/customer-billing";
import { formatTime } from "@/lib/date";
import { formatDateKeyRange } from "@/lib/schedule-form";
import type { ScheduleDay } from "@/lib/scheduling";
import { dayOfLabel, type BoardBooking, type BoardEntry, type BoardJob } from "@/components/schedule/board-model";

/** How much of the job's description the card shows. */
export const HOVER_DESCRIPTION_MAX = 280;
/** Server-side cap on the description and site notes sent to the board at all. */
export const BOARD_TEXT_MAX = 600;

/** `text` cut to `max` characters at a word where possible, with "…"; null when empty. */
export function trimText(text: string | null | undefined, max: number): string | null {
  // Line breaks are kept (site notes are labelled lines: "Contact: …", "Access: …").
  const t = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type SiteLike = NonNullable<BoardJob["sites"]>;

/**
 * The site's full address as lines: street, second line, "Suburb STATE
 * postcode". The site's name leads when it says something the street
 * doesn't (e.g. "Lot 12"). Empty parts are left out.
 */
export function siteAddressLines(site: SiteLike | null | undefined): string[] {
  if (!site) return [];
  const clean = (v: string | null | undefined) => (v ?? "").trim();
  const street = clean(site.address_line1);
  const name = clean(site.name);
  const lines: string[] = [];
  if (name && name.toLowerCase() !== street.toLowerCase() && !street.toLowerCase().includes(name.toLowerCase())) lines.push(name);
  if (street) lines.push(street);
  if (clean(site.address_line2)) lines.push(clean(site.address_line2));
  const locality = [clean(site.suburb), clean(site.state), clean(site.postcode)].filter(Boolean).join(" ");
  if (locality) lines.push(locality);
  return lines;
}

/** "07:00 – 15:30" for a day block; just the start for a start-only booking. */
export function dayTimeLabel(day: Pick<ScheduleDay, "startIso" | "endIso">): string {
  return day.endIso === day.startIso ? formatTime(day.startIso) : `${formatTime(day.startIso)} – ${formatTime(day.endIso)}`;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  on_hold: "On hold",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

export type HoverCrewLine = { name: string; time: string; costCentre: string | null };

export type HoverCardDetails = {
  heading: string;
  status: string;
  priority: string | null;
  customer: string | null;
  attention: string | null;
  address: string[];
  siteNotes: string | null;
  technician: string;
  /** "Tue 25 Nov · 07:00 – 15:30". */
  when: string;
  /** "Day 2 of 3 · Mon 24 – Wed 26 Nov" for a multi-day booking; null otherwise. */
  span: string | null;
  costCentre: string | null;
  note: string | null;
  /** Everyone else booked on the job that day, with their hours. */
  crew: HoverCrewLine[];
  description: string | null;
  /** "Didn't make it — Other: truck broke down" (0121 (draft)) or "Not attended" (office/admin only); null otherwise. */
  attendance: string | null;
};

/**
 * The card's content for one placed booking. `jobBookings` is every booking
 * on the job the board holds; `bookingDays` each booking's booked days (the
 * board's own map, so a resize preview is honoured); `nameOf` the board's
 * staff names.
 */
export function hoverCardDetails(
  entry: Pick<BoardEntry, "job" | "booking" | "day" | "dayNumber" | "dayCount">,
  jobBookings: readonly BoardBooking[],
  bookingDays: ReadonlyMap<string, readonly ScheduleDay[]>,
  nameOf: (staffId: string | null) => string,
): HoverCardDetails {
  const { job, booking, day } = entry;
  const days = bookingDays.get(booking.id) ?? [];
  const dayOf = dayOfLabel(entry);
  const span =
    dayOf && days.length > 1 ? `${dayOf} · ${formatDateKeyRange(days[0].dateKey, days[days.length - 1].dateKey)}` : null;

  const crew: HoverCrewLine[] = [];
  for (const b of jobBookings) {
    if (b.id === booking.id) continue;
    const theirs = (bookingDays.get(b.id) ?? []).find((d) => d.dateKey === day.dateKey);
    if (!theirs) continue;
    crew.push({ name: nameOf(b.staff_id), time: dayTimeLabel(theirs), costCentre: b.cost_center_name ?? null });
  }
  crew.sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));

  const priority = (job.priority ?? "").trim();
  return {
    heading: `#${job.job_number} — ${job.title}`,
    status: statusLabel(job.status),
    priority: priority && priority !== "normal" ? priority[0].toUpperCase() + priority.slice(1) : null,
    customer: billingName(job.customers) || null,
    attention: attentionName(job.customers),
    address: siteAddressLines(job.sites),
    siteNotes: trimText(job.sites?.notes, HOVER_DESCRIPTION_MAX),
    technician: nameOf(booking.staff_id),
    when: `${formatDateKeyRange(day.dateKey, day.dateKey)} · ${dayTimeLabel(day)}`,
    span,
    costCentre: booking.cost_center_name ?? null,
    note: (booking.note ?? "").trim() || null,
    crew,
    description: trimText(job.description, HOVER_DESCRIPTION_MAX),
    attendance: isMissed(booking) ? missedDetailText(booking) : booking.not_attended ? `${NOT_ATTENDED} — nobody clocked on to the job on its day` : null,
  };
}

/**
 * The extra job text the board may hold for a viewer. A technician sees the
 * description and site notes only on jobs they're on (lead or crew) — the
 * board draws only those jobs' bookings for them anyway (0107), so this keeps
 * the page from sending other jobs' text to their browser at all.
 */
export function boardTextForViewer<J extends Pick<BoardJob, "assigned_to" | "crew" | "description" | "sites">>(
  job: J,
  viewer: { role: string | null; id: string | null },
): J {
  const office = viewer.role === "office" || viewer.role === "admin";
  const onJob = !!viewer.id && (job.assigned_to === viewer.id || job.crew.includes(viewer.id));
  if (office || onJob) {
    return {
      ...job,
      description: trimText(job.description, BOARD_TEXT_MAX),
      sites: job.sites ? { ...job.sites, notes: trimText(job.sites.notes, BOARD_TEXT_MAX) } : job.sites,
    };
  }
  return { ...job, description: null, sites: job.sites ? { ...job.sites, notes: null } : job.sites };
}

/** How long the mouse rests on a booking before its card opens. */
export const HOVER_OPEN_MS = 350;
/** Grace for moving the mouse from the booking onto its card (to click "Open job"). */
export const HOVER_CLOSE_MS = 150;

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Where the card goes: beside the booking (right, else left), its top level
 * with the booking's; when neither side has room, below (else above) it.
 * Always inside the viewport, `margin` from its edges.
 */
export function hoverCardPlacement(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
  gap = 8,
): { x: number; y: number } {
  const clampX = (x: number) => Math.min(Math.max(margin, x), Math.max(margin, viewport.width - size.width - margin));
  const clampY = (y: number) => Math.min(Math.max(margin, y), Math.max(margin, viewport.height - size.height - margin));
  if (anchor.right + gap + size.width + margin <= viewport.width) return { x: anchor.right + gap, y: clampY(anchor.top) };
  if (anchor.left - gap - size.width >= margin) return { x: anchor.left - gap - size.width, y: clampY(anchor.top) };
  const below = anchor.bottom + gap;
  const y = below + size.height + margin <= viewport.height ? below : anchor.top - gap - size.height;
  return { x: clampX(anchor.left), y: clampY(y) };
}
