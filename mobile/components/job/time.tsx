import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

interface TimeEntry {
  id: string;
  staff_id: string;
  clock_in: string;
  clock_out: string | null;
  hours: number | null;
  auto_clocked: boolean;
  entry_type?: "work" | "travel";
  cost_center_id: string | null;
  profiles: { full_name: string } | null;
}

interface CostCenterOption {
  id: string;
  name: string;
  code: string | null;
  po_number?: string;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

// Tap-to-open bottom-sheet list, same pattern as overview.tsx's SelectField —
// avoids the inline @react-native-picker/picker wheel, which on iOS also
// spins (and silently changes the value) when the user is just scrolling
// the page past it.
function CostCenterPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string | null;
  options: CostCenterOption[];
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value);
  const listData: (CostCenterOption | { id: "none"; name: "Unassigned"; code: null })[] = [
    { id: "none", name: "Unassigned", code: null },
    ...options,
  ];

  return (
    <>
      <TouchableOpacity
        style={[styles.stageField, disabled && styles.stageFieldDisabled]}
        onPress={() => !disabled && setOpen(true)}
      >
        <Text style={styles.stageFieldText} numberOfLines={1}>
          {current ? `${current.name}${current.po_number ? ` (PO #${current.po_number})` : ""}` : "Assign to stage..."}
        </Text>
        <Ionicons name="chevron-down" size={14} color={colors.slate400} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Assign to Stage</Text>
            <FlatList
              data={listData}
              keyExtractor={(o) => o.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => {
                    onChange(item.id === "none" ? null : item.id);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.modalRowText, (value ?? "none") === item.id && styles.modalRowTextActive]}>
                    {item.name}
                    {"po_number" in item && item.po_number ? ` (PO #${item.po_number})` : ""}
                  </Text>
                  {(value ?? "none") === item.id && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

export function JobTimeTab({ jobId, currentUserId }: { jobId: string; currentUserId: string }) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenterOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    const { data } = await supabase
      .from("time_entries")
      .select("*, profiles(full_name)")
      .eq("job_id", jobId)
      .order("clock_in", { ascending: false });
    setEntries((data as any) ?? []);
  }, [jobId]);

  const loadCostCenters = useCallback(async () => {
    const { data } = await supabase
      .from("purchase_orders")
      .select("po_number, po_cost_centers(id, name, code)")
      .eq("job_id", jobId);
    const flat: CostCenterOption[] = (data ?? []).flatMap((po: any) =>
      (po.po_cost_centers ?? []).map((cc: any) => ({ id: cc.id, name: cc.name, code: cc.code, po_number: po.po_number }))
    );
    setCostCenters(flat);
  }, [jobId]);

  useEffect(() => {
    loadEntries();
    loadCostCenters();
  }, [loadEntries, loadCostCenters]);

  const myOpenEntry = entries.find((e) => e.staff_id === currentUserId && e.entry_type !== "travel" && !e.clock_out);
  const workEntries = entries.filter((e) => e.entry_type !== "travel");
  const travelEntries = entries.filter((e) => e.entry_type === "travel");
  const totalHours = workEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);
  const totalTravelHours = travelEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);

  async function clockIn() {
    if (myOpenEntry || loading) return;
    setLoading(true);
    await supabase.from("time_entries").insert({
      job_id: jobId,
      staff_id: currentUserId,
      clock_in: new Date().toISOString(),
      auto_clocked: false,
    });
    await loadEntries();
    setLoading(false);
  }

  async function clockOut() {
    if (!myOpenEntry || loading) return;
    setLoading(true);
    const clockOutTime = new Date().toISOString();
    const hours = Math.round(((new Date(clockOutTime).getTime() - new Date(myOpenEntry.clock_in).getTime()) / 3600000) * 100) / 100;
    await supabase.from("time_entries").update({ clock_out: clockOutTime, hours }).eq("id", myOpenEntry.id);
    await loadEntries();
    setLoading(false);
  }

  async function assignCostCenter(entryId: string, costCenterId: string | null) {
    setAssigningId(entryId);
    const { error } = await supabase.from("time_entries").update({ cost_center_id: costCenterId }).eq("id", entryId);
    setAssigningId(null);
    if (error) return;
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, cost_center_id: costCenterId } : e)));
  }

  return (
    <View style={styles.container}>
      <View style={styles.clockRow}>
        {!myOpenEntry ? (
          <TouchableOpacity style={styles.clockInButton} onPress={clockIn} disabled={loading}>
            <Text style={styles.clockInText}>{loading ? "..." : "Clock In"}</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity style={styles.clockOutButton} onPress={clockOut} disabled={loading}>
              <Text style={styles.clockOutText}>{loading ? "..." : "Clock Out"}</Text>
            </TouchableOpacity>
            <Text style={styles.sinceText}>Since {formatTime(myOpenEntry.clock_in)}</Text>
          </>
        )}
      </View>

      {entries.length > 0 && (
        <View style={styles.logHeader}>
          <Text style={styles.logTitle}>Time Log</Text>
          <Text style={styles.logTotal}>
            {totalHours.toFixed(1)}h total
            {totalTravelHours > 0 ? `  ·  ${totalTravelHours.toFixed(1)}h travel` : ""}
          </Text>
        </View>
      )}

      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        scrollEnabled={false}
        ListEmptyComponent={<Text style={styles.emptyText}>No time logged yet</Text>}
        renderItem={({ item }) => {
          const isTravel = item.entry_type === "travel";
          return (
            <View style={[styles.entryRow, isTravel && styles.entryRowTravel]}>
              <View style={styles.entryTopRow}>
                <View>
                  <Text style={styles.entryName}>
                    {item.profiles?.full_name ?? "—"}
                    {isTravel ? " (travel)" : item.auto_clocked ? " (auto)" : ""}
                  </Text>
                  <Text style={styles.entryDate}>{formatDate(item.clock_in)}</Text>
                </View>
                <Text style={styles.entryTime}>
                  {formatTime(item.clock_in)} → {item.clock_out ? formatTime(item.clock_out) : "now"}
                  {item.hours != null ? `  ${Number(item.hours).toFixed(1)}h` : ""}
                </Text>
              </View>
              {!isTravel && costCenters.length > 0 && (
                <CostCenterPicker
                  value={item.cost_center_id}
                  options={costCenters}
                  disabled={assigningId === item.id}
                  onChange={(v) => assignCostCenter(item.id, v)}
                />
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  clockRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 },
  clockInButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  clockInText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  clockOutButton: { backgroundColor: colors.red100, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12, borderWidth: 1, borderColor: colors.red600 },
  clockOutText: { color: colors.red600, fontWeight: "600", fontSize: 14 },
  sinceText: { color: colors.green600, fontWeight: "600", fontSize: 13 },
  logHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  logTitle: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  logTotal: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  entryRow: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    gap: 8,
  },
  entryTopRow: { flexDirection: "row", justifyContent: "space-between" },
  entryRowTravel: {
    backgroundColor: colors.blue100,
    borderColor: colors.blue100,
  },
  entryName: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  entryDate: { fontSize: 11, color: colors.slate400, marginTop: 2 },
  entryTime: { fontSize: 12, color: colors.slate500 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
  stageField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.bg,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  stageFieldDisabled: { opacity: 0.5 },
  stageFieldText: { fontSize: 12, color: colors.slate700, fontWeight: "500", flexShrink: 1, marginRight: 6 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24, maxHeight: "60%" },
  modalTitle: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", padding: 16, paddingBottom: 8 },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalRowText: { fontSize: 15, color: colors.slate900 },
  modalRowTextActive: { color: colors.blue600, fontWeight: "600" },
});
