import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Modal, Platform } from "react-native";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
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
  edited_at?: string | null;
  profiles: { full_name: string } | null;
}

interface EditingEntry {
  mode: "edit" | "add";
  entryId?: string;
  entryType: "work" | "travel";
  clockIn: Date;
  clockOut: Date | null;
  costCenterId: string | null;
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
function formatDateTime(d: Date) {
  return d.toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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

// Tapping the field toggles an inline picker on iOS (spinner, combined
// date+time in one control) or opens the native date dialog on Android,
// which then chains into a native time dialog — Android's DateTimePicker
// has no combined "datetime" mode, only "date" and "time" separately.
function DateTimeField({ label, value, onChange }: { label: string; value: Date; onChange: (d: Date) => void }) {
  const [showDate, setShowDate] = useState(false);
  const [showTime, setShowTime] = useState(false);

  function openPicker() {
    if (Platform.OS === "ios") {
      setShowDate((s) => !s);
    } else {
      setShowDate(true);
    }
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    if (Platform.OS === "android") {
      setShowDate(false);
      if (event.type === "dismissed" || !selected) return;
      const merged = new Date(value);
      merged.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
      onChange(merged);
      setShowTime(true);
      return;
    }
    if (selected) onChange(selected);
  }

  function onTimeChange(event: DateTimePickerEvent, selected?: Date) {
    setShowTime(false);
    if (event.type === "dismissed" || !selected) return;
    const merged = new Date(value);
    merged.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
    onChange(merged);
  }

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity style={styles.stageField} onPress={openPicker}>
        <Text style={styles.stageFieldText}>{formatDateTime(value)}</Text>
        <Ionicons name="calendar-outline" size={14} color={colors.slate400} />
      </TouchableOpacity>
      {showDate && (
        <DateTimePicker
          value={value}
          mode={Platform.OS === "ios" ? "datetime" : "date"}
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onChange={onDateChange}
        />
      )}
      {showTime && Platform.OS === "android" && (
        <DateTimePicker value={value} mode="time" display="default" onChange={onTimeChange} />
      )}
    </View>
  );
}

function TimeEntryModal({
  visible,
  editing,
  costCenters,
  onChange,
  onCancel,
  onSave,
  onDelete,
}: {
  visible: boolean;
  editing: EditingEntry | null;
  costCenters: CostCenterOption[];
  onChange: (next: EditingEntry) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  if (!editing) return null;
  const hoursPreview =
    editing.clockOut && editing.clockOut.getTime() > editing.clockIn.getTime()
      ? Math.round(((editing.clockOut.getTime() - editing.clockIn.getTime()) / 3600000) * 100) / 100
      : null;
  const invalid = !!editing.clockOut && editing.clockOut.getTime() <= editing.clockIn.getTime();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity activeOpacity={1} style={styles.editSheet} onPress={() => {}}>
          <Text style={styles.modalTitle}>{editing.mode === "add" ? "Add Manual Entry" : "Edit Time Entry"}</Text>
          <Text style={styles.editHint}>
            Use this when auto clock-in/out didn't work — set the real start/end time yourself.
          </Text>

          <DateTimeField label="Start" value={editing.clockIn} onChange={(d) => onChange({ ...editing, clockIn: d })} />

          {editing.clockOut ? (
            <>
              <DateTimeField label="End" value={editing.clockOut} onChange={(d) => onChange({ ...editing, clockOut: d })} />
              <TouchableOpacity onPress={() => onChange({ ...editing, clockOut: null })}>
                <Text style={styles.linkText}>Mark as still clocked in</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={() => onChange({ ...editing, clockOut: new Date() })}>
              <Text style={styles.linkText}>+ Set end time</Text>
            </TouchableOpacity>
          )}

          {invalid && <Text style={styles.errorText}>End time must be after start time</Text>}
          {hoursPreview != null && !invalid && <Text style={styles.hoursPreview}>{hoursPreview.toFixed(2)}h</Text>}

          {editing.entryType !== "travel" && costCenters.length > 0 && (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Stage</Text>
              <CostCenterPicker
                value={editing.costCenterId}
                options={costCenters}
                onChange={(v) => onChange({ ...editing, costCenterId: v })}
              />
            </View>
          )}

          <View style={styles.editActions}>
            {onDelete && (
              <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
                <Text style={styles.deleteButtonText}>Delete</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.saveButton, invalid && styles.saveButtonDisabled]} onPress={onSave} disabled={invalid}>
              <Text style={styles.saveButtonText}>Save</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

export function JobTimeTab({ jobId, currentUserId }: { jobId: string; currentUserId: string }) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenterOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingEntry | null>(null);
  const [saving, setSaving] = useState(false);

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

  // Self-service correction flow: a tech can adjust the start/end time of
  // their own entries, or add a brand-new backdated entry, for whenever the
  // auto clock-in/out (geofencing) didn't fire, or fired at the wrong time.
  function openEditEntry(entry: TimeEntry) {
    if (entry.staff_id !== currentUserId || saving) return;
    setEditing({
      mode: "edit",
      entryId: entry.id,
      entryType: entry.entry_type === "travel" ? "travel" : "work",
      clockIn: new Date(entry.clock_in),
      clockOut: entry.clock_out ? new Date(entry.clock_out) : null,
      costCenterId: entry.cost_center_id,
    });
  }

  function openAddManualEntry() {
    if (saving) return;
    const now = new Date();
    setEditing({ mode: "add", entryType: "work", clockIn: now, clockOut: now, costCenterId: null });
  }

  async function saveEditing() {
    if (!editing || saving) return;
    setSaving(true);
    const hours = editing.clockOut
      ? Math.round(((editing.clockOut.getTime() - editing.clockIn.getTime()) / 3600000) * 100) / 100
      : null;
    const nowIso = new Date().toISOString();

    if (editing.mode === "add") {
      await supabase.from("time_entries").insert({
        job_id: jobId,
        staff_id: currentUserId,
        entry_type: editing.entryType,
        clock_in: editing.clockIn.toISOString(),
        clock_out: editing.clockOut ? editing.clockOut.toISOString() : null,
        hours,
        cost_center_id: editing.costCenterId,
        auto_clocked: false,
        edited_by: currentUserId,
        edited_at: nowIso,
      });
    } else if (editing.entryId) {
      await supabase
        .from("time_entries")
        .update({
          clock_in: editing.clockIn.toISOString(),
          clock_out: editing.clockOut ? editing.clockOut.toISOString() : null,
          hours,
          cost_center_id: editing.costCenterId,
          edited_by: currentUserId,
          edited_at: nowIso,
        })
        .eq("id", editing.entryId);
    }
    setSaving(false);
    setEditing(null);
    await loadEntries();
  }

  async function deleteEditing() {
    if (!editing?.entryId || saving) return;
    setSaving(true);
    await supabase.from("time_entries").delete().eq("id", editing.entryId);
    setSaving(false);
    setEditing(null);
    await loadEntries();
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

      <View style={styles.logHeader}>
        <Text style={styles.logTitle}>Time Log</Text>
        {entries.length > 0 && (
          <Text style={styles.logTotal}>
            {totalHours.toFixed(1)}h total
            {totalTravelHours > 0 ? `  ·  ${totalTravelHours.toFixed(1)}h travel` : ""}
          </Text>
        )}
      </View>
      <TouchableOpacity style={styles.addManualButton} onPress={openAddManualEntry}>
        <Ionicons name="add-circle-outline" size={16} color={colors.blue600} />
        <Text style={styles.addManualButtonText}>Add manual entry</Text>
      </TouchableOpacity>
      <Text style={styles.addManualHint}>Use this if auto clock-in/out didn't fire correctly — tap an entry below to correct it.</Text>

      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        scrollEnabled={false}
        ListEmptyComponent={<Text style={styles.emptyText}>No time logged yet</Text>}
        renderItem={({ item }) => {
          const isTravel = item.entry_type === "travel";
          const isMine = item.staff_id === currentUserId;
          return (
            <View style={[styles.entryRow, isTravel && styles.entryRowTravel]}>
              <TouchableOpacity
                style={styles.entryTopRow}
                activeOpacity={isMine ? 0.6 : 1}
                onPress={() => openEditEntry(item)}
                disabled={!isMine}
              >
                <View>
                  <Text style={styles.entryName}>
                    {item.profiles?.full_name ?? "—"}
                    {isTravel ? " (travel)" : item.auto_clocked ? " (auto)" : ""}
                    {item.edited_at ? " · edited" : ""}
                  </Text>
                  <Text style={styles.entryDate}>{formatDate(item.clock_in)}</Text>
                </View>
                <View style={styles.entryTimeRow}>
                  <Text style={styles.entryTime}>
                    {formatTime(item.clock_in)} → {item.clock_out ? formatTime(item.clock_out) : "now"}
                    {item.hours != null ? `  ${Number(item.hours).toFixed(1)}h` : ""}
                  </Text>
                  {isMine && <Ionicons name="pencil" size={12} color={colors.slate400} />}
                </View>
              </TouchableOpacity>
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

      <TimeEntryModal
        visible={!!editing}
        editing={editing}
        costCenters={costCenters}
        onChange={setEditing}
        onCancel={() => setEditing(null)}
        onSave={saveEditing}
        onDelete={editing?.mode === "edit" ? deleteEditing : undefined}
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
  entryTimeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
  addManualButton: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  addManualButtonText: { fontSize: 13, fontWeight: "600", color: colors.blue600 },
  addManualHint: { fontSize: 11, color: colors.slate400, marginBottom: 12 },
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
  editSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
  },
  editHint: { fontSize: 12, color: colors.slate400, marginTop: -4, marginBottom: 16 },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 11, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  linkText: { fontSize: 12, color: colors.blue600, fontWeight: "600", marginBottom: 14 },
  errorText: { fontSize: 12, color: colors.red600, marginBottom: 10 },
  hoursPreview: { fontSize: 20, fontWeight: "700", color: colors.slate900, marginBottom: 14 },
  editActions: { flexDirection: "row", gap: 10, marginTop: 8 },
  deleteButton: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.red100, borderWidth: 1, borderColor: colors.red600 },
  deleteButtonText: { color: colors.red600, fontWeight: "600", fontSize: 14 },
  cancelButton: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveButton: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
