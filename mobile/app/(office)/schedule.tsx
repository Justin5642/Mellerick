import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  SectionList,
  StyleSheet,
  RefreshControl,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { JobListRow } from "../../design/components/JobListRow";
import { ScreenError } from "../../design/components/ScreenError";
import { businessDayLabel, formatBusinessTime, computeRescheduleWithTime, dateKeyInBusinessTZ, localDateKey, toBusinessInputValue } from "../../lib/date";
import { businessDayRange, moveSchedule, scheduleDays, type ScheduleDay } from "../../lib/scheduling";
import { businessTodayKey, dateRangeLabel, formatScheduleSummary, shortDayLabel } from "../../lib/scheduleDisplay";
import { useSchedule } from "../../lib/data/hooks/useSchedule";
import { useWriteOutcome } from "../../lib/data/hooks/useWriteOutcome";
import { listAssignableStaff, type AssignableStaff } from "../../lib/data/reads/schedule";
import { unwrapRows } from "../../lib/data/reads/unwrap";
import { listJobBookingsForJobsRemote, listOpenJobBookingsRemote, type JobBooking } from "../../lib/data/reads/bookings";
import { bookingWindow } from "../../lib/bookings";
import {
  applyBoardMove,
  buildBoardIndex,
  daysByBooking,
  planBoardMove,
  totalHours,
  type BoardBooking,
  type BoardCell,
  type BoardEntry,
  type BoardJob,
} from "../../lib/boardModel";
import {
  bookingClashes,
  defaultGridView,
  gridRows,
  legacyBookingsFor,
  moveBlockedReason,
  othersOnJobDay,
  planResize,
  stepDateKey,
  visibleDayKeys,
  type GridView,
} from "../../lib/scheduleGrid";
import { ScheduleGrid, type SaveState } from "../../components/schedule/ScheduleGrid";

interface SchedJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string;
  scheduled_end: string | null;
  /** Migration 0071 — booked on each weekday of its range (lib/scheduling.ts). */
  schedule_daily?: boolean | null;
  schedule_all_day?: boolean | null;
  assigned_to: string | null;
  customers: { name: string } | null;
  profiles?: { full_name: string } | null;
}

/**
 * What a row schedules: one booking (migration 0079), or the whole job where there are no bookings (before 0079, or a job
 * the bookings read could not cover).
 */
interface SchedItem {
  job: SchedJob;
  booking: JobBooking | null;
  /** The booking's window, or the job's. */
  window: { scheduled_start: string; scheduled_end: string | null; schedule_daily: boolean; schedule_all_day: boolean };
  /** "Dave", "Unassigned", or the job's primary assignee for a job-level row. */
  who: string | null;
}

/** One list row: an item on one of its booked days. */
interface SchedRow {
  item: SchedItem;
  day: ScheduleDay;
  index: number;
  count: number;
}

/** One item per booking; a job with no bookings stays one job-level item. */
function scheduleItems(jobs: SchedJob[], bookings: JobBooking[] | null): SchedItem[] {
  const byJob = new Map<string, JobBooking[]>();
  for (const b of bookings ?? []) {
    const list = byJob.get(b.job_id);
    if (list) list.push(b);
    else byJob.set(b.job_id, [b]);
  }
  return jobs.flatMap((job): SchedItem[] => {
    const list = byJob.get(job.id);
    if (!list || list.length === 0) {
      return [
        {
          job,
          booking: null,
          window: {
            scheduled_start: job.scheduled_start,
            scheduled_end: job.scheduled_end,
            schedule_daily: !!job.schedule_daily,
            schedule_all_day: !!job.schedule_all_day,
          },
          who: job.profiles?.full_name ?? null,
        },
      ];
    }
    return list.map((b) => ({ job, booking: b, window: bookingWindow(b), who: b.staff_name ?? (b.staff_id ? null : "Unassigned") }));
  });
}

function toBoardJob(j: SchedJob): BoardJob {
  return {
    id: j.id,
    job_number: j.job_number,
    title: j.title,
    status: j.status,
    scheduled_start: j.scheduled_start,
    scheduled_end: j.scheduled_end,
    schedule_daily: j.schedule_daily ?? null,
    schedule_all_day: j.schedule_all_day ?? null,
    assigned_to: j.assigned_to,
    crew: j.assigned_to ? [j.assigned_to] : [],
    customers: j.customers,
  };
}

/** The menu's item for a grid block: its real booking, or the job-level row for a stand-in. */
function itemForEntry(job: SchedJob, booking: JobBooking | null): SchedItem {
  if (!booking) return scheduleItems([job], null)[0];
  return { job, booking, window: bookingWindow(booking), who: booking.staff_name ?? (booking.staff_id ? null : "Unassigned") };
}

