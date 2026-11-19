import { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Alert } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { PdfPreview } from "./pdf-preview";
import {
  buildReportSelection,
  loadJobReportDraft,
  previewJobReport,
  writePreviewFile,
  MAX_REPORT_NOTES_CHARS,
  MAX_REPORT_PHOTOS,
  type JobReportDraft,
  type JobReportRequest,
} from "../../lib/invoiceSend";

// The phone's "Include job report and photos" panel, mirroring the web
// dialog's (components/invoice/job-report-options.tsx): the draft from
// GET /api/invoices/[id]/job-report, the work-done text (edited in a
// KeyboardSheet), photos ticked by default, the customer sign-off, and
// "Preview report". Reports the selection through onChange — null while the
// draft is loading or failed, so the screen cannot send a half-built one.

function fmtDay(iso: string, year = false): string {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
}

export function JobReportOptions({
  invoiceId,
  invoiceNumber,
  onChange,
}: {
  invoiceId: string;
  invoiceNumber: number | string;
  onChange: (selection: JobReportRequest | null) => void;
}) {
  const [draft, setDraft] = useState<JobReportDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeSignature, setIncludeSignature] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ uri: string; base64: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const d = await loadJobReportDraft(invoiceId);
        if (cancelled) return;
        setDraft(d);
        setNotes(d.defaultNotes);
        setSelected(new Set(d.photos.map((p) => p.id)));
        setIncludeSignature(!!d.signature);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not load the job report.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invoiceId, attempt]);

  useEffect(() => {
    onChange(draft ? buildReportSelection(draft, notes, selected, includeSignature) : null);
  }, [draft, notes, selected, includeSignature, onChange]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runPreview() {
    if (!draft) return;
    setPreviewing(true);
    try {
      const { base64, notice } = await previewJobReport(invoiceId, buildReportSelection(draft, notes, selected, includeSignature));
      const uri = await writePreviewFile(invoiceNumber, base64);
      setPreview({ uri, base64 });
      if (notice) Alert.alert("Some photos left out", notice);
    } catch (e) {
      Alert.alert("Couldn't make the preview", e instanceof Error ? e.message : "The job report could not be made.");
    } finally {
      setPreviewing(false);
    }
  }

  if (loadError) {
    return (
      <View style={[styles.panel, styles.errorPanel]}>
        <Text style={styles.errorText}>{loadError}</Text>
        <TouchableOpacity
          style={styles.smallBtn}
          onPress={() => {
            setDraft(null);
            setAttempt((n) => n + 1);
          }}
        >
          <Text style={styles.smallBtnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!draft) {
    return (
      <View style={styles.loadingRow}>
        <ActivityIndicator size="small" color={colors.blue600} />
        <Text style={styles.muted}>Loading the job report…</Text>
      </View>
    );
  }

  const selectedCount = draft.photos.filter((p) => selected.has(p.id)).length;

  return (
    <View style={styles.panel}>
      <View style={styles.section}>
        <Text style={styles.label}>Dates attended</Text>
        {draft.visits.length === 0 ? (
          <Text style={styles.muted}>No site visits recorded on this job.</Text>
        ) : (
          draft.visits.map((v) => (
            <Text key={v.date} style={styles.body}>
              <Text style={styles.bold}>{v.label}</Text>
              {v.names.length > 0 ? ` — ${v.names.join(", ")}` : ""}
            </Text>
          ))
        )}
        <Text style={styles.hint}>Days and names only — the report never shows hours or prices.</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Work carried out</Text>
          <TouchableOpacity
            onPress={() => {
              setEditText(notes);
              setEditing(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Edit work carried out"
            hitSlop={8}
          >
            <Text style={styles.link}>Edit</Text>
          </TouchableOpacity>
        </View>
        <Text style={notes.trim() ? styles.body : styles.muted} numberOfLines={8}>
          {notes.trim() || "Nothing written yet."}
        </Text>
        <Text style={styles.hint}>
          Filled in from the stage notes, voice report and completion notes. Edit before sending — the customer sees exactly this.
        </Text>
      </View>

      <View style={styles.section}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>
            Photos ({selectedCount} of {draft.photos.length} ticked)
          </Text>
          {draft.photos.length > 0 && (
            <View style={styles.row}>
              <TouchableOpacity onPress={() => setSelected(new Set(draft.photos.map((p) => p.id)))} hitSlop={6}>
                <Text style={styles.link}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSelected(new Set())} hitSlop={6}>
                <Text style={styles.link}>None</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        {draft.photos.length === 0 ? (
          <Text style={styles.muted}>No photos on this job.</Text>
        ) : (
          <View style={styles.grid}>
            {draft.photos.map((p) => {
              const on = selected.has(p.id);
              return (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => toggle(p.id)}
                  style={[styles.tile, on ? styles.tileOn : styles.tileOff]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${on ? "Remove" : "Include"} photo${p.caption ? `: ${p.caption}` : ""}`}
                >
                  {p.thumbUrl ? (
                    <Image source={{ uri: p.thumbUrl, cacheKey: `job-report-thumb-${p.id}` }} style={styles.thumb} contentFit="cover" />
                  ) : (
                    <View style={[styles.thumb, styles.noThumb]} />
                  )}
                  <View style={styles.tick}>
                    <Ionicons name={on ? "checkbox" : "square-outline"} size={20} color={on ? colors.blue600 : colors.white} />
                  </View>
                  <Text style={styles.caption} numberOfLines={1}>
                    {p.caption?.trim() || fmtDay(p.createdAt)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        {selectedCount > MAX_REPORT_PHOTOS && (
          <Text style={styles.warn}>Only the first {MAX_REPORT_PHOTOS} ticked photos fit in one report.</Text>
        )}
        {draft.unsupportedPhotos > 0 && (
          <Text style={styles.hint}>
            {draft.unsupportedPhotos} photo{draft.unsupportedPhotos === 1 ? " is" : "s are"} in a format the report can&apos;t show (e.g. HEIC) and{" "}
            {draft.unsupportedPhotos === 1 ? "is" : "are"} left out.
          </Text>
        )}
      </View>

      {draft.signature ? (
        <TouchableOpacity
          style={styles.sigRow}
          onPress={() => setIncludeSignature((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: includeSignature }}
        >
          <Ionicons name={includeSignature ? "checkbox" : "square-outline"} size={22} color={colors.blue600} />
          {draft.signature.url ? (
            <Image source={{ uri: draft.signature.url }} style={styles.sigImage} contentFit="contain" />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={styles.body}>Include customer sign-off</Text>
            <Text style={styles.hint}>
              {draft.signature.signerName?.trim() || "Customer"} · {fmtDay(draft.signature.createdAt, true)}
            </Text>
          </View>
        </TouchableOpacity>
      ) : (
        <Text style={styles.hint}>No customer sign-off on this job.</Text>
      )}

      <TouchableOpacity style={styles.previewBtn} onPress={runPreview} disabled={previewing} accessibilityRole="button">
        {previewing ? <ActivityIndicator size="small" color={colors.blue600} /> : <Ionicons name="eye-outline" size={16} color={colors.blue600} />}
        <Text style={styles.previewText}>{previewing ? "Making preview…" : "Preview report"}</Text>
      </TouchableOpacity>

      <KeyboardSheet
        visible={editing}
        onRequestClose={() => setEditing(false)}
        title="Work carried out"
        footer={
          <View style={styles.row}>
            <TouchableOpacity style={[styles.sheetBtn, styles.sheetCancel]} onPress={() => setEditing(false)}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sheetBtn, styles.sheetSave]}
              onPress={() => {
                setNotes(editText.replace(/\r\n/g, "\n"));
                setEditing(false);
              }}
            >
              <Text style={styles.sheetSaveText}>Done</Text>
            </TouchableOpacity>
          </View>
        }
      >
        <TextInput
          value={editText}
          onChangeText={setEditText}
          multiline
          maxLength={MAX_REPORT_NOTES_CHARS}
          placeholder="What was done on the job. Sent exactly as written here."
          placeholderTextColor={colors.slate400}
          style={styles.input}
          textAlignVertical="top"
        />
        <Text style={styles.hint}>
          {editText.length.toLocaleString("en-AU")} / {MAX_REPORT_NOTES_CHARS.toLocaleString("en-AU")} characters
        </Text>
      </KeyboardSheet>

      <PdfPreview
        visible={!!preview}
        title={`Job report ${invoiceNumber}`}
        fileUri={preview?.uri ?? null}
        base64={preview?.base64 ?? null}
        onClose={() => setPreview(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, gap: 14, backgroundColor: colors.bg },
  errorPanel: { borderColor: colors.red100, backgroundColor: colors.red100, gap: 8 },
  errorText: { fontSize: 13, color: colors.red600 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  section: { gap: 4 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  body: { fontSize: 14, color: colors.slate700, lineHeight: 20 },
  bold: { fontWeight: "700", color: colors.slate900 },
  muted: { fontSize: 13, color: colors.slate500 },
  hint: { fontSize: 11, color: colors.slate400 },
  warn: { fontSize: 12, color: colors.yellow700 },
  link: { fontSize: 14, fontWeight: "700", color: colors.blue600 },
  row: { flexDirection: "row", alignItems: "center", gap: 14 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  tile: { width: "31.5%", aspectRatio: 1, borderRadius: 8, overflow: "hidden", borderWidth: 2, backgroundColor: colors.slate100 },
  tileOn: { borderColor: colors.blue600 },
  tileOff: { borderColor: "transparent", opacity: 0.5 },
  thumb: { width: "100%", height: "100%" },
  noThumb: { backgroundColor: colors.slate100 },
  tick: { position: "absolute", top: 3, left: 3, backgroundColor: "rgba(0,0,0,0.25)", borderRadius: 4 },
  caption: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 4,
    paddingVertical: 2,
    fontSize: 10,
    color: colors.white,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sigRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  sigImage: { width: 72, height: 32, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white },
  previewBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.blue600,
    borderRadius: 8,
    paddingVertical: 10,
  },
  previewText: { fontSize: 14, fontWeight: "700", color: colors.blue600 },
  smallBtn: { alignSelf: "flex-start", borderWidth: 1, borderColor: colors.red600, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  smallBtnText: { fontSize: 13, fontWeight: "600", color: colors.red600 },
  input: {
    minHeight: 220,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    color: colors.slate900,
    backgroundColor: colors.white,
  },
  sheetBtn: { flex: 1, alignItems: "center", paddingVertical: 12, borderRadius: 10 },
  sheetCancel: { backgroundColor: colors.slate100 },
  sheetCancelText: { fontWeight: "700", color: colors.slate700 },
  sheetSave: { backgroundColor: colors.blue600 },
  sheetSaveText: { fontWeight: "700", color: colors.white },
});
