import { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from "react-native";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

// Mirrors the web "Hours Scoreboard" in components/job/job-po.tsx — shows
// technicians how many hours have been allocated to this job (set manually
// by the office when building the Purchase Order) vs. how many hours have
// actually been logged against it, so they have something concrete to
// measure against. Ticks live while someone is clocked in, and prompts for
// a reason (tracked for office review) once the allocated hours are used up.

const CATEGORIES: { key: string; label: string }[] = [
  { key: "unexpected_issue", label: "Unexpected issue" },
  { key: "difficult_site", label: "Difficult site" },
  { key: "training_needed", label: "Training needed" },
  { key: "other", label: "Other" },
];

function progressColor(pct: number) {
  if (pct >= 95) return colors.red600;
  if (pct >= 75) return "#f97316"; // orange-500, matches web's progressColor
  return colors.green600;
}

interface JobLite {
  id: string;
  overtime_reason?: string | null;
  overtime_category?: string | null;
}

export function JobHoursScoreboard({ job, currentUserId }: { job: JobLite; currentUserId: string | null }) {
  const jobId = job.id;
  const [allocatedHours, setAllocatedHours] = useState(0);
  const [closedHours, setClosedHours] = useState(0);
  const [openClockIn, setOpenClockIn] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);

  const [overtimeReason, setOvertimeReason] = useState(job.overtime_reason ?? null);
  const [overtimeCategory, setOvertimeCategory] = useState(job.overtime_category ?? null);
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const [{ data: pos }, { data: entries }] = await Promise.all([
      supabase.from("purchase_orders").select("total_hours").eq("job_id", jobId),
      // Only "work" entries count against the allocated-hours budget — travel
      // time between jobs is tracked separately and shouldn't eat into it.
      supabase.from("time_entries").select("hours, clock_in, clock_out").eq("job_id", jobId).eq("entry_type", "work"),
    ]);
    const totalAllocated = (pos ?? []).reduce((sum: number, p: any) => sum + (Number(p.total_hours) || 0), 0);
    const closed = (entries ?? []).filter((e: any) => e.clock_out).reduce((sum: number, e: any) => sum + (e.hours ? Number(e.hours) : 0), 0);
    const open = (entries ?? []).find((e: any) => !e.clock_out);
    setAllocatedHours(totalAllocated);
    setClosedHours(closed);
    setOpenClockIn(open?.clock_in ?? null);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Tick every second while someone is clocked in on this job, so the
  // countdown is genuinely live rather than only updating on clock-out.
  useEffect(() => {
    if (!openClockIn) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [openClockIn]);

  if (loading || allocatedHours <= 0) return null;

  const liveOpenHours = openClockIn ? (now - new Date(openClockIn).getTime()) / 3600000 : 0;
  const loggedHours = closedHours + liveOpenHours;
  const pct = Math.min((loggedHours / allocatedHours) * 100, 100);
  const barColor = progressColor(pct);
  const remaining = Math.max(0, allocatedHours - loggedHours);
  const exceeded = loggedHours >= allocatedHours;

  async function submitReason() {
    if (!category) {
      Alert.alert("Pick a reason", "Choose the category that best fits why the job ran over.");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("jobs")
      .update({
        overtime_category: category,
        overtime_reason: reasonText.trim() || null,
        overtime_logged_by: currentUserId,
        overtime_logged_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    setSaving(false);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    setOvertimeCategory(category);
    setOvertimeReason(reasonText.trim() || null);
    setShowForm(false);
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Hours Scoreboard</Text>
      <View style={styles.row}>
        <Text style={styles.label}>{openClockIn ? "Time used (live)" : "Time used"}</Text>
        <Text style={[styles.value, { color: barColor }]}>
          {loggedHours.toFixed(1)}h / {allocatedHours.toFixed(1)}h
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: barColor }]} />
      </View>
      <View style={styles.row}>
        <Text style={styles.meta}>{pct.toFixed(0)}% of budget used</Text>
        <Text style={styles.meta}>{remaining.toFixed(1)}h remaining</Text>
      </View>

      {exceeded && (
        <View style={styles.overtimeBox}>
          {overtimeCategory ? (
            <>
              <Text style={styles.overtimeLoggedTitle}>Overtime reason logged</Text>
              <Text style={styles.overtimeLoggedText}>
                {CATEGORIES.find((c) => c.key === overtimeCategory)?.label ?? overtimeCategory}
                {overtimeReason ? ` — ${overtimeReason}` : ""}
              </Text>
            </>
          ) : showForm ? (
            <>
              <Text style={styles.overtimeTitle}>Why did this job go over?</Text>
              <View style={styles.categoryRow}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity
                    key={c.key}
                    style={[styles.categoryChip, category === c.key && styles.categoryChipActive]}
                    onPress={() => setCategory(c.key)}
                  >
                    <Text style={[styles.categoryChipText, category === c.key && styles.categoryChipTextActive]}>{c.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={styles.input}
                value={reasonText}
                onChangeText={setReasonText}
                placeholder="Add a bit more detail (optional)..."
                multiline
              />
              <TouchableOpacity style={styles.submitButton} onPress={submitReason} disabled={saving}>
                <Text style={styles.submitButtonText}>{saving ? "Saving..." : "Log Reason"}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.overtimeTitle}>You've used all the allocated hours for this job.</Text>
              <TouchableOpacity style={styles.submitButton} onPress={() => setShowForm(true)}>
                <Text style={styles.submitButtonText}>Log a reason</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.blue100,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.blue100,
    marginBottom: 16,
  },
  title: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 13, color: colors.slate700 },
  value: { fontSize: 14, fontWeight: "700" },
  track: { width: "100%", backgroundColor: colors.slate100, borderRadius: 999, height: 10, marginTop: 6, marginBottom: 6, overflow: "hidden" },
  fill: { height: 10, borderRadius: 999 },
  meta: { fontSize: 11, color: colors.slate400 },
  overtimeBox: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#bfdbfe" },
  overtimeTitle: { fontSize: 13, fontWeight: "600", color: colors.red600, marginBottom: 8 },
  overtimeLoggedTitle: { fontSize: 11, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  overtimeLoggedText: { fontSize: 13, color: colors.slate700, marginTop: 4 },
  categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  categoryChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  categoryChipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  categoryChipText: { fontSize: 12, fontWeight: "600", color: colors.slate700 },
  categoryChipTextActive: { color: "#fff" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    backgroundColor: colors.card,
    color: colors.slate900,
    minHeight: 60,
    textAlignVertical: "top",
    marginBottom: 8,
  },
  submitButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
});
