import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { useJobNotes } from "../../lib/data/hooks/useJobNotes";
import { useJobStageNotes } from "../../lib/data/hooks/useJobStageNotes";
import { JOB_STAGES, getJobStageLabel, getCurrentStageNote } from "../../lib/job-stages";
import { ScreenError } from "../../design/components/ScreenError";
import { unwrapRows } from "../../lib/data/reads/unwrap";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";
import { useDataLayer } from "../../lib/data/DataProvider";
import { useSyncSettled } from "../../lib/data/hooks/useSyncSettled";
import { reconcileRows } from "../../lib/data/reconcile";
import { joinSegments, useDictation } from "../../lib/dictation";

// The "office server": /api/ai/polish-note on the web app cleans up grammar
// and voice-to-text artifacts with Claude.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

// Calls the polish route and returns the cleaned text. Throws an Error whose
// message is fit to show the technician.
async function polishOnServer(text: string): Promise<string> {
  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/ai/polish-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new Error("Check your connection and try again.");
  }
  // A non-JSON body (e.g. a platform error page) must still surface the HTTP
  // status rather than throwing a parse error.
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.polished) return data.polished as string;
  throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
}

interface Note {
  id: string;
  content: string;
  created_at: string;
  profiles: { full_name: string } | null;
  source?: string | null;
}

interface StageNote extends Note {
  stage: string;
}

// A provisional note shown the instant it's queued (also the offline path). It
// carries the same client id as the queued write, so the real row replaces it
// on the next online reload with no duplicate.
function optimisticNote(id: string, content: string): Note {
  return { id, content, created_at: new Date().toISOString(), profiles: { full_name: "You" } };
}

function optimisticStageNote(id: string, stage: string, content: string): StageNote {
  return { id, stage, content, created_at: new Date().toISOString(), profiles: { full_name: "You" } };
}

