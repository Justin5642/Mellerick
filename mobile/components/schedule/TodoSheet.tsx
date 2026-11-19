// The office to-do list on the phone's Schedule tab (office/admin only — the
// tab lives in the (office) route group). The web board's to-do panel
// (components/schedule/todo-board-panel.tsx), shaped for a phone:
//
//   * the listed jobs, most urgent then longest-waiting first, with their
//     hours (office's estimate, else the PO allocation — hours only) and
//     days on the list, filtered by "Fits in [__] h";
//   * "Place" picks a job; the sheet closes and the next tap on the grid
//     (a technician's day) books it — the screen does the booking, with the
//     same guards as every other schedule change;
//   * ✕ takes a job off the list;
//   * "Add job…" searches open, unscheduled jobs on the server (online only)
//     and lists one with an optional hours estimate.
//
// Rules: lib/todoList.ts + lib/todoBoard.ts (mirrors of the web's). Nothing
// here holds a value/amount column.
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { colors } from "../../lib/theme";
import { daysOnList, fitsGap, formatHours, MAX_ESTIMATED_HOURS, parseEstimatedHours, parseGapHours, sortTodoJobs, todoHours } from "../../lib/todoList";
import { isSearchable, searchTodoCandidates, type TodoCandidate, type TodoJob } from "../../lib/data/reads/todo";

const PRIORITY: Record<string, { bg: string; text: string }> = {
  urgent: { bg: colors.red100, text: colors.red600 },
  high: { bg: colors.orange100, text: colors.orange700 },
  normal: { bg: colors.slate100, text: colors.slate700 },
  low: { bg: colors.slate100, text: colors.slate500 },
};

interface Props {
  visible: boolean;
  onClose: () => void;
  /** null while loading for the first time. */
  jobs: TodoJob[] | null;
  /** Set when the list couldn't be read (offline, …). */
  loadError: string | null;
  onRetry: () => void;
  gapInput: string;
  onGapInput: (value: string) => void;
  /** Pick a job to place on the grid. */
  onPlace: (job: TodoJob) => void;
  onRemove: (job: TodoJob) => void;
  /** List a searched job, with its estimate (null = none). Resolves once queued. */
  onAdd: (job: TodoCandidate, estimatedHours: number | null) => Promise<void>;
}

