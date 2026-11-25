import { isAddedByTechnician, withRunningEnds } from "../../lib/selfStartBooking";
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
import { businessDayLabel, formatBusinessTime, computeRescheduleWithTime, dateKeyInBusinessTZ, localDateKey, toBusinessInputValue, shiftDateKey } from "../../lib/date";
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
import { copyDayChoices, planBookingCopy } from "../../lib/bookingCopy";
// Staff leave (migration 0112 — a draft, not applied yet), read online only:
// read-only blocks on the grid, "Needs reassigning" on bookings that sit on a
// leave day, and a warning before a move puts someone on their leave.
import { listScheduleLeave } from "../../lib/data/reads/leave";
import {
  bookingLeaveConflicts,
  bookingsNeedingReassignment,
  buildLeaveIndex,
  describeLeaveConflicts,
  leaveDayLabel,
  leaveLabel,
  leaveRangeLabel,
  NEEDS_REASSIGNING,
  type LeaveDay,
  type ScheduleLeave,
} from "../../lib/staffLeave";
// The office to-do list (Justin, 19 Nov 2026 — the web board's panel, on the
// phone): a sheet of listed jobs, tap-to-place onto a technician's day, a
// booking's "Back to to-do list", and each technician's free hours. Rules are
// the web's, mirrored (lib/todoBoard.ts, lib/todoList.ts).
import { TodoSheet } from "../../components/schedule/TodoSheet";
import { ScheduleExistingSheet } from "../../components/schedule/ScheduleExistingSheet";
import type { SchedulableJob } from "../../lib/data/reads/scheduleSearch";
import { PlaceTodoSheet, type PlaceRequest } from "../../components/schedule/PlaceTodoSheet";
import { listTodoJobs, type TodoCandidate, type TodoJob } from "../../lib/data/reads/todo";
import { describeDragOut, jobPatchAfterDrop, newBookingClashes, planDragOut, planTodoDrop, unbookedHours } from "../../lib/todoBoard";
import { todoHours } from "../../lib/todoList";
import { closedJobScheduleMessage, isJobClosedForScheduling } from "../../lib/jobSchedulable";
import { crewJoinWindow, crewLeaveConflicts, describeCrewLeave } from "../../lib/crewLeave";
import { useIsAdmin, useIsOfficeOrAdmin } from "../../design/guards/useRole";
// "Over allowed hours" (Justin, 24 Nov 2026 — the web board has it too): a tag
// on each booking whose job or cost centre has used more hours than its POs
// allow, and a count above the grid. Hours only; office/admin only.
import { bookingOverHours, formatOverHours, jobsOverHours, overHoursHeadline, type HoursByJob } from "../../lib/overHours";
import { listJobHours } from "../../lib/data/reads/overHours";
import { readAllPages } from "../../lib/data/reads/pagedRows";

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
  /** From select("*") — carried back onto the to-do list when a job's last booking goes. */
  priority?: string | null;
  estimated_hours?: number | null;
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
  // Two months back to ten ahead, refreshed with the schedule. [] offline or
  // before 0112 — the schedule then shows no leave, nothing else changes.
  const [leave, setLeave] = useState<ScheduleLeave[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [menuItem, setMenuItem] = useState<SchedItem | null>(null);
  // The day the menu was opened from (a grid block's day / a list row's day):
  // "Copy to…" copies from there, as a Shift-drop does on the web board.
  const [menuDayKey, setMenuDayKey] = useState<string | null>(null);
  const [copyFrom, setCopyFrom] = useState<{ item: SchedItem; sourceKey: string } | null>(null);
  const [copyStaff, setCopyStaff] = useState<string | null>(null);
  const [copyDay, setCopyDay] = useState<string>(() => businessTodayKey());
  const isAdmin = useIsAdmin();
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

  // ---- the to-do list (office/admin) ---------------------------------------
  // The (office) group only mounts for office/admin; checked again here so a
  // stale role never shows the list or its writes (RLS is the backstop).
  const canTodo = useIsOfficeOrAdmin();
  // null until the first read lands; online only, like the rest of this tab.
  const [todoJobs, setTodoJobs] = useState<TodoJob[] | null>(null);
  const [todoError, setTodoError] = useState<string | null>(null);
  const [todoOpen, setTodoOpen] = useState(false);
  const [gapInput, setGapInput] = useState("");
  // A to-do job picked to place: the next tap on the grid books it.
  const [placing, setPlacing] = useState<TodoJob | null>(null);
  // "Schedule an existing job" (20 Nov 2026): the search sheet, then the job
  // picked — the next tap on the grid names the technician and day its
  // Schedule Job sheet opens with ("Skip" opens it without them).
  const [existingOpen, setExistingOpen] = useState(false);
  const [placingExisting, setPlacingExisting] = useState<SchedulableJob | null>(null);
  const openExistingJob = useCallback(
    (job: SchedulableJob, target: BoardCell | null) => {
      setPlacingExisting(null);
      const params: Record<string, string> = { id: job.id, schedule: "1" };
      if (target?.staffId) params.tech = target.staffId;
      if (target?.dateKey) params.day = target.dateKey;
      router.push({ pathname: "/job/[id]", params });
    },
    [router]
  );
  // The place confirm, waiting for its cost centre (every booking asks — 19 Nov 2026).
  const [placeAsk, setPlaceAsk] = useState<(PlaceRequest & { job: TodoJob; insert: ReturnType<typeof planTodoDrop>; target: BoardCell }) | null>(null);
  // The crew as it was when the picker opened — only people ADDED are asked about leave.
  const [crewBefore, setCrewBefore] = useState<string[]>([]);

  const loadTodo = useCallback(async () => {
    if (!canTodo) return;
    try {
      setTodoJobs(await listTodoJobs());
      setTodoError(null);
    } catch (e) {
      console.warn("[schedule] to-do list unavailable:", e);
      setTodoError("Couldn't load the to-do list — it needs signal.");
    }
  }, [canTodo]);

  // Unwrapped rather than defaulted to []: this list's empty state is "Nothing
  // scheduled.", which an office user reads as the day being clear. A failed
  // read that renders it sends nobody to site.
  const load = useCallback(async () => {
    try {
      setError(null);
      // Paged: PostgREST answers at most 1000 rows a request and says nothing,
      // so past 1000 open jobs one request silently dropped some (24 Nov 2026).
      const res = await readAllPages((from, to) =>
        supabase
          .from("jobs")
          .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
          .not("scheduled_start", "is", null)
          .not("status", "in", '("completed","cancelled")')
          .order("scheduled_start")
          .order("id")
          .range(from, to)
      );
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
    const today = businessTodayKey();
    const leaveRes = await listScheduleLeave(shiftDateKey(today, -60), shiftDateKey(today, 300));
    // A failed read keeps what was shown (offline after an earlier load).
    if (leaveRes.available) setLeave(leaveRes.leave);
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

  useEffect(() => {
    void loadTodo();
  }, [loadTodo]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), loadTodo()]);
    setRefreshing(false);
  }, [load, loadTodo]);

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
      const res = await readAllPages((first, last) =>
        supabase
          .from("jobs")
          .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
          .eq("status", "completed")
          .lt("scheduled_start", to)
          .or(`scheduled_end.gte.${from},and(scheduled_end.is.null,scheduled_start.gte.${from})`)
          .order("scheduled_start")
          .order("id")
          .range(first, last)
      );
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
    await Promise.all([load(), loadDone(), loadTodo()]);
    setRefreshing(false);
  }, [load, loadDone, loadTodo]);

  const allJobs = useMemo(() => {
    const byId = new Map<string, SchedJob>();
    for (const j of doneJobs) byId.set(j.id, j);
    for (const j of jobs) byId.set(j.id, j); // the open read wins if both have it
    return byId;
  }, [jobs, doneJobs]);
  const jobsById = useMemo(() => new Map([...allJobs.values()].map((j) => [j.id, toBoardJob(j)])), [allJobs]);

  // Used vs allowed hours for every job on screen (open, and completed in the
  // period) — office/admin, online, best-effort: null shows no tags.
  const [overHours, setOverHours] = useState<HoursByJob | null>(null);
  const overJobIds = useMemo(() => [...allJobs.keys()].sort().join(","), [allJobs]);
  useEffect(() => {
    if (!canTodo || !overJobIds) {
      setOverHours(null);
      return;
    }
    let live = true;
    void listJobHours(overJobIds.split(",")).then((h) => {
      if (live) setOverHours(h);
    });
    return () => {
      live = false;
    };
  }, [canTodo, overJobIds]);
  const overJobs = useMemo(() => {
    if (!overHours) return [];
    return jobsOverHours([...allJobs.keys()], overHours).flatMap(({ jobId, items }) => {
      const job = allJobs.get(jobId);
      return job ? [{ job, items }] : [];
    });
  }, [overHours, allJobs]);
  const [overOpen, setOverOpen] = useState(false);

  // Every booking on the grid: the real ones, plus a read-only stand-in for
  // any job without bookings (job_bookings missing, or a read that failed).
  const realBookings = useMemo<(JobBooking & Pick<BoardBooking, "added_by_technician" | "running">)[]>(() => {
    const seen = new Set<string>();
    const out: JobBooking[] = [];
    for (const b of [...(bookings ?? []), ...(doneBookings ?? [])]) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
    // "Added by technician" (25 Nov 2026, 0118 (draft)): a technician who started
    // work booked themselves. Still clocked on = no end yet; drawn running
    // to now (at least 15:30, never past its day — lib/selfStartBooking.ts).
    const roles = new Map(staff.map((s) => [s.id, s.role]));
    const roleOf = (id: string) => roles.get(id) ?? null;
    return withRunningEnds(out, roleOf, Date.now()).map((b) => ({ ...b, added_by_technician: isAddedByTechnician(b, roleOf) }));
  }, [bookings, doneBookings, staff]);
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
  const leaveIndex = useMemo(() => buildLeaveIndex(leave, dayKeys), [leave, dayKeys]);
  // Bookings on their technician's leave day, from today on.
  // A completed job's bookings are history: never "Needs reassigning" (as the web board).
  const reassign = useMemo(
    () => bookingsNeedingReassignment(realBookings.filter((b) => allJobs.get(b.job_id)?.status !== "completed"), leave, todayKey),
    [realBookings, allJobs, leave, todayKey]
  );
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
      // A move or stretch onto someone's leave day is asked about, never silent.
      const leaveHits = bookingLeaveConflicts(after, leave, todayKey);
      const leaveText = leaveHits.length > 0 ? `\n\n⚠ ${describeLeaveConflicts(nameOf(after.staff_id), leaveHits)}` : "";
      const warned = clashes.length > 0 || leaveHits.length > 0;
      Alert.alert(`#${job.job_number} — ${job.title}`, `${what.charAt(0).toUpperCase()}${what.slice(1)}?${leaveText}${clashText}`, [
        { text: "Cancel", style: "cancel" },
        { text: warned ? "Book anyway" : "Save", onPress: () => void commitBookingChange(before, after, what) },
      ]);
    },
    [boardBookings, nameOf, jobsById, commitBookingChange, leave, todayKey]
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
      setMenuDayKey(entry.day.dateKey);
      setMenuItem(itemForEntry(job, real));
    },
    [allJobs, realBookings, bookingsByJob, bookingDays, nameOf]
  );

  const onGridBlocked = useCallback((message: string) => Alert.alert("Can't move this", message), []);

  // A leave block: its details, read-only (the record is entered on the
  // website — Staff → Cost & Leave — or imported from Xero Payroll).
  const onOpenLeave = useCallback(
    (day: LeaveDay) => {
      const affected = realBookings.filter((b) => reassign.get(b.id)?.some((c) => c.leaveDay.leave === day.leave));
      const jobsText = affected.length
        ? `\n\n${NEEDS_REASSIGNING}: ${affected.map((b) => `#${allJobs.get(b.job_id)?.job_number ?? "?"}`).join(", ")}`
        : "";
      // Admin, and only when the read gave the record's id (schedule_leave()
      // returns it to an admin alone): open that person's Leave Log in Staff.
      const canOpen = isAdmin && !!day.leave.id;
      Alert.alert(
        `${nameOf(day.leave.staff_id)} — ${leaveLabel(day.leave.leave_type)}`,
        `${leaveRangeLabel(day.leave)}\nThis day: ${leaveDayLabel(day)}${jobsText}\n\n${canOpen ? "Leave is changed in Staff → the person → Leave log, or imported from Xero." : "Read only. Leave is entered on the website (Staff → Cost & Leave) or imported from Xero."}`,
        canOpen
          ? [
              { text: "Close", style: "cancel" },
              { text: "Open leave record", onPress: () => router.push({ pathname: "/staff", params: { staff: day.leave.staff_id } }) },
            ]
          : undefined,
      );
    },
    [realBookings, reassign, allJobs, nameOf, isAdmin, router]
  );

  // ---- Copy to… (the web board's Shift-drop) ---------------------------------
  const openCopy = useCallback((item: SchedItem, sourceKey: string) => {
    setCopyFrom({ item, sourceKey });
    setCopyStaff(null);
    setCopyDay(sourceKey >= businessTodayKey() ? sourceKey : businessTodayKey());
  }, []);

  /** Queue the copy through the outbox (ScheduleRepository.addBookings) and say what the server did. */
  const commitCopy = useCallback(
    async (jobId: string, plan: Extract<ReturnType<typeof planBookingCopy>, { ok: true }>, what: string) => {
      if (!schedule.ready) {
        Alert.alert("Not ready yet", "The app is still starting up. Try again in a moment.");
        return;
      }
      showNotice({ tone: "wait", text: `Saving: ${what}…` });
      try {
        const { ids } = await schedule.addBookings(jobId, [plan.staffId], plan.columns, plan.costCenterId, plan.note);
        const id = ids[0];
        // Drawn at once; the server's copy replaces it on the next load.
        setBookings((cur) => [...(cur ?? []), { ...plan.after, id, staff_name: staffNames.get(plan.staffId) ?? null }]);
        const outcome = await writeOutcome(id);
        if (outcome === "settled") {
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
        showNotice({ tone: "bad", text: `Couldn't save: ${e instanceof Error ? e.message : "please try again."}` });
      }
    },
    [schedule, showNotice, staffNames, writeOutcome, load, setSaveState]
  );

  const onCopy = useCallback(() => {
    if (!copyFrom || !copyFrom.item.booking) return;
    const { item, sourceKey } = copyFrom;
    const job = jobsById.get(item.job.id) ?? toBoardJob(item.job);
    const plan = planBookingCopy(item.job, item.booking as BoardBooking, sourceKey, { staffId: copyStaff, dateKey: copyDay }, bookingsByJob.get(item.job.id) ?? [], copyStaff ? nameOf(copyStaff) : undefined);
    if (!plan.ok) {
      Alert.alert("Can't copy this", plan.reason);
      return;
    }
    const days = scheduleDays(bookingWindow(plan.after));
    const span = days.length > 1 ? dateRangeLabel(days[0].dateKey, days[days.length - 1].dateKey) : shortDayLabel(days[0]?.dateKey ?? copyDay);
    const what = `book ${nameOf(plan.staffId)} on #${job.job_number} ${span} too`;
    // Same warnings as a move (confirmChange): a clash or leave asks, never blocks.
    const clashes = bookingClashes(plan.after, boardBookings);
    const clashText =
      clashes.length > 0
        ? `\n\n⚠ ${nameOf(plan.staffId)} is already booked then: ${clashes
            .slice(0, 3)
            .map((c) => `#${jobsById.get(c.booking.job_id)?.job_number ?? "?"} on ${shortDayLabel(c.dateKey)}`)
            .join(", ")}${clashes.length > 3 ? ` and ${clashes.length - 3} more` : ""}.`
        : "";
    const leaveHits = bookingLeaveConflicts(plan.after, leave, todayKey);
    const leaveText = leaveHits.length > 0 ? `\n\n⚠ ${describeLeaveConflicts(nameOf(plan.staffId), leaveHits)}` : "";
    const warned = clashes.length > 0 || leaveHits.length > 0;
    setCopyFrom(null);
    Alert.alert(`#${job.job_number} — ${job.title}`, `${what.charAt(0).toUpperCase()}${what.slice(1)}? Same hours, cost centre and note.${leaveText}${clashText}`, [
      { text: "Cancel", style: "cancel" },
      { text: warned ? "Book anyway" : "Copy", onPress: () => void commitCopy(item.job.id, plan, what) },
    ]);
  }, [copyFrom, copyStaff, copyDay, jobsById, bookingsByJob, nameOf, boardBookings, leave, todayKey, commitCopy]);

  // ---- the to-do list ---------------------------------------------------------

  /** A technician's free hours on a day — the web board's "3 h free" (office/admin only). */
  const gapFor = useCallback(
    (staffId: string, dateKey: string) =>
      unbookedHours({
        dateKey,
        todayKey,
        bookedHours: board.hours.get(staffId)?.get(dateKey) ?? 0,
        leaveDays: leaveIndex.get(staffId)?.get(dateKey) ?? [],
      }),
    [board, leaveIndex, todayKey]
  );

  /** A gap was tapped: the to-do jobs that fit it. */
  const onGapPress = useCallback((hours: number) => {
    setGapInput(String(hours));
    setTodoOpen(true);
  }, []);

  /** "Place": close the sheet and wait for a tap on the grid. */
  const pickToPlace = useCallback(
    (job: TodoJob) => {
      setTodoOpen(false);
      setPlacing(job);
      setPlacingExisting(null);
      if (view === "list") setView("day");
    },
    [view]
  );

  /** Queue the booking and the job patch, then report what the server did (as a move does). */
  const commitPlace = useCallback(
    async (job: TodoJob, insert: ReturnType<typeof planTodoDrop>, target: BoardCell) => {
      if (!schedule.ready) {
        Alert.alert("Not ready yet", "The app is still starting up. Try again in a moment.");
        return;
      }
      const patch = jobPatchAfterDrop(job.status);
      const what = `#${job.job_number} for ${nameOf(target.staffId)} on ${shortDayLabel(target.dateKey)}`;
      showNotice({ tone: "wait", text: `Booking ${what}…` });
      let id: string;
      try {
        ({ id } = await schedule.placeTodo(insert, patch));
      } catch (e) {
        showNotice({ tone: "bad", text: `Couldn't book ${what}: ${e instanceof Error ? e.message : "please try again."}` });
        return;
      }
      // Drawn at once, tagged until the server has it; off the to-do list.
      setTodoJobs((cur) => (cur ? cur.filter((j) => j.id !== job.id) : cur));
      setBookings((cur) => (cur ? [...cur, { ...insert, id, staff_name: target.staffId ? staffNames.get(target.staffId) ?? null : null }] : cur));
      setJobs((cur) =>
        cur.some((j) => j.id === job.id)
          ? cur.map((j) => (j.id === job.id && patch.status ? { ...j, status: patch.status } : j))
          : [
              ...cur,
              {
                id: job.id,
                job_number: job.job_number,
                title: job.title,
                status: patch.status ?? job.status,
                scheduled_start: insert.starts_at,
                scheduled_end: insert.ends_at,
                schedule_daily: insert.daily,
                schedule_all_day: insert.all_day,
                assigned_to: target.staffId,
                customers: job.customer_name ? { name: job.customer_name } : null,
                priority: job.priority,
                estimated_hours: job.estimated_hours,
              },
            ]
      );
      const outcome = await writeOutcome(id);
      if (outcome === "settled") {
        showNotice({ tone: "ok", text: `Booked ${what}.` });
        void load();
        void loadTodo();
      } else if (outcome === "pending") {
        setSaveState(id, "queued");
        showNotice({ tone: "wait", text: `Not on the server yet: ${what}. It is kept on this phone and sends when you're back online.` });
      } else {
        setSaveState(id, "failed");
        showNotice({ tone: "bad", text: `The server hasn't accepted ${what}. It will retry — check the sync badge.` });
      }
    },
    [schedule, nameOf, showNotice, staffNames, writeOutcome, load, loadTodo, setSaveState]
  );

  /**
   * A tap on the grid while placing: the web's drop-in. One booking
   * (planTodoDrop), the same guards as every board write — closed jobs and a
   * database without bookings refused — and always a confirm (a tap lands
   * more easily on the wrong cell than a drag), which says when the
   * technician is already booked or on leave then.
   */
  const onPlace = useCallback(
    (target: BoardCell) => {
      if (placingExisting) {
        openExistingJob(placingExisting, target);
        return;
      }
      const job = placing;
      setPlacing(null);
      if (!job) return;
      if (bookings === null) {
        Alert.alert("Can't place it here", "Bookings aren't set up on this database yet — schedule the job from the website.");
        return;
      }
      if (isJobClosedForScheduling(job.status)) {
        Alert.alert("Can't schedule this", closedJobScheduleMessage(job.status));
        return;
      }
      const estimate = todoHours(job.estimated_hours, job.po_allocated_hours).hours;
      const dayBlocks = target.staffId
        ? realBookings.filter((b) => b.staff_id === target.staffId).flatMap((b) => bookingDays.get(b.id) ?? [])
        : [];
      const insert = planTodoDrop({ jobId: job.id, staffId: target.staffId, dateKey: target.dateKey, estimateHours: estimate, dayBlocks });
      const clashes = newBookingClashes(insert, realBookings);
      const clashText =
        clashes.length > 0
          ? `\n\n⚠ ${nameOf(target.staffId)} is already booked then: ${clashes
              .slice(0, 3)
              .map((c) => `#${allJobs.get(c.job_id)?.job_number ?? "?"}`)
              .join(", ")}${clashes.length > 3 ? ` and ${clashes.length - 3} more` : ""}.`
          : "";
      const leaveHits = target.staffId ? bookingLeaveConflicts(insert, leave, todayKey) : [];
      const leaveText = leaveHits.length > 0 ? `\n\n⚠ ${describeLeaveConflicts(nameOf(target.staffId), leaveHits)}` : "";
      const time = insert.all_day ? "All day" : `${formatBusinessTime(insert.starts_at)}–${insert.ends_at ? formatBusinessTime(insert.ends_at) : ""}`;
      const warned = clashes.length > 0 || leaveHits.length > 0;
      // A sheet, not an alert: it asks for the booking's cost centre too.
      setPlaceAsk({
        jobId: job.id,
        title: `#${job.job_number} — ${job.title}`,
        message: `Book ${target.staffId ? nameOf(target.staffId) : "it unassigned"} on ${shortDayLabel(target.dateKey)}, ${time}?${
          job.status === "pending" ? " The job becomes Scheduled and comes off the to-do list." : " It comes off the to-do list."
        }${leaveText}${clashText}`,
        warned,
        job,
        insert,
        target,
      });
    },
    [placing, placingExisting, openExistingJob, bookings, realBookings, bookingDays, nameOf, allJobs, leave, todayKey]
  );

  /** A booking's "Back to to-do list": the web's drag-out, same rules and words (planDragOut). */
  function backToTodo(item: SchedItem) {
    const { job, booking } = item;
    if (!booking || !schedule.ready) return;
    const plan = planDragOut(booking, realBookings.filter((b) => b.job_id === job.id), job.status);
    if (plan.kind === "refuse") {
      Alert.alert("Can't take this off", plan.reason);
      return;
    }
    const days = scheduleDays(bookingWindow(booking));
    const when = days.length > 1 ? dateRangeLabel(days[0].dateKey, days[days.length - 1].dateKey) : shortDayLabel(days[0]?.dateKey ?? todayKey);
    const words = describeDragOut(plan, { jobNumber: job.job_number, who: booking.staff_id ? nameOf(booking.staff_id) : null, when });
    Alert.alert(words.title, `${job.title}. ${words.detail}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: words.action,
        style: plan.kind === "list" ? "default" : "destructive",
        onPress: async () => {
          try {
            const { synced } = await schedule.backToTodo(job.id, booking.id, plan.kind === "list" ? (plan.status ? { status: plan.status } : {}) : null);
            setBookings((cur) => (cur ? cur.filter((b) => b.id !== booking.id) : cur));
            if (plan.kind === "list") {
              setJobs((cur) => cur.filter((j) => j.id !== job.id));
              setTodoJobs((cur) =>
                cur && !cur.some((j) => j.id === job.id)
                  ? [
                      ...cur,
                      {
                        id: job.id,
                        job_number: job.job_number,
                        title: job.title,
                        priority: job.priority ?? "normal",
                        status: plan.status ?? job.status,
                        todo_listed_at: new Date().toISOString(),
                        estimated_hours: job.estimated_hours ?? null,
                        po_allocated_hours: null,
                        customer_name: job.customers?.name ?? null,
                        suburb: null,
                      },
                    ]
                  : cur
              );
            }
            showNotice(
              synced
                ? { tone: "ok", text: plan.kind === "list" ? `#${job.job_number} is back on the to-do list.` : `#${job.job_number}: booking removed.` }
                : { tone: "wait", text: `Not on the server yet: #${job.job_number} off the schedule. It sends when you're back online.` }
            );
            if (synced) {
              void load();
              void loadTodo();
            }
          } catch (e) {
            showNotice({ tone: "bad", text: `Couldn't change #${job.job_number}: ${e instanceof Error ? e.message : "please try again."}` });
          }
        },
      },
    ]);
  }

  /** "Add job…": list it (with its estimate) through the outbox. */
  const addToTodo = useCallback(
    async (job: TodoCandidate, estimatedHours: number | null) => {
      if (!schedule.ready) throw new Error("The app is still starting up. Try again in a moment.");
      const { synced } = await schedule.listOnTodo(job.id, estimatedHours);
      setTodoJobs((cur) => [
        ...(cur ?? []).filter((j) => j.id !== job.id),
        {
          id: job.id,
          job_number: job.job_number,
          title: job.title,
          priority: job.priority,
          status: job.status,
          todo_listed_at: new Date().toISOString(),
          estimated_hours: estimatedHours,
          po_allocated_hours: null,
          customer_name: job.customer_name,
          suburb: job.suburb,
        },
      ]);
      showNotice(
        synced
          ? { tone: "ok", text: `#${job.job_number} added to the to-do list.` }
          : { tone: "wait", text: `#${job.job_number} goes on the to-do list when you're back online.` }
      );
      if (synced) void loadTodo();
    },
    [schedule, showNotice, loadTodo]
  );

  /** The cross on a to-do row: off the list, nothing else changes. */
  const removeFromTodo = useCallback(
    (job: TodoJob) => {
      Alert.alert(`Take #${job.job_number} off the to-do list?`, job.title, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Take off",
          style: "destructive",
          onPress: async () => {
            if (!schedule.ready) return;
            setTodoJobs((cur) => (cur ? cur.filter((j) => j.id !== job.id) : cur));
            try {
              const { synced } = await schedule.unlistTodo(job.id);
              showNotice(
                synced
                  ? { tone: "ok", text: `#${job.job_number} taken off the to-do list.` }
                  : { tone: "wait", text: `#${job.job_number} comes off the to-do list when you're back online.` }
              );
            } catch (e) {
              setTodoJobs((cur) => (cur && !cur.some((j) => j.id === job.id) ? [...cur, job] : cur));
              showNotice({ tone: "bad", text: `Couldn't take #${job.job_number} off: ${e instanceof Error ? e.message : "please try again."}` });
            }
          },
        },
      ]);
    },
    [schedule, showNotice]
  );

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
    const ahead = Array.from(map, ([dateKey, data]) => ({ title: businessDayLabel(data[0].day.startIso), data, earlier: false, dateKey }));
    const earlier = rows.filter(isPast).reverse();
    return earlier.length > 0
      ? [...ahead, { title: `Earlier — not finished (${earlier.length})`, data: earlier, earlier: true, dateKey: null as string | null }]
      : ahead;
  }, [items]);
  // Who is on leave on each listed day ("Sick: Dave · Unavailable: Sam").
  const listLeave = useMemo(() => {
    const keys = sections.map((sec) => sec.dateKey).filter((k): k is string => !!k);
    const index = buildLeaveIndex(leave, keys);
    const byDay = new Map<string, string>();
    for (const key of keys) {
      const parts: string[] = [];
      for (const [staffId, days] of index) for (const d of days.get(key) ?? []) parts.push(`${leaveDayLabel(d)}: ${nameOf(staffId)}`);
      if (parts.length) byDay.set(key, parts.join(" · "));
    }
    return byDay;
  }, [sections, leave, nameOf]);

  // Jobs are often done in pairs or more (job_assignments, migration 0059).
  // The sheet opens with the job's current crew ticked; tapping toggles a
  // technician, and Save replaces the crew in one write. It used to pick ONE
  // person through assigned_to, which collapsed any existing crew to them.
  function openReassign(job: SchedJob) {
    setReassignJob(job);
    const seed = job.assigned_to ? [job.assigned_to] : [];
    setCrew(seed);
    setCrewBefore(seed);
    supabase
      .from("job_assignments")
      .select("staff_id")
      .eq("job_id", job.id)
      .then(({ data, error: crewError }) => {
        // Offline / failed read: keep the primary-assignee seed above.
        if (!crewError && data) {
          const ids = data.map((r: { staff_id: string }) => r.staff_id);
          setCrew(ids);
          setCrewBefore(ids);
        }
      });
  }

  // Leave on the window a newly added crew member would be booked on (0079
  // books a newcomer on the job's one shared window; none when the bookings
  // differ). Leave is read online only — offline nothing is flagged, as
  // everywhere else on the phone. Labels follow 0112's "who sees the leave
  // type" setting (a withheld type reads "Unavailable").
  const crewLeave = useMemo(() => {
    const out = new Map<string, ReturnType<typeof crewLeaveConflicts>>();
    if (!reassignJob || leave.length === 0) return out;
    const window = crewJoinWindow(bookings === null ? null : realBookings.filter((b) => b.job_id === reassignJob.id), reassignJob);
    for (const s of staff) {
      if (crewBefore.includes(s.id)) continue;
      const hits = crewLeaveConflicts(s.id, window, leave, todayKey);
      if (hits.length > 0) out.set(s.id, hits);
    }
    return out;
  }, [reassignJob, leave, bookings, realBookings, staff, crewBefore, todayKey]);

  function toggleCrew(staffId: string) {
    if (crew.includes(staffId)) {
      setCrew((cur) => cur.filter((id) => id !== staffId));
      return;
    }
    const hits = crewLeave.get(staffId);
    if (!hits) {
      setCrew((cur) => (cur.includes(staffId) ? cur : [...cur, staffId]));
      return;
    }
    Alert.alert("Not available", `${describeCrewLeave(nameOf(staffId), hits)} Book anyway?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Book anyway", onPress: () => setCrew((cur) => (cur.includes(staffId) ? cur : [...cur, staffId])) },
    ]);
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
      {canTodo ? (
        <View style={styles.todoBar}>
          {placingExisting ? (
            <View style={styles.placingBar} accessibilityLiveRegion="polite">
              <Ionicons name="hand-left-outline" size={18} color="#fff" />
              <Text style={styles.placingText} numberOfLines={2}>
                Tap {view === "week" ? "a technician's day" : "a technician"} to schedule #{placingExisting.job_number} {placingExisting.title}
              </Text>
              <TouchableOpacity onPress={() => openExistingJob(placingExisting, null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Schedule it without picking a day">
                <Text style={styles.placingCancel}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setPlacingExisting(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Stop scheduling it">
                <Text style={styles.placingCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : placing ? (
            <View style={styles.placingBar} accessibilityLiveRegion="polite">
              <Ionicons name="hand-left-outline" size={18} color="#fff" />
              <Text style={styles.placingText} numberOfLines={2}>
                Tap {view === "week" ? "a technician's day" : "a technician"} to place #{placing.job_number} {placing.title}
              </Text>
              <TouchableOpacity onPress={() => setPlacing(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Stop placing">
                <Text style={styles.placingCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TouchableOpacity style={styles.todoBtn} onPress={() => setTodoOpen(true)} accessibilityRole="button" accessibilityLabel="Open the to-do list">
                <Ionicons name="list" size={16} color="#4338ca" />
                <Text style={styles.todoBtnText}>To-do ({todoJobs?.length ?? "…"})</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.todoBtn} onPress={() => setExistingOpen(true)} accessibilityRole="button" accessibilityLabel="Schedule an existing job">
                <Ionicons name="calendar-outline" size={16} color="#4338ca" />
                <Text style={styles.todoBtnText}>Schedule existing job</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : null}
      {canTodo && overJobs.length > 0 ? (
        <TouchableOpacity
          style={styles.overBar}
          onPress={() => setOverOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`${overHoursHeadline(overJobs.length)}. Show them.`}
        >
          <Ionicons name="warning-outline" size={16} color="#b45309" />
          <Text style={styles.overBarText}>{overHoursHeadline(overJobs.length)}</Text>
          <Ionicons name="chevron-forward" size={14} color="#b45309" />
        </TouchableOpacity>
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
          leave={leaveIndex}
          reassign={reassign}
          overHours={canTodo ? overHours : null}
          onOpenLeave={onOpenLeave}
          gapFor={canTodo ? gapFor : undefined}
          onGapPress={onGapPress}
          placing={canTodo && (!!placing || !!placingExisting)}
          onPlace={onPlace}
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => `${r.item.job.id}:${r.item.booking?.id ?? "job"}:${r.day.dateKey}`}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={<Text style={styles.empty}>Nothing scheduled.</Text>}
          renderSectionHeader={({ section }) => (
            <View>
              <Text style={styles.dayHead}>{section.title}</Text>
              {section.dateKey && listLeave.get(section.dateKey) ? (
                <Text style={styles.leaveHead}>Off: {listLeave.get(section.dateKey)}</Text>
              ) : null}
            </View>
          )}
          renderItem={({ item: { item, day, index, count }, section }) => (
            <View style={styles.card}>
              <JobListRow
                jobNumber={item.job.job_number}
                title={item.job.title}
                // Rows under "Earlier" have no day heading above them, so they
                // carry their own date.
                subtitle={`${canTodo && overHours && bookingOverHours({ job_id: item.job.id, cost_center_id: item.booking?.cost_center_id ?? null }, overHours) ? "⚠ Over hours · " : ""}${item.booking && reassign.get(item.booking.id)?.some((c) => c.dateKey === day.dateKey) ? `${NEEDS_REASSIGNING} · ` : ""}${section.earlier ? `${businessDayLabel(day.startIso)} · ` : ""}${item.job.customers?.name ?? "—"} · ${item.who ?? "Unassigned"}${count > 1 ? ` · Day ${index + 1} of ${count}` : ""}`}
                status={item.job.status}
                leading={
                  <View style={styles.timeCol}>
                    <Text style={styles.timeStart}>{formatBusinessTime(day.startIso)}</Text>
                    {item.window.scheduled_end ? <Text style={styles.timeEnd}>{formatBusinessTime(day.endIso)}</Text> : null}
                  </View>
                }
                onPress={() => {
                  setMenuNames(null);
                  setMenuDayKey(day.dateKey);
                  setMenuItem(item);
                }}
              />
            </View>
          )}
        />
      )}

      {/* Action menu */}
      <Modal visible={overOpen} transparent animationType="fade" onRequestClose={() => setOverOpen(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOverOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{overHoursHeadline(overJobs.length)}</Text>
            <ScrollView style={styles.overList}>
              {overJobs.map(({ job, items }) => (
                <TouchableOpacity
                  key={job.id}
                  style={styles.overRow}
                  onPress={() => {
                    setOverOpen(false);
                    router.push({ pathname: "/job/[id]", params: { id: job.id } });
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.overRowTitle} numberOfLines={1}>
                    #{job.job_number} — {job.title}
                    {job.status === "completed" ? " · Completed" : ""}
                  </Text>
                  {items.map((item) => (
                    <Text key={`${item.level}:${item.costCenterId ?? ""}`} style={styles.overRowText}>
                      {item.level === "job" ? "Whole job" : item.name ?? "Cost centre"}: {formatOverHours(item.usedHours)} used of {formatOverHours(item.allowedHours)} allowed
                    </Text>
                  ))}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <Action icon="close" label="Close" onPress={() => setOverOpen(false)} />
          </View>
        </TouchableOpacity>
      </Modal>

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
            {menuItem && canTodo && overHours && menuItem.booking
              ? (() => {
                  const over = bookingOverHours(menuItem.booking, overHours);
                  return over ? <Text style={styles.sheetOver}>⚠ {over.text}</Text> : null;
                })()
              : null}
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
                {menuItem?.booking ? (
                  <Action
                    icon="copy-outline"
                    label="Copy to another technician or day"
                    onPress={() => {
                      const item = menuItem;
                      const key = menuDayKey ?? scheduleDays(item.window)[0]?.dateKey ?? businessTodayKey();
                      setMenuItem(null);
                      // After the menu has faded: iOS will not present one modal while another is dismissing.
                      setTimeout(() => openCopy(item, key), 350);
                    }}
                  />
                ) : null}
                {canTodo && menuItem?.booking && bookings !== null ? (
                  <Action
                    icon="return-down-back-outline"
                    label="Back to to-do list"
                    onPress={() => { const item = menuItem; setMenuItem(null); if (item) backToTodo(item); }}
                  />
                ) : null}
              </>
            )}
            <Action icon="open-outline" label="Open job details" onPress={() => { const id = menuItem?.job.id; setMenuItem(null); if (id) router.push(`/job/${id}`); }} />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Copy to… — technician + start day */}
      <Modal visible={!!copyFrom} transparent animationType="slide" onRequestClose={() => setCopyFrom(null)}>
        <View style={styles.overlay}>
          <View style={styles.pickerSheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              Copy #{copyFrom?.item.job.job_number} — {copyFrom?.item.job.title}
            </Text>
            <Text style={styles.sheetSub}>
              {copyFrom?.item.who ?? "Unassigned"}&apos;s booking · same hours, cost centre and note. On another day it starts there.
            </Text>
            <Text style={styles.copyLabel}>Starting</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.copyDays}>
              {(copyFrom ? copyDayChoices(copyFrom.sourceKey, todayKey) : []).map((key) => (
                <TouchableOpacity
                  key={key}
                  style={[styles.copyDay, copyDay === key && styles.copyDayOn]}
                  onPress={() => setCopyDay(key)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: copyDay === key }}
                >
                  <Text style={[styles.copyDayText, copyDay === key && styles.copyDayTextOn]}>{shortDayLabel(key)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <Text style={styles.copyLabel}>Technician</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {staff.map((s) => {
                const on = copyStaff === s.id;
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={styles.staffRow}
                    onPress={() => setCopyStaff(s.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                  >
                    <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? colors.blue600 : colors.slate400} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.staffName}>{s.full_name}</Text>
                      <Text style={styles.staffRole}>{s.role}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={[styles.saveCrewBtn, !copyStaff && styles.copyBtnOff]} onPress={onCopy} disabled={!copyStaff}>
              <Text style={styles.saveCrewText}>{copyStaff ? `Copy to ${nameOf(copyStaff)} · ${shortDayLabel(copyDay)}` : "Pick a technician"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setCopyFrom(null)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
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
                      {crewLeave.has(s.id) ? (
                        <Text style={styles.staffLeave} numberOfLines={2}>
                          ⚠ {describeCrewLeave(s.full_name, crewLeave.get(s.id)!)}
                        </Text>
                      ) : null}
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

      {canTodo ? (
        <TodoSheet
          visible={todoOpen}
          onClose={() => setTodoOpen(false)}
          jobs={todoJobs}
          loadError={todoError}
          onRetry={() => void loadTodo()}
          gapInput={gapInput}
          onGapInput={setGapInput}
          onPlace={pickToPlace}
          onRemove={removeFromTodo}
          onAdd={addToTodo}
        />
      ) : null}

      {canTodo ? (
        <ScheduleExistingSheet
          visible={existingOpen}
          onClose={() => setExistingOpen(false)}
          onPick={(job) => {
            setExistingOpen(false);
            setPlacing(null);
            // The list has no grid to tap: open the job's schedule straight away.
            if (view === "list") openExistingJob(job, null);
            else setPlacingExisting(job);
          }}
        />
      ) : null}

      {canTodo ? (
        <PlaceTodoSheet
          request={placeAsk}
          onCancel={() => setPlaceAsk(null)}
          onBook={(costCentre) => {
            const ask = placeAsk;
            setPlaceAsk(null);
            if (ask) void commitPlace(ask.job, { ...ask.insert, cost_center_id: costCentre.id }, ask.target);
          }}
        />
      ) : null}

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
  sheetOver: { fontSize: 13, color: "#b45309", fontWeight: "700", marginBottom: 6 },
  overBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#fcd34d",
    backgroundColor: "#fffbeb",
  },
  overBarText: { flex: 1, fontSize: 13, fontWeight: "700", color: "#92400e" },
  overList: { maxHeight: 360, marginVertical: 6 },
  overRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  overRowTitle: { fontSize: 14, fontWeight: "700", color: colors.slate700 },
  overRowText: { fontSize: 12, color: "#92400e", marginTop: 2 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  sub: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  leaveHead: { fontSize: 12, fontWeight: "700", color: "#9f1239", paddingHorizontal: 16, paddingBottom: 4 },
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
  staffLeave: { fontSize: 12, color: "#9f1239", fontWeight: "600", marginTop: 2 },
  todoBar: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 12, marginBottom: 6 },
  todoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#c7d2fe",
    backgroundColor: "#eef2ff",
  },
  todoBtnText: { fontSize: 13, fontWeight: "700", color: "#4338ca" },
  placingBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#4f46e5",
  },
  placingText: { flex: 1, fontSize: 13, fontWeight: "600", color: "#fff", lineHeight: 17 },
  placingCancel: { fontSize: 13, fontWeight: "800", color: "#fff" },
  saveCrewBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  saveCrewText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  cancelBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  copyLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 10, marginBottom: 6 },
  copyDays: { gap: 8, paddingBottom: 4 },
  copyDay: { minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  copyDayOn: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  copyDayText: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  copyDayTextOn: { color: "#fff" },
  copyBtnOff: { backgroundColor: colors.slate400 },
});
