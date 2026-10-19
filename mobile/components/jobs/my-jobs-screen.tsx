import { useCallback, useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { listMyJobs } from "../../lib/data/reads/jobs";
import { ScreenError } from "../../design/components/ScreenError";
import { openNavigation } from "../../lib/open-external-url";
import { useAuth } from "../../lib/auth-context";
import { useSignOut } from "../../lib/useSignOut";
import { colors, statusColors } from "../../lib/theme";
import { BUSINESS_TIME_ZONE } from "../../lib/date";
import { businessTodayKey, formatScheduleSummary } from "../../lib/scheduleDisplay";
import { listMyJobBookings } from "../../lib/data/reads/bookings";
import { getJobCostCentres } from "../../lib/data/reads/jobBilling";
import { myJobEntries, splitMyJobEntries, type Booking, type MyJobEntry } from "../../lib/bookings";
import type { ScheduledJobWindow } from "../../lib/scheduling";

interface Job {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_daily: boolean;
  customers: { name: string } | null;
  sites: { name: string; address_line1: string; suburb: string; site_lat: number | null; site_lng: number | null } | null;
}

export function MyJobsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  // Warns about unsynced work and clears it on a confirmed sign-out.
  const signOut = useSignOut();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  // Bookings on these jobs (migration 0079 yet). NULL
  // = none exist yet or they could not be read: every card then shows the
  // job's own window, exactly as before bookings.
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  // Cost-centre names for the booking cards. A technician reads them from
  // the server (po_cost_centers is not in their stream — it carries money),
  // so offline the cards simply show no stage name.
  const [stageNames, setStageNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadJobs = useCallback(async () => {
    // listMyJobs now THROWS on a failed query instead of returning [] — an
    // empty list here used to mean "no jobs assigned" whether or not the query
    // worked, and a technician who reads that goes home. Without this catch the
    // throw would skip setLoading(false) and leave a spinner forever, which
    // tells them even less.
    try {
      setError(null);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const data = await listMyJobs(user.id);
      setJobs(data);
      setUserId(user.id);

      // Bookings refine the list; they must never be what empties it. A
      // failure keeps the job-level cards (and says so in the log).
      let read: Booking[] | null = null;
      try {
        read = await listMyJobBookings(user.id, data.map((j) => j.id));
      } catch (e) {
        console.warn("[my-jobs] bookings unavailable; showing job-level times:", e);
      }
      setBookings(read);
      void loadStageNames(read, user.id);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadStageNames = useCallback(async (read: Booking[] | null, me: string) => {
    const jobIds = [...new Set((read ?? []).filter((b) => b.staff_id === me && b.cost_center_id).map((b) => b.job_id))];
    const names: Record<string, string> = {};
    await Promise.all(
      jobIds.map(async (jobId) => {
        try {
          for (const cc of await getJobCostCentres(jobId)) names[cc.id] = cc.name;
        } catch {
          // Offline or refused: the card shows its time without the stage name.
        }
      })
    );
    setStageNames(names);
  }, []);

  useFocusEffect(
    // `void` is honest here only because loadJobs' whole body sits inside the
    // try/catch above: it settles rather than rejects, so nothing is dropped.
    // The same holds at the other two call sites below.
    useCallback(() => {
      void loadJobs();
    }, [loadJobs])
  );

  function onRefresh() {
    setRefreshing(true);
    void loadJobs();
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE });
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });
  }

  // "Today" is the Melbourne day, and an entry is today's when it is BOOKED
  // today — a Mon–Wed daily booking sits under Today on Tuesday too (0071).
  // Each entry is one of the technician's own bookings (a job booked twice
  // for them is two cards), or the job's own window where they have none
  // (lib/bookings.ts myJobEntries says exactly when).
  const todayKey = businessTodayKey();
  const { today: todayJobs, upcoming: upcomingJobs, earlier: earlierJobs } = splitMyJobEntries(
    myJobEntries(jobs, bookings, userId ?? "", todayKey),
    todayKey
  );

  function openWaze(job: Job) {
    // openNavigation owns the coordinates-then-address fallback and tells the
    // technician when nothing on the device can open the link — the silence
    // after a bare Linking.openURL is indistinguishable from a missed tap when
    // you are standing in a driveway. It resolves to a boolean instead of
    // rejecting, so there is nothing left here to handle.
    void openNavigation(job.sites);
  }

  function WindowLine({ window }: { window: ScheduledJobWindow }) {
    if (!window.scheduled_start) return null;
    if (window.schedule_daily) return <Text style={styles.cardMeta}>🕐 {formatScheduleSummary(window)}</Text>;
    return (
      <Text style={styles.cardMeta}>
        🕐 {formatDate(window.scheduled_start)} · {formatTime(window.scheduled_start)}
        {window.scheduled_end ? ` – ${formatTime(window.scheduled_end)}` : ""}
      </Text>
    );
  }

  function JobCard({ entry }: { entry: MyJobEntry<Job> }) {
    const { job, window } = entry;
    const sc = statusColors[job.status] ?? statusColors.pending;
    const address = job.sites ? `${job.sites.address_line1}, ${job.sites.suburb}` : null;
    const stage = entry.costCenterId ? stageNames[entry.costCenterId] : null;
    return (
      <TouchableOpacity style={styles.card} onPress={() => router.push(`/job/${job.id}`)}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            #{job.job_number} — {job.title}
          </Text>
          <View style={[styles.badge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.badgeText, { color: sc.text }]}>{job.status.replace("_", " ")}</Text>
          </View>
        </View>
        {job.customers?.name && <Text style={styles.cardSubtext}>{job.customers.name}</Text>}
        {address && <Text style={styles.cardMeta}>📍 {address}</Text>}
        <WindowLine window={window} />
        {stage ? <Text style={styles.cardMeta}>🔧 {stage}</Text> : null}
        {job.sites && (
          <TouchableOpacity style={styles.wazeButton} onPress={() => openWaze(job)}>
            <Text style={styles.wazeButtonText}>Navigate</Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </SafeAreaView>
    );
  }

  // Checked BEFORE the list renders, so a failed load can never fall through to
  // the "No jobs assigned" empty state. That confusion is the entire bug.
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <ScreenError
          error={error}
          onRetry={() => {
            setLoading(true);
            void loadJobs();
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Image source={require("../../assets/logo.png")} style={styles.headerLogo} resizeMode="contain" />
          <View>
            <Text style={styles.headerTitle}>My Jobs</Text>
            <Text style={styles.headerSubtitle}>{profile?.full_name ?? ""}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={signOut}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={[
          ...(todayJobs.length > 0
            ? [{ type: "header" as const, key: "today-header", label: `Today (${todayJobs.length})` }]
            : []),
          ...todayJobs.map((e) => ({ type: "job" as const, key: e.key, entry: e })),
          ...(upcomingJobs.length > 0
            ? [{ type: "header" as const, key: "upcoming-header", label: `Upcoming (${upcomingJobs.length})` }]
            : []),
          ...upcomingJobs.map((e) => ({ type: "job" as const, key: e.key, entry: e })),
          // Past-dated but not finished: last, so the next job is always on top.
          ...(earlierJobs.length > 0
            ? [{ type: "header" as const, key: "earlier-header", label: `Earlier — not finished (${earlierJobs.length})` }]
            : []),
          ...earlierJobs.map((e) => ({ type: "job" as const, key: e.key, entry: e })),
        ]}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item }) => {
          if (item.type === "header") {
            return <Text style={styles.sectionHeader}>{(item as any).label}</Text>;
          }
          return <JobCard entry={(item as any).entry} />;
        }}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No jobs assigned right now.</Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerLogo: { width: 34, height: 34 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: colors.slate900 },
  headerSubtitle: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  signOut: { fontSize: 13, color: colors.red600, fontWeight: "600" },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.slate500,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: colors.slate900, flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  cardSubtext: { fontSize: 13, color: colors.slate500, marginTop: 4 },
  cardMeta: { fontSize: 12, color: colors.slate400, marginTop: 3 },
  wazeButton: {
    marginTop: 10,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.blue100,
    backgroundColor: colors.blue100,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  wazeButtonText: { color: colors.blue600, fontSize: 12, fontWeight: "600" },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 60, fontSize: 14 },
});