// readOnly: a technician viewing a job they are not assigned to (opened from
// Search). Migration 0074 (a draft, not applied yet) makes the database refuse
// their notes there; until then they would still save. Either way the
// composers are hidden rather than letting a note fail to sync later.
export function JobNotesTab({ jobId, currentUserId, readOnly = false }: { jobId: string; currentUserId: string; readOnly?: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const notesComposer = useJobNotes();
  const layer = useDataLayer();

  const [stageNotes, setStageNotes] = useState<StageNote[]>([]);
  const [stageContent, setStageContent] = useState("");
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [stageSaving, setStageSaving] = useState(false);
  const [stageError, setStageError] = useState<unknown>(null);
  const [stageTranscribing, setStageTranscribing] = useState(false);
  const stageNotesComposer = useJobStageNotes();

  // Voice-to-text for stage notes, on the phone itself (lib/dictation.ts):
  // words appear in the box as the technician talks; on Stop the dictated
  // part gets the same AI polish as "Polish with AI" below when online (raw
  // dictation otherwise — it is still a usable note). Never auto-saved, so a
  // bad transcription can just be edited or re-dictated.
  const stageDictation = useDictation(async ({ text }) => {
    if (!text) {
      Alert.alert("Didn't catch that", "No speech was recognised. Try again, or type the note.");
      return;
    }
    let finalText = text;
    if (await netInfoConnectivity.isOnline()) {
      setStageTranscribing(true);
      try {
        finalText = await polishOnServer(text);
      } catch {
        // Keep the raw dictation; the tech can still tap Polish later.
      } finally {
        setStageTranscribing(false);
      }
    }
    setStageContent((prev) => joinSegments(prev, finalText));
  });

  async function startStageDictation() {
    await stageDictation.start({ online: await netInfoConnectivity.isOnline() });
  }

  const loadStageNotes = useCallback(async () => {
    try {
      setStageError(null);
      if (!(await netInfoConnectivity.isOnline())) return;
      const res = await supabase
        .from("job_stage_notes")
        .select("*, profiles(full_name)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false });
      const rows = unwrapRows(res as never, "JobNotesTab.loadStageNotes") as unknown as StageNote[];
      const pending = layer ? await layer.outbox.pendingRowIds() : new Set<string>();
      setStageNotes((prev) => reconcileRows(prev, rows, pending));
    } catch (e) {
      setStageError(e);
    }
  }, [jobId, layer]);

  useEffect(() => {
    void loadStageNotes();
  }, [loadStageNotes]);

  useSyncSettled(loadStageNotes);

  async function handleAddStageNote() {
    if (!stageContent.trim() || !selectedStage || stageSaving || !stageNotesComposer.ready) return;
    setStageSaving(true);
    try {
      const text = stageContent.trim();
      const stage = selectedStage;
      const { id } = await stageNotesComposer.addNote({ jobId, stage, authorId: currentUserId, content: text });
      setStageNotes((prev) => [optimisticStageNote(id, stage, text), ...prev]);
      setStageContent("");
    } finally {
      setStageSaving(false);
    }
  }

  // Grouped by stage in the fixed workflow order, not by timestamp, so a
  // technician can pull up everything logged at (say) the drain stage in one
  // place instead of scrolling a single interleaved feed.
  const stageNotesByStage = useMemo(() => {
    const map = new Map<string, StageNote[]>();
    for (const s of JOB_STAGES) map.set(s.value, []);
    for (const note of stageNotes) {
      if (!map.has(note.stage)) map.set(note.stage, []);
      map.get(note.stage)!.push(note);
    }
    return map;
  }, [stageNotes]);
  const stagesToShow = stageFilter ? JOB_STAGES.filter((s) => s.value === stageFilter) : JOB_STAGES;

  // "Where the last person left off" — the single most recent stage note
  // across all stages, surfaced above the composer so a tech opening this
  // job sees current status without reading the full history.
  const currentStageNote = useMemo(() => getCurrentStageNote(stageNotes), [stageNotes]);

  // Reads refresh from the server only when online; offline, local state (incl.
  // the optimistic note just queued) is authoritative. Even online we MERGE, so
  // an optimistic note whose write is still pending survives a racing reload.
  //
  // A failed load must NOT land here as an empty list: this tab renders "No
  // notes yet", and a technician who reads that when the query actually broke
  // concludes the job has no history — then re-dictates a note that already
  // exists, or acts on a site with defects nobody told them about. So the query
  // error is raised rather than destructured away, and every rejection on this
  // path (the connectivity probe and the outbox scan included) is caught into
  // `error`, which the render checks before it draws the list.
  const loadNotes = useCallback(async () => {
    try {
      setError(null);
      if (!(await netInfoConnectivity.isOnline())) return;
      const res = await supabase
        .from("job_notes")
        .select("*, profiles(full_name)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false });
      const rows = unwrapRows(res as never, "JobNotesTab.loadNotes") as unknown as Note[];
      const pending = layer ? await layer.outbox.pendingRowIds() : new Set<string>();
      setNotes((prev) => reconcileRows(prev, rows, pending));
    } catch (e) {
      setError(e);
    }
  }, [jobId, layer]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  // Reconcile after each sync drain completes (the note has actually landed).
  useSyncSettled(loadNotes);

  async function handleAdd() {
    if (!content.trim() || saving || !notesComposer.ready) return;
    setSaving(true);
    try {
      const text = content.trim();
      const { id } = await notesComposer.addNote({ jobId, authorId: currentUserId, content: text });
      // Optimistic: show immediately (also the offline path). The server row
      // reconciles in via useSyncSettled once the write lands.
      setNotes((prev) => [optimisticNote(id, text), ...prev]);
      setContent("");
    } finally {
      setSaving(false);
    }
  }

  // Sends the current draft (typically dictated via the phone's own
  // voice-to-text keyboard) to the office server for AI cleanup, then drops
  // the result back into the input for the tech to review/edit — it's never
  // auto-saved, so a bad rewrite can just be edited or discarded before
  // tapping Add.
  async function handlePolish() {
    if (!content.trim() || polishing) return;
    // Every failure path alerts rather than returning silently — a silent
    // no-op made a misconfigured or failing server look like a dead button.
    // The draft is always left untouched on failure.
    if (!(await netInfoConnectivity.isOnline())) {
      Alert.alert("No internet connection", "Polish needs an internet connection. You can still add the note as typed.");
      return;
    }
    setPolishing(true);
    try {
      setContent(await polishOnServer(content));
    } catch (e) {
      Alert.alert("Polish failed", e instanceof Error ? e.message : "Try again.");
    } finally {
      setPolishing(false);
    }
  }

  // Checked BEFORE the list renders, so a failed load can never fall through to
  // "No notes yet" — an empty history and a broken read must not look alike.
  // This takes the composer down with it, matching the Time tab: a note written
  // against a job whose state we failed to read is worth less than the tech
  // knowing the read is broken.
  if (error || stageError) {
    return (
      <View style={styles.container}>
        <ScreenError
          error={error ?? stageError}
          onRetry={() => { void loadNotes(); void loadStageNotes(); }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Stage Notes</Text>
      <Text style={styles.sectionSubtitle}>History by workflow stage — visible to everyone on this job</Text>

      {currentStageNote && (
        <View style={styles.currentStageBanner}>
          <View style={styles.currentStageBadge}>
            <Text style={styles.currentStageBadgeText}>Currently at: {getJobStageLabel(currentStageNote.stage)}</Text>
          </View>
          <Text style={styles.currentStageContent} numberOfLines={2}>{currentStageNote.content}</Text>
          <Text style={styles.currentStageMeta}>
            {currentStageNote.profiles?.full_name ?? "Unknown"} ·{" "}
            {new Date(currentStageNote.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}{" "}
            {new Date(currentStageNote.created_at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      )}

      {!readOnly && (
        <>
      <View style={styles.chipRow}>
        {JOB_STAGES.map((s) => (
          <TouchableOpacity
            key={s.value}
            style={[styles.chip, selectedStage === s.value && styles.chipActive]}
            onPress={() => setSelectedStage(s.value)}
          >
            <Text style={[styles.chipText, selectedStage === s.value && styles.chipTextActive]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={stageDictation.listening ? joinSegments(stageContent, stageDictation.text) : stageContent}
          onChangeText={setStageContent}
          editable={!stageDictation.listening}
          placeholder={selectedStage ? `Add a note for the ${getJobStageLabel(selectedStage)} stage${stageDictation.available ? ", or tap Record note" : ""}...` : "Pick a stage above first..."}
          multiline
        />
        {stageDictation.error && <Text style={styles.dictationError}>{stageDictation.error}</Text>}
        <View style={styles.buttonRow}>
          {stageDictation.available && (
            <TouchableOpacity
              style={[styles.polishButton, stageDictation.listening && styles.recordButtonActive]}
              onPress={stageDictation.listening ? stageDictation.stop : startStageDictation}
              disabled={stageTranscribing}
            >
              {stageTranscribing ? (
                <ActivityIndicator size="small" color={colors.blue600} />
              ) : (
                <Ionicons
                  name={stageDictation.listening ? "stop-circle" : "mic"}
                  size={14}
                  color={stageDictation.listening ? "#fff" : colors.blue600}
                />
              )}
              <Text style={[styles.polishButtonText, stageDictation.listening && styles.recordButtonTextActive]}>
                {stageTranscribing ? "Polishing..." : stageDictation.listening ? "Stop" : "Record note"}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.addButton}
            onPress={handleAddStageNote}
            disabled={stageSaving || !stageContent.trim() || !selectedStage}
          >
            <Text style={styles.addButtonText}>{stageSaving ? "..." : "Add stage note"}</Text>
          </TouchableOpacity>
        </View>
      </View>

        </>
      )}

      <View style={styles.chipRow}>
        <TouchableOpacity style={[styles.chip, stageFilter === null && styles.chipActive]} onPress={() => setStageFilter(null)}>
          <Text style={[styles.chipText, stageFilter === null && styles.chipTextActive]}>All stages</Text>
        </TouchableOpacity>
        {JOB_STAGES.map((s) => (
          <TouchableOpacity
            key={s.value}
            style={[styles.chip, stageFilter === s.value && styles.chipActive]}
            onPress={() => setStageFilter(s.value)}
          >
            <Text style={[styles.chipText, stageFilter === s.value && styles.chipTextActive]}>
              {s.label} ({stageNotesByStage.get(s.value)?.length ?? 0})
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {stageNotes.length === 0 ? (
        <Text style={styles.emptyText}>No stage notes yet — pick a stage above to log the first one.</Text>
      ) : (
        stagesToShow.map((stage) => {
          const items = stageNotesByStage.get(stage.value) ?? [];
          if (items.length === 0) return null;
          return (
            <View key={stage.value} style={styles.stageGroup}>
              <Text style={styles.stageGroupLabel}>{stage.label}</Text>
              {items.map((note) => (
                <View key={note.id} style={styles.noteCard}>
                  <View style={styles.noteHeader}>
                    <Text style={styles.noteAuthor}>{note.profiles?.full_name ?? "Unknown"}</Text>
                    <Text style={styles.noteDate}>
                      {new Date(note.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}{" "}
                      {new Date(note.created_at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                  <Text style={styles.noteContent}>{note.content}</Text>
                </View>
              ))}
            </View>
          );
        })
      )}

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Notes & Activity</Text>
      <Text style={styles.sectionSubtitle}>General job log visible to all staff</Text>

      {!readOnly && (
        <>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={content}
          onChangeText={setContent}
          placeholder="Add a note, or dictate one with your keyboard's mic then tap Polish..."
          multiline
        />
        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.polishButton} onPress={handlePolish} disabled={polishing || !content.trim()}>
            {polishing ? (
              <ActivityIndicator size="small" color={colors.blue600} />
            ) : (
              <Ionicons name="sparkles" size={14} color={colors.blue600} />
            )}
            <Text style={styles.polishButtonText}>{polishing ? "Polishing..." : "Polish with AI"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.addButton} onPress={handleAdd} disabled={saving || !content.trim()}>
            <Text style={styles.addButtonText}>{saving ? "..." : "Add"}</Text>
          </TouchableOpacity>
        </View>
      </View>
        </>
      )}

      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        scrollEnabled={false}
        ListEmptyComponent={<Text style={styles.emptyText}>No notes yet</Text>}
        renderItem={({ item }) => (
          <View style={styles.noteCard}>
            <View style={styles.noteHeader}>
              <Text style={styles.noteAuthor}>{item.profiles?.full_name ?? "Unknown"}</Text>
              <Text style={styles.noteDate}>
                {new Date(item.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}{" "}
                {new Date(item.created_at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
              </Text>
            </View>
            {item.source === "schedule" && (
              <View style={styles.scheduleTag}>
                <Text style={styles.scheduleTagText}>Scheduling note — also shown on Overview</Text>
              </View>
            )}
            <Text style={styles.noteContent}>{item.content}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  sectionSubtitle: { fontSize: 12, color: colors.slate400, marginBottom: 12 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipActive: { backgroundColor: colors.slate900, borderColor: colors.slate900 },
  chipText: { fontSize: 12, color: colors.slate700 },
  chipTextActive: { color: "#fff" },
  currentStageBanner: { backgroundColor: colors.blue100, borderRadius: 10, padding: 10, marginBottom: 12, gap: 4 },
  currentStageBadge: { alignSelf: "flex-start", backgroundColor: colors.blue600, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  currentStageBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  currentStageContent: { fontSize: 12, color: colors.slate700 },
  currentStageMeta: { fontSize: 11, color: colors.slate400 },
  stageGroup: { marginBottom: 12 },
  stageGroupLabel: { fontSize: 12, fontWeight: "700", color: colors.slate700, marginBottom: 6 },
  composer: { gap: 8, marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: colors.card,
    color: colors.slate900,
    minHeight: 44,
  },
  buttonRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  polishButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  polishButtonText: { color: colors.slate700, fontWeight: "600", fontSize: 13 },
  recordButtonActive: { backgroundColor: colors.red600, borderColor: colors.red600 },
  recordButtonTextActive: { color: "#fff" },
  dictationError: { color: colors.red600, fontSize: 12, marginTop: 6 },
  addButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12 },
  addButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  noteCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginBottom: 8 },
  noteHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  scheduleTag: { alignSelf: "flex-start", backgroundColor: colors.blue100, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginBottom: 4 },
  scheduleTagText: { fontSize: 10, fontWeight: "700", color: colors.blue600 },
  noteAuthor: { fontSize: 12, fontWeight: "700", color: colors.slate700 },
  noteDate: { fontSize: 11, color: colors.slate400 },
  noteContent: { fontSize: 14, color: colors.slate700 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
});