export function TodoSheet({ visible, onClose, jobs, loadError, onRetry, gapInput, onGapInput, onPlace, onRemove, onAdd }: Props) {
  const gapHours = parseGapHours(gapInput);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (visible) setNowMs(Date.now());
  }, [visible]);
  const rows = useMemo(
    () => sortTodoJobs(jobs ?? []).map((job) => ({ job, ...todoHours(job.estimated_hours, job.po_allocated_hours) })),
    [jobs],
  );
  const shown = rows.filter((r) => fitsGap(r.hours, gapHours));

  // ---- "Add job…" ----------------------------------------------------------
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TodoCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const term = query.trim();
    if (!isSearchable(term)) {
      seq.current++;
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      searchTodoCandidates(term).then(
        (found) => {
          if (mine !== seq.current) return;
          setSearching(false);
          setSearchError(null);
          const listed = new Set((jobs ?? []).map((j) => j.id));
          setResults(found.filter((f) => !listed.has(f.id)));
        },
        () => {
          if (mine !== seq.current) return;
          setSearching(false);
          setResults([]);
          setSearchError("Couldn't search jobs — searching needs signal.");
        },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [query, jobs]);

  // The estimate step, as the web's "Add to to-do list" asks it.
  const [adding, setAdding] = useState<TodoCandidate | null>(null);
  const [hoursInput, setHoursInput] = useState("");
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startAdd(job: TodoCandidate) {
    setAdding(job);
    setHoursInput(job.estimated_hours != null ? String(job.estimated_hours) : "");
    setHoursError(null);
  }

  async function confirmAdd() {
    if (!adding || saving) return;
    const parsed = parseEstimatedHours(hoursInput);
    if (parsed === "invalid") {
      setHoursError(`Estimated hours must be a number from 0 to ${MAX_ESTIMATED_HOURS}.`);
      return;
    }
    setSaving(true);
    try {
      await onAdd(adding, parsed);
      setResults((cur) => cur.filter((r) => r.id !== adding.id));
      setAdding(null);
      setQuery("");
    } catch (e) {
      setHoursError(e instanceof Error ? e.message : "Couldn't add the job. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const footer = adding ? (
    <View style={styles.footerRow}>
      <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => setAdding(null)} disabled={saving}>
        <Text style={styles.btnGhostText}>Back</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => void confirmAdd()} disabled={saving}>
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Add to to-do list</Text>}
      </TouchableOpacity>
    </View>
  ) : (
    <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={onClose}>
      <Text style={styles.btnGhostText}>Close</Text>
    </TouchableOpacity>
  );

  return (
    <KeyboardSheet
      visible={visible}
      onRequestClose={adding ? () => setAdding(null) : onClose}
      title={
        <View style={styles.titleRow}>
          <Ionicons name="list" size={18} color="#4f46e5" />
          <Text style={styles.title}>
            {adding ? `Add #${adding.job_number} to the to-do list` : `To-do list (${jobs?.length ?? 0})`}
          </Text>
        </View>
      }
      footer={footer}
      testID="todo-sheet"
    >
      {adding ? (
        <View>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {adding.title}
          </Text>
          <Text style={styles.rowSub}>{[adding.customer_name, adding.suburb].filter(Boolean).join(" · ") || "—"}</Text>
          <Text style={styles.label}>Estimated hours (optional)</Text>
          <TextInput
            style={styles.input}
            value={hoursInput}
            onChangeText={(t) => {
              setHoursInput(t);
              setHoursError(null);
            }}
            keyboardType="decimal-pad"
            placeholder="e.g. 4"
            placeholderTextColor={colors.slate400}
            accessibilityLabel="Estimated hours"
            autoFocus
          />
          <Text style={styles.help}>Used by the &quot;Fits in&quot; filter and to size the booking when you place it.</Text>
          {hoursError ? <Text style={styles.error}>{hoursError}</Text> : null}
        </View>
      ) : (
        <View>
          <Text style={styles.help}>
            Tap <Text style={styles.bold}>Place</Text>, then tap a technician&apos;s day on the schedule. To take a booking off the schedule, tap it → &quot;Back to to-do list&quot;.
          </Text>

          <View style={styles.fitsRow}>
            <Text style={styles.label}>Fits in</Text>
            <TextInput
              style={[styles.input, styles.fitsInput]}
              value={gapInput}
              onChangeText={onGapInput}
              keyboardType="decimal-pad"
              placeholder="any"
              placeholderTextColor={colors.slate400}
              accessibilityLabel="Fits in hours"
            />
            <Text style={styles.label}>h</Text>
            {gapInput ? (
              <TouchableOpacity onPress={() => onGapInput("")} hitSlop={10}>
                <Text style={styles.link}>Clear</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {loadError ? (
            <TouchableOpacity style={styles.errorBox} onPress={onRetry}>
              <Ionicons name="alert-circle-outline" size={18} color={colors.orange700} />
              <Text style={styles.errorBoxText}>{loadError} Tap to retry.</Text>
            </TouchableOpacity>
          ) : jobs === null ? (
            <ActivityIndicator color={colors.blue600} style={{ marginVertical: 16 }} />
          ) : shown.length === 0 ? (
            <Text style={styles.empty}>
              {rows.length === 0 ? "Nothing on the to-do list." : `No to-do job fits in ${gapHours} h (jobs without hours always show).`}
            </Text>
          ) : (
            shown.map(({ job, hours, source }) => {
              const pri = PRIORITY[job.priority] ?? PRIORITY.normal;
              const days = daysOnList(job.todo_listed_at, nowMs);
              return (
                <View key={job.id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      #{job.job_number} {job.title}
                    </Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {[job.customer_name, job.suburb].filter(Boolean).join(" · ") || "—"}
                    </Text>
                    <View style={styles.metaRow}>
                      <Text style={[styles.chip, { backgroundColor: pri.bg, color: pri.text }]}>{job.priority}</Text>
                      <Text style={styles.meta}>{hours !== null ? `${formatHours(hours)}${source === "po" ? " (PO)" : ""}` : "No hours"}</Text>
                      <Text style={styles.meta}>{days === 0 ? "Listed today" : `${days} d on list`}</Text>
                      {job.status !== "pending" ? <Text style={styles.meta}>{job.status.replace("_", " ")}</Text> : null}
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.placeBtn}
                    onPress={() => onPlace(job)}
                    accessibilityLabel={`Place #${job.job_number} on the schedule`}
                  >
                    <Ionicons name="hand-left-outline" size={16} color="#fff" />
                    <Text style={styles.placeText}>Place</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.removeBtn}
                    onPress={() => onRemove(job)}
                    hitSlop={6}
                    accessibilityLabel={`Take #${job.job_number} off the to-do list`}
                  >
                    <Ionicons name="close" size={18} color={colors.slate500} />
                  </TouchableOpacity>
                </View>
              );
            })
          )}

          <Text style={[styles.label, { marginTop: 16 }]}>Add job…</Text>
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Job number, title or customer"
            placeholderTextColor={colors.slate400}
            autoCorrect={false}
            accessibilityLabel="Search jobs to add"
          />
          {searching ? <ActivityIndicator color={colors.blue600} style={{ marginTop: 8 }} /> : null}
          {searchError ? <Text style={styles.error}>{searchError}</Text> : null}
          {!searching && !searchError && isSearchable(query) && results.length === 0 ? (
            <Text style={styles.help}>No open, unscheduled job matches.</Text>
          ) : null}
          {results.map((r) => (
            <TouchableOpacity key={r.id} style={styles.row} onPress={() => startAdd(r)} accessibilityLabel={`Add #${r.job_number} to the to-do list`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  #{r.job_number} {r.title}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {[r.customer_name, r.suburb].filter(Boolean).join(" · ") || "—"}
                  {r.status !== "pending" ? ` · ${r.status.replace("_", " ")}` : ""}
                </Text>
              </View>
              <Ionicons name="add-circle-outline" size={22} color={colors.blue600} />
            </TouchableOpacity>
          ))}
        </View>
      )}
    </KeyboardSheet>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900, flex: 1 },
  help: { fontSize: 12, color: colors.slate500, marginTop: 6, lineHeight: 16 },
  bold: { fontWeight: "700", color: colors.slate700 },
  label: { fontSize: 13, fontWeight: "700", color: colors.slate700, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    color: colors.slate900,
    backgroundColor: colors.card,
    marginTop: 6,
  },
  fitsRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  fitsInput: { width: 72, marginTop: 8, textAlign: "center" },
  link: { fontSize: 13, color: colors.blue600, fontWeight: "600", marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  rowTitle: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  rowSub: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 },
  chip: { fontSize: 10, fontWeight: "700", textTransform: "capitalize", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden" },
  meta: { fontSize: 11, color: colors.slate500, textTransform: "capitalize" },
  placeBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#4f46e5", borderRadius: 8, paddingHorizontal: 10, minHeight: 40 },
  placeText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  removeBtn: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  empty: { textAlign: "center", color: colors.slate400, fontSize: 13, marginVertical: 16 },
  error: { fontSize: 12, color: colors.red600, marginTop: 6 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.orange100, borderRadius: 10, padding: 10, marginTop: 8 },
  errorBoxText: { flex: 1, fontSize: 12, color: colors.orange700, lineHeight: 16 },
  footerRow: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, minHeight: 48, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnGhost: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  btnGhostText: { fontSize: 15, fontWeight: "600", color: colors.slate700 },
  btnPrimary: { backgroundColor: colors.blue600 },
  btnPrimaryText: { fontSize: 15, fontWeight: "700", color: "#fff" },
});