/** ISO without milliseconds, for a PostgREST or() filter value. */
function filterIso(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

type Notice = { tone: "ok" | "wait" | "bad"; text: string };

export default function ScheduleScreen() {
  const router = useRouter();
  const schedule = useSchedule();
  const [jobs, setJobs] = useState<SchedJob[]>([]);
  // NULL before 0079 is applied: one row per job.
  const [bookings, setBookings] = useState<JobBooking[] | null>(null);
  const [staff, setStaff] = useState<AssignableStaff[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [menuItem, setMenuItem] = useState<SchedItem | null>(null);
  const [reassignJob, setReassignJob] = useState<SchedJob | null>(null);
  const [datePickerFor, setDatePickerFor] = useState<SchedItem | null>(null);
  const [timePickerFor, setTimePickerFor] = useState<SchedItem | null>(null);
  const [pendingDate, setPendingDate] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [staffError, setStaffError] = useState<unknown>(null);
  // The crew being edited in the technician picker (ids), seeded from the
  // job's current job_assignments when the sheet opens.
  const [crew, setCrew] = useState<string[]>([]);

  // ---- grid (Day / Week) -----------------------------------------------------
  // Day on a phone, Week on a tablet: the view that is readable without
  // squinting. List is the original day-by-day list, kept for "Earlier — not
  // finished" and for anyone who prefers it.
  const { width } = useWindowDimensions();
  const [view, setView] = useState<GridView>(() => defaultGridView(width));
  const [selectedKey, setSelectedKey] = useState(() => businessTodayKey());
  const todayKey = businessTodayKey();
  // Completed jobs in the period on screen, greyed out on the grid. Open jobs
  // come from `jobs` above (every open scheduled job, any date).
  const [doneJobs, setDoneJobs] = useState<SchedJob[]>([]);
  const [doneBookings, setDoneBookings] = useState<JobBooking[] | null>([]);
  const [menuNames, setMenuNames] = useState<string | null>(null);
  // Per booking: a move/resize on its way to the server, and what became of it.
  const [saveStates, setSaveStates] = useState<Map<string, SaveState>>(new Map());
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeOutcome = useWriteOutcome();

  // Unwrapped rather than defaulted to []: this list's empty state is "Nothing
  // scheduled.", which an office user reads as the day being clear. A failed
  // read that renders it sends nobody to site.
  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await supabase
        .from("jobs")
        .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
        .not("scheduled_start", "is", null)
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start");
      setJobs(unwrapRows(res as never, "ScheduleScreen.load") as unknown as SchedJob[]);
    } catch (e) {
      setError(e);
      return;
    }
    // Bookings split each job into its people's rows. A failure keeps the
    // job-level rows rather than taking the schedule down.
    try {
      setBookings(await listOpenJobBookingsRemote());
    } catch (e) {
      console.warn("[schedule] bookings unavailable; listing jobs:", e);
      setBookings(null);
    }
  }, []);

  // The staff read is kept OUT of `error` on purpose: it only feeds the reassign
  // picker, and taking the whole schedule down because the technician list
  // failed would remove the working half of the screen. It was previously
  // `.catch(() => {})`, which left the picker looking like a business with no
  // technicians, so it now reports itself where those names are missing.
  const loadStaff = useCallback(() => {
    setStaffError(null);
    listAssignableStaff().then(setStaff, (e) => setStaffError(e));
  }, []);

  useEffect(() => {
    void load();
    loadStaff();
  }, [load, loadStaff]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const gridView: "day" | "week" = view === "week" ? "week" : "day";
  const dayKeys = useMemo(() => visibleDayKeys(gridView, selectedKey), [gridView, selectedKey]);
  const rangeFirst = dayKeys[0];
  const rangeLast = dayKeys[dayKeys.length - 1];

  // Completed jobs whose schedule touches the days on screen. Best-effort: a
  // failure leaves them off (the open jobs are what the office acts on)
  // rather than taking the grid down.
  const loadDone = useCallback(async () => {
    if (view === "list") return;
    const from = filterIso(businessDayRange(rangeFirst).dayStartIso);
    const to = filterIso(businessDayRange(rangeLast).dayEndIso);
    try {
      const res = await supabase
        .from("jobs")
        .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
        .eq("status", "completed")
        .lt("scheduled_start", to)
        .or(`scheduled_end.gte.${from},and(scheduled_end.is.null,scheduled_start.gte.${from})`)
        .order("scheduled_start");
      const rows = unwrapRows(res as never, "ScheduleScreen.loadDone") as unknown as SchedJob[];
      setDoneJobs(rows);
      setDoneBookings(await listJobBookingsForJobsRemote(rows.map((j) => j.id)));
    } catch (e) {
      console.warn("[schedule] completed jobs unavailable:", e);
      setDoneJobs([]);
      setDoneBookings([]);
    }
  }, [view, rangeFirst, rangeLast]);

  useEffect(() => {
    void loadDone();
  }, [loadDone]);

  const onGridRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), loadDone()]);
    setRefreshing(false);
  }, [load, loadDone]);

  const allJobs = useMemo(() => {
    const byId = new Map<string, SchedJob>();
    for (const j of doneJobs) byId.set(j.id, j);
    for (const j of jobs) byId.set(j.id, j); // the open read wins if both have it
    return byId;
  }, [jobs, doneJobs]);
  const jobsById = useMemo(() => new Map([...allJobs.values()].map((j) => [j.id, toBoardJob(j)])), [allJobs]);

  // Every booking on the grid: the real ones, plus a read-only stand-in for
  // any job without bookings (job_bookings missing, or a read that failed).
  const realBookings = useMemo<JobBooking[]>(() => {
    const seen = new Set<string>();
    const out: JobBooking[] = [];
    for (const b of [...(bookings ?? []), ...(doneBookings ?? [])]) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
    return out;
  }, [bookings, doneBookings]);
  const boardBookings = useMemo<BoardBooking[]>(() => {
    const openIds = new Set(jobs.map((j) => j.id));
    const open = jobs.map(toBoardJob);
    const done = doneJobs.filter((j) => !openIds.has(j.id)).map(toBoardJob);
    return [
      ...realBookings,
      ...legacyBookingsFor(open, bookings ? realBookings : []),
      ...legacyBookingsFor(done, doneBookings ? realBookings : []),
    ];
  }, [jobs, doneJobs, bookings, doneBookings, realBookings]);
  const bookingDays = useMemo(() => daysByBooking(boardBookings), [boardBookings]);
  const bookingsByJob = useMemo(() => {
    const map = new Map<string, BoardBooking[]>();
    for (const b of boardBookings) {
      const list = map.get(b.job_id);
      if (list) list.push(b);
      else map.set(b.job_id, [b]);
    }
    return map;
  }, [boardBookings]);
  const board = useMemo(() => buildBoardIndex(boardBookings, jobsById, dayKeys, bookingDays), [boardBookings, jobsById, dayKeys, bookingDays]);
  const staffNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const b of realBookings) if (b.staff_id && b.staff_name) names.set(b.staff_id, b.staff_name);
    for (const j of allJobs.values()) if (j.assigned_to && j.profiles?.full_name) names.set(j.assigned_to, j.profiles.full_name);
    for (const s of staff) names.set(s.id, s.full_name);
    return names;
  }, [staff, realBookings, allJobs]);
  const rows = useMemo(() => {
    const periodHours = new Map<string, number>();
    for (const [id, byDay] of board.hours) periodHours.set(id, totalHours(byDay));
    // Technicians always get a row (who is free shows at a glance); office
    // and admin profiles only when they hold a booking in the period.
    const techs = staff.filter((s) => s.role === "technician");
    return gridRows(techs, board.byStaff.keys(), periodHours, staffNames);
  }, [board, staff, staffNames]);

  const showNotice = useCallback((n: Notice) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(n);
    // A confirmed save fades; anything still owed stays until the next notice.
    if (n.tone === "ok") noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    []
  );

  const setSaveState = useCallback((id: string, state: SaveState | null) => {
    setSaveStates((cur) => {
      const next = new Map(cur);
      if (state) next.set(id, state);
      else next.delete(id);
      return next;
    });
  }, []);

  // Moves still waiting for the server (offline, or being retried): look
  // again every few seconds, and say "Saved" only once the server has them.
  useEffect(() => {
    const waiting = [...saveStates].filter(([, st]) => st === "queued" || st === "failed").map(([id]) => id);
    if (waiting.length === 0) return;
    const timer = setInterval(async () => {
      let settled = 0;
      for (const id of waiting) {
        const outcome = await writeOutcome(id);
        if (outcome === "settled") {
          settled++;
          setSaveState(id, null);
        } else if (outcome === "failed") setSaveState(id, "failed");
      }
      if (settled > 0) {
        showNotice({ tone: "ok", text: settled === 1 ? "Saved — the server has the change." : `Saved — the server has ${settled} changes.` });
        void load();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [saveStates, writeOutcome, setSaveState, showNotice, load]);

  /**
   * Queue a booking change through the outbox — the same
   * ScheduleRepository.updateBooking path as "Reschedule this booking" — then
   * report what the SERVER did. "Saved" only once the write has settled
   * there; otherwise the block keeps a "Not synced yet" / "Not saved" tag and
   * the notice says why.
   */
  const commitBookingChange = useCallback(
    async (before: BoardBooking, after: BoardBooking, what: string) => {
      if (!schedule.ready) {
        Alert.alert("Not ready yet", "The app is still starting up. Try again in a moment.");
        return;
      }
      const id = before.id;
      setSaveState(id, "saving");
      showNotice({ tone: "wait", text: `Saving: ${what}…` });
      // Drawn where it is going, tagged "Saving…" until the server answers.
      const place = (b: JobBooking): JobBooking =>
        b.id === id
          ? { ...b, staff_id: after.staff_id, starts_at: after.starts_at, ends_at: after.ends_at, daily: after.daily, all_day: after.all_day, staff_name: after.staff_id ? staffNames.get(after.staff_id) ?? null : null }
          : b;
      const restore = (b: JobBooking): JobBooking =>
        b.id === id ? { ...b, staff_id: before.staff_id, starts_at: before.starts_at, ends_at: before.ends_at, daily: before.daily, all_day: before.all_day } : b;
      setBookings((cur) => (cur ? cur.map(place) : cur));
      try {
        const windowChanged = after.starts_at !== before.starts_at || after.ends_at !== before.ends_at || after.daily !== before.daily;
        await schedule.updateBooking(before.job_id, id, {
          ...(after.staff_id !== before.staff_id ? { staffId: after.staff_id } : {}),
          ...(windowChanged
            ? { columns: { scheduled_start: after.starts_at, scheduled_end: after.ends_at, schedule_daily: after.daily, schedule_all_day: after.all_day } }
            : {}),
        });
        const outcome = await writeOutcome(id);
        if (outcome === "settled") {
          setSaveState(id, null);
          showNotice({ tone: "ok", text: `Saved: ${what}.` });
          void load();
        } else if (outcome === "pending") {
          setSaveState(id, "queued");
          showNotice({ tone: "wait", text: `Not on the server yet: ${what}. It is kept on this phone and sends when you're back online.` });
        } else {
          setSaveState(id, "failed");
          showNotice({ tone: "bad", text: `The server hasn't accepted: ${what}. It will retry — check the sync badge.` });
        }
      } catch (e) {
        // Never queued: put the block back where it was.
        setSaveState(id, null);
        setBookings((cur) => (cur ? cur.map(restore) : cur));
        showNotice({ tone: "bad", text: `Couldn't save: ${e instanceof Error ? e.message : "please try again."}` });
      }
    },
    [schedule, setSaveState, showNotice, staffNames, writeOutcome, load]
  );

  const nameOf = useCallback((staffId: string | null) => (staffId ? staffNames.get(staffId) ?? "Technician" : "Unassigned"), [staffNames]);

  /** Confirm a change, warning when the technician is already booked then. A clash warns; it never blocks. */
  const confirmChange = useCallback(
    (job: BoardJob, before: BoardBooking, after: BoardBooking, what: string) => {
      const clashes = bookingClashes(after, boardBookings);
      const clashText =
        clashes.length > 0
          ? `\n\n⚠ ${nameOf(after.staff_id)} is already booked then: ${clashes
              .slice(0, 3)
              .map((c) => `#${jobsById.get(c.booking.job_id)?.job_number ?? "?"} on ${shortDayLabel(c.dateKey)}`)
              .join(", ")}${clashes.length > 3 ? ` and ${clashes.length - 3} more` : ""}.`
          : "";
      Alert.alert(`#${job.job_number} — ${job.title}`, `${what.charAt(0).toUpperCase()}${what.slice(1)}?${clashText}`, [
        { text: "Cancel", style: "cancel" },
        { text: clashes.length > 0 ? "Book anyway" : "Save", onPress: () => void commitBookingChange(before, after, what) },
      ]);
    },
    [boardBookings, nameOf, jobsById, commitBookingChange]
  );

  const onGridMove = useCallback(
    (entry: BoardEntry, source: BoardCell, target: BoardCell) => {
      const blocked = moveBlockedReason(entry.job, entry.booking);
      if (blocked) {
        Alert.alert("Can't move this", blocked);
        return;
      }
      const patch = planBoardMove(entry.booking, source, target);
      if (!patch) return;
      const after = applyBoardMove(entry.booking, patch);
      const parts: string[] = [];
      if (patch.staff_id !== undefined) {
        parts.push(target.staffId ? `give ${nameOf(source.staffId)}'s booking to ${nameOf(target.staffId)}` : `unassign ${nameOf(source.staffId)}'s booking`);
      }
      if (patch.starts_at) parts.push(`start it on ${shortDayLabel(target.dateKey)}`);
      confirmChange(entry.job, entry.booking, after, parts.join(" and "));
    },
    [confirmChange, nameOf]
  );

  const onGridResize = useCallback(
    (entry: BoardEntry, newEndKey: string) => {
      const blocked = moveBlockedReason(entry.job, entry.booking);
      if (blocked) {
        Alert.alert("Can't change this", blocked);
        return;
      }
      const patch = planResize(entry.booking, newEndKey);
      if (!patch) return;
      const after: BoardBooking = { ...entry.booking, ends_at: patch.ends_at ?? entry.booking.ends_at, daily: patch.daily ?? entry.booking.daily };
      const days = scheduleDays(bookingWindow(after));
      const span = days.length ? dateRangeLabel(days[0].dateKey, days[days.length - 1].dateKey) : shortDayLabel(newEndKey);
      confirmChange(entry.job, entry.booking, after, `book ${nameOf(entry.booking.staff_id)} ${span} (${days.length} day${days.length === 1 ? "" : "s"})`);
    },
    [confirmChange, nameOf]
  );

  const onGridOpen = useCallback(
    (entry: BoardEntry) => {
      const job = allJobs.get(entry.job.id);
      if (!job) return;
      const real = realBookings.find((b) => b.id === entry.booking.id) ?? null;
      const others = othersOnJobDay(entry, bookingsByJob.get(entry.job.id) ?? [], bookingDays);
      const names = [nameOf(entry.booking.staff_id), ...others.map(nameOf)];
      setMenuNames(`${shortDayLabel(entry.day.dateKey)}: ${names.join(", ")}`);
      setMenuItem(itemForEntry(job, real));
    },
    [allJobs, realBookings, bookingsByJob, bookingDays, nameOf]
  );

  const onGridBlocked = useCallback((message: string) => Alert.alert("Can't move this", message), []);

  // One row per booked DAY, not per job (migration 0071): a Mon–Wed daily job
  // appears under Monday, Tuesday and Wednesday with that day's hours, and
  // not under the weekend it skips. A single-day job is one row, as before.
  const items = useMemo(() => scheduleItems(jobs, bookings), [jobs, bookings]);

  // ... and, with bookings, one row per booked day of each BOOKING: Dave on
  // Mon–Tue and Sam on Monday morning are separate rows with their own times.
  //
  // Today and what's ahead come first, soonest at the top, so the next job is
  // the first thing on screen. Rows whose time has already ENDED (open jobs
  // left on a past date) used to lead the list, oldest first, and pushed the
  // next job to the bottom (Justin, 19 Oct 2026); they now sit in one
  // "Earlier — not finished" section at the end, most recent first.
  const sections = useMemo(() => {
    const todayKey = businessTodayKey();
    const rows = items
      .flatMap((item) => scheduleDays(item.window).map((day, index, all) => ({ item, day, index, count: all.length })))
      .sort((a, b) => a.day.startIso.localeCompare(b.day.startIso));
    const isPast = (r: SchedRow) => dateKeyInBusinessTZ(r.day.endIso) < todayKey;
    const map = new Map<string, SchedRow[]>();
    for (const r of rows.filter((r) => !isPast(r))) {
      const arr = map.get(r.day.dateKey);
      if (arr) arr.push(r);
      else map.set(r.day.dateKey, [r]);
    }
    const ahead = Array.from(map, ([, data]) => ({ title: businessDayLabel(data[0].day.startIso), data, earlier: false }));
    const earlier = rows.filter(isPast).reverse();
    return earlier.length > 0
      ? [...ahead, { title: `Earlier — not finished (${earlier.length})`, data: earlier, earlier: true }]
      : ahead;
  }, [items]);

  // Jobs are often done in pairs or more (job_assignments, migration 0059).
  // The sheet opens with the job's current crew ticked; tapping toggles a
  // technician, and Save replaces the crew in one write. It used to pick ONE
  // person through assigned_to, which collapsed any existing crew to them.
  function openReassign(job: SchedJob) {
    setReassignJob(job);
    setCrew(job.assigned_to ? [job.assigned_to] : []);
    supabase
      .from("job_assignments")
      .select("staff_id")
      .eq("job_id", job.id)
      .then(({ data, error: crewError }) => {
        // Offline / failed read: keep the primary-assignee seed above.
        if (!crewError && data) setCrew(data.map((r: { staff_id: string }) => r.staff_id));
      });
  }

  function toggleCrew(staffId: string) {
    setCrew((cur) => (cur.includes(staffId) ? cur.filter((id) => id !== staffId) : [...cur, staffId]));
  }

  async function onSaveCrew() {
    const job = reassignJob;
    if (!job || busy || !schedule.ready) return;
    setBusy(true);
    try {
      const { synced } = await schedule.setCrew(job.id, crew);
      // With bookings (0079 yet), the database turns a
      // crew change into booking changes (a removed person's bookings go; an
      // added one gets the shared window if there is one). Re-read once it
      // has landed so the rows show what it decided.
      if (synced && bookings) void load();
      // Optimistic: reflect the change immediately (the outbox syncs in the
      // background — offline, a server reload would show stale data).
      const names = crew.map((id) => staff.find((s) => s.id === id)?.full_name).filter(Boolean).join(", ");
      setJobs((cur) =>
        cur.map((j) => (j.id === job.id ? { ...j, assigned_to: crew[0] ?? null, profiles: crew.length ? { full_name: names } : null } : j))
      );
      setReassignJob(null);
    } catch (e) {
      Alert.alert("Couldn't save the crew", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // `time` is null for a daily job: it moves to start on `dateKey` keeping its
  // daily hours and its NUMBER OF BOOKED DAYS (moveSchedule — a Mon–Wed job
  // moved to Thursday becomes Thu, Fri, Mon). A continuous block takes the
  // picked date and time and keeps its duration, as before.
  async function applyReschedule(item: SchedItem, dateKey: string, time: { hour: number; minute: number } | null) {
    if (!schedule.ready) return;
    const { job, booking, window } = item;
    setBusy(true);
    try {
      let scheduledStartIso: string;
      let scheduledEndIso: string | null;
      if (window.schedule_daily) {
        const moved = moveSchedule(window, dateKey);
        if (!moved) return;
        ({ scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso } = moved);
      } else {
        ({ scheduledStartIso, scheduledEndIso } = computeRescheduleWithTime(
          window.scheduled_start,
          window.scheduled_end,
          dateKey,
          time?.hour ?? 0,
          time?.minute ?? 0
        ));
      }
      // A block moved to a different time of day is no longer the standard
      // "All day" shift; a daily job keeps its hours, so keeps the flag.
      const keptTime = toBusinessInputValue(scheduledStartIso).slice(11) === toBusinessInputValue(window.scheduled_start).slice(11);
      const allDay = window.schedule_all_day && keptTime;
      if (booking) {
        // Only this person's booking moves; the database re-derives the
        // job's overall window from all of them.
        await schedule.updateBooking(job.id, booking.id, {
          columns: { scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso, schedule_daily: window.schedule_daily, schedule_all_day: allDay },
        });
        setBookings((cur) =>
          (cur ?? []).map((b) =>
            b.id === booking.id ? { ...b, starts_at: scheduledStartIso, ends_at: scheduledEndIso, all_day: allDay } : b
          )
        );
        return;
      }
      await schedule.reschedule(job.id, scheduledStartIso, scheduledEndIso, allDay === window.schedule_all_day ? {} : { scheduleAllDay: allDay });
      // Optimistic: update + re-sort by start so it lands in the right day sections.
      setJobs((cur) =>
        cur
          .map((j) =>
            j.id === job.id ? { ...j, scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso, schedule_all_day: allDay } : j
          )
          .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
      );
    } catch (e) {
      Alert.alert("Couldn't reschedule", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // iOS's inline "datetime" mode picks date+time in one control and applies
  // immediately, same as the original date-only picker did -- stays open for
  // continuous scrolling. Android has no combined mode, so the date dialog
  // chains into a second time dialog before anything is applied. A daily job
  // (0071) only picks its new start DATE — its hours and day count move with it.
  function onDatePicked(event: DateTimePickerEvent, selected?: Date) {
    const item = datePickerFor;
    if (Platform.OS === "ios") {
      if (event.type === "set" && selected && item) {
        void applyReschedule(
          item,
          localDateKey(selected),
          item.window.schedule_daily ? null : { hour: selected.getHours(), minute: selected.getMinutes() }
        );
      }
      return;
    }
    setDatePickerFor(null); // Android dialog closes itself
    if (event.type !== "set" || !selected || !item) return;
    if (item.window.schedule_daily) {
      void applyReschedule(item, localDateKey(selected), null);
      return;
    }
    setPendingDate(selected);
    setTimePickerFor(item);
  }

  function onTimePicked(event: DateTimePickerEvent, selected?: Date) {
    const item = timePickerFor;
    const date = pendingDate;
    setTimePickerFor(null);
    setPendingDate(null);
    if (event.type !== "set" || !selected || !item || !date) return;
    void applyReschedule(item, localDateKey(date), { hour: selected.getHours(), minute: selected.getMinutes() });
  }

  // Checked BEFORE the list, so a failed read can never render as "Nothing
  // scheduled." — the two look the same and mean opposite things.
  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenError error={error} onRetry={() => { void load(); }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.h1}>Schedule</Text>
          <View style={styles.segment} accessibilityRole="tablist">
            {(["day", "week", "list"] as const).map((v) => (
              <TouchableOpacity
                key={v}
                style={[styles.segBtn, view === v && styles.segBtnOn]}
                onPress={() => setView(v)}
                accessibilityRole="tab"
                accessibilityState={{ selected: view === v }}
              >
                <Text style={[styles.segText, view === v && styles.segTextOn]}>{v === "day" ? "Day" : v === "week" ? "Week" : "List"}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {view === "list" ? (
          <Text style={styles.sub}>Tap a job to reassign, reschedule or open it</Text>
        ) : (
          <>
            <View style={styles.navRow}>
              <TouchableOpacity style={styles.navBtn} onPress={() => setSelectedKey((k) => stepDateKey(gridView, k, -1))} accessibilityLabel={view === "week" ? "Previous week" : "Previous day"}>
                <Ionicons name="chevron-back" size={20} color={colors.slate700} />
              </TouchableOpacity>
              <Text style={styles.navLabel} numberOfLines={1}>
                {view === "week" ? dateRangeLabel(rangeFirst, rangeLast) : shortDayLabel(selectedKey)}
              </Text>
              <TouchableOpacity style={styles.navBtn} onPress={() => setSelectedKey((k) => stepDateKey(gridView, k, 1))} accessibilityLabel={view === "week" ? "Next week" : "Next day"}>
                <Ionicons name="chevron-forward" size={20} color={colors.slate700} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.todayBtn, dayKeys.includes(todayKey) && styles.todayBtnOff]}
                onPress={() => setSelectedKey(todayKey)}
                disabled={dayKeys.includes(todayKey)}
              >
                <Text style={styles.todayText}>Today</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.sub}>Tap a job for its menu · hold and drag to move it{view === "week" ? " · hold the grip to change its days" : ""}</Text>
          </>
        )}
      </View>
      {notice ? (
        <View style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : notice.tone === "bad" ? styles.noticeBad : styles.noticeWait]} accessibilityLiveRegion="polite">
          <Ionicons
            name={notice.tone === "ok" ? "checkmark-circle" : notice.tone === "bad" ? "alert-circle" : "time-outline"}
            size={16}
            color={notice.tone === "ok" ? colors.green600 : notice.tone === "bad" ? colors.red600 : colors.yellow700}
          />
          <Text style={styles.noticeText}>{notice.text}</Text>
          <TouchableOpacity onPress={() => setNotice(null)} hitSlop={12} accessibilityLabel="Dismiss">
            <Ionicons name="close" size={16} color={colors.slate500} />
          </TouchableOpacity>
        </View>
      ) : null}
      {staffError && view !== "list" ? (
        <TouchableOpacity style={[styles.staffErrorRow, { marginHorizontal: 12, marginBottom: 6 }]} onPress={loadStaff}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.orange700} />
          <Text style={styles.staffErrorText}>Couldn&apos;t load the technician list — only technicians with bookings are shown. Tap to retry.</Text>
        </TouchableOpacity>
      ) : null}
      {view !== "list" ? (
        <ScheduleGrid
          view={gridView}
          dayKeys={dayKeys}
          todayKey={todayKey}
          rows={rows}
          board={board}
          bookingsByJob={bookingsByJob}
          bookingDays={bookingDays}
          staffNames={staffNames}
          saveStates={saveStates}
          refreshing={refreshing}
          onRefresh={onGridRefresh}
          onOpen={onGridOpen}
          onBlocked={onGridBlocked}
          onMove={onGridMove}
          onResize={onGridResize}
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => `${r.item.job.id}:${r.item.booking?.id ?? "job"}:${r.day.dateKey}`}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={<Text style={styles.empty}>Nothing scheduled.</Text>}
          renderSectionHeader={({ section }) => <Text style={styles.dayHead}>{section.title}</Text>}
          renderItem={({ item: { item, day, index, count }, section }) => (
            <View style={styles.card}>
              <JobListRow
                jobNumber={item.job.job_number}
                title={item.job.title}
                // Rows under "Earlier" have no day heading above them, so they
                // carry their own date.
                subtitle={`${section.earlier ? `${businessDayLabel(day.startIso)} · ` : ""}${item.job.customers?.name ?? "—"} · ${item.who ?? "Unassigned"}${count > 1 ? ` · Day ${index + 1} of ${count}` : ""}`}
                status={item.job.status}
                leading={
                  <View style={styles.timeCol}>
                    <Text style={styles.timeStart}>{formatBusinessTime(day.startIso)}</Text>
                    {item.window.scheduled_end ? <Text style={styles.timeEnd}>{formatBusinessTime(day.endIso)}</Text> : null}
                  </View>
                }
                onPress={() => {
                  setMenuNames(null);
                  setMenuItem(item);
                }}
              />
            </View>
          )}
        />
      )}

      {/* Action menu */}
      <Modal visible={!!menuItem} transparent animationType="fade" onRequestClose={() => setMenuItem(null)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setMenuItem(null)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>#{menuItem?.job.job_number} — {menuItem?.job.title}</Text>
            <Text style={styles.sheetSub}>
              {menuItem?.who ?? "Unassigned"}
              {menuItem
                ? ` · ${menuItem.window.schedule_daily ? (formatScheduleSummary(menuItem.window) ?? "") : formatBusinessTime(menuItem.window.scheduled_start)}`
                : ""}
            </Text>
            {/* Everyone on this job that day, full names (the tile shows initials / first names). */}
            {menuNames ? <Text style={styles.sheetNames}>{menuNames}</Text> : null}
            {menuItem && menuItem.job.status === "completed" ? (
              <Text style={styles.sheetDone}>Completed — its schedule can no longer be changed.</Text>
            ) : (
              <>
                <Action icon="person-outline" label="Reassign technician" onPress={() => { if (menuItem) openReassign(menuItem.job); setMenuItem(null); }} />
                <Action
                  icon="calendar-outline"
                  label={menuItem?.booking ? "Reschedule this booking" : "Reschedule"}
                  onPress={() => { setDatePickerFor(menuItem); setMenuItem(null); }}
                />
              </>
            )}
            <Action icon="open-outline" label="Open job details" onPress={() => { const id = menuItem?.job.id; setMenuItem(null); if (id) router.push(`/job/${id}`); }} />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Technician picker */}
      <Modal visible={!!reassignJob} transparent animationType="slide" onRequestClose={() => !busy && setReassignJob(null)}>
        <View style={styles.overlay}>
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHead}>
              <Text style={styles.sheetTitle}>Crew</Text>
              {busy ? <ActivityIndicator color={colors.blue600} /> : null}
            </View>
            {staffError ? (
              <TouchableOpacity style={styles.staffErrorRow} onPress={loadStaff}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.orange700} />
                <Text style={styles.staffErrorText}>Couldn&apos;t load the technician list. Tap to retry.</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.staffRole}>Tap everyone working on this job, then Save.</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {staff.map((s) => {
                const on = crew.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={styles.staffRow}
                    onPress={() => toggleCrew(s.id)}
                    disabled={busy}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                  >
                    <Ionicons name={on ? "checkbox" : "square-outline"} size={20} color={on ? colors.blue600 : colors.slate400} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.staffName}>{s.full_name}</Text>
                      <Text style={styles.staffRole}>{s.role}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.saveCrewBtn} onPress={onSaveCrew} disabled={busy}>
              <Text style={styles.saveCrewText}>
                {crew.length === 0 ? "Save — unassigned" : `Save — ${crew.length} technician${crew.length === 1 ? "" : "s"}`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setReassignJob(null)} disabled={busy}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {datePickerFor && (
        <DateTimePicker
          value={new Date(datePickerFor.window.scheduled_start)}
          mode={Platform.OS === "ios" && !datePickerFor.window.schedule_daily ? "datetime" : "date"}
          onChange={onDatePicked}
        />
      )}
      {timePickerFor && (
        <DateTimePicker value={pendingDate ?? new Date(timePickerFor.window.scheduled_start)} mode="time" onChange={onTimePicked} />
      )}
    </SafeAreaView>
  );
}

function Action({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress}>
      <Ionicons name={icon} size={19} color={colors.slate700} />
      <Text style={styles.actionText}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  segment: { flexDirection: "row", backgroundColor: colors.slate100, borderRadius: 10, padding: 2 },
  segBtn: { minHeight: 36, minWidth: 52, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  segBtnOn: { backgroundColor: colors.card, shadowColor: colors.black, shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segText: { fontSize: 13, fontWeight: "600", color: colors.slate500 },
  segTextOn: { color: colors.slate900 },
  navRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  navBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  navLabel: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: colors.slate900 },
  todayBtn: { height: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 10, backgroundColor: colors.blue600, marginLeft: 4 },
  todayBtnOff: { backgroundColor: colors.slate400 },
  todayText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 12, marginBottom: 6, padding: 10, borderRadius: 10 },
  noticeOk: { backgroundColor: colors.green100 },
  noticeWait: { backgroundColor: colors.yellow100 },
  noticeBad: { backgroundColor: colors.red100 },
  noticeText: { flex: 1, fontSize: 12, color: colors.slate900, lineHeight: 16 },
  sheetNames: { fontSize: 13, color: colors.slate700, marginBottom: 6 },
  sheetDone: { fontSize: 13, color: colors.slate500, paddingVertical: 10 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  sub: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  dayHead: { fontSize: 13, fontWeight: "700", color: colors.slate500, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, textTransform: "uppercase" },
  card: { backgroundColor: colors.card, marginHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden", marginTop: 6 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  timeCol: { width: 52, alignItems: "center" },
  timeStart: { fontSize: 12, fontWeight: "700", color: colors.blue600 },
  timeEnd: { fontSize: 11, color: colors.slate400 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, gap: 4 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  sheetSub: { fontSize: 13, color: colors.slate500, marginBottom: 8 },
  action: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border },
  actionText: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.slate900 },
  pickerSheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  pickerHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  staffRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  staffErrorRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.orange100, borderRadius: 10, padding: 10 },
  staffErrorText: { flex: 1, fontSize: 12, color: colors.orange700, lineHeight: 16 },
  staffName: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  staffRole: { fontSize: 12, color: colors.slate400, textTransform: "capitalize", marginTop: 1 },
  saveCrewBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  saveCrewText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  cancelBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
});
