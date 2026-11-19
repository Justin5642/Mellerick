import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, ActivityIndicator, TextInput, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { ScreenError } from "../../design/components/ScreenError";
import { openExternalUrl } from "../../lib/open-external-url";
import { useIsOfficeOrAdmin } from "../../design/guards/useRole";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { prepareImage } from "../../lib/imageUpload";
import { deleteJobDocument, documentPhotoName, setJobDocumentOfficeOnly, uploadJobDocument } from "../../lib/jobPurchaseOrders";
import { pickPhoto } from "../../lib/pickPhoto";

interface Document {
  id: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
  file_type: string | null;
  created_at: string;
  profiles: { full_name: string } | null;
  // Hidden from technicians by RLS (migration 0065) — only office/admin ever
  // receive these rows, so the label is only ever seen by them.
  office_only?: boolean;
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extLabel(fileName: string) {
  const ext = fileName.split(".").pop()?.toUpperCase() ?? "";
  return ext.length <= 4 ? ext : "FILE";
}

// Office/admin can also add a document from the phone (Nov 2026) — a photo
// from the camera or the library: the binary has no document (PDF) picker, so
// PDFs are still uploaded on the website — and mark one "Office only" (0065:
// hidden from technicians, row and file) or delete it. Those go online through
// /api/jobs/[id]/documents/** (requireOfficeOrAdmin, as the caller), never a
// direct write from this screen.
interface UploadDraft {
  uri: string;
  name: string;
  officeOnly: boolean;
}

export function JobDocumentsTab({ jobId }: { jobId: string }) {
  const isOffice = useIsOfficeOrAdmin();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [upload, setUpload] = useState<UploadDraft | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  // The query error was being destructured away, so a failed read fell through
  // to "No documents uploaded for this job yet." A technician who reads that on
  // site concludes there are no plans or permits and works without them, which
  // is worse than being told the read broke. Raised here, caught below, shown.
  const loadDocuments = useCallback(async () => {
    try {
      setError(null);
      const { data, error: queryError } = await supabase
        .from("job_documents")
        .select("*, profiles(full_name)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      setDocuments((data as unknown as Document[]) ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Clearing the spinner in `finally` rather than on the line after the await:
  // a throw on the way to the signed URL used to leave this row turning forever
  // with nothing said. The storage error keeps its own name now that the
  // component has an `error` of its own.
  async function handleOpen(doc: Document) {
    setOpeningId(doc.id);
    try {
      const { data, error: urlError } = await supabase.storage.from("job-documents").createSignedUrl(doc.storage_path, 300);
      if (urlError || !data?.signedUrl) {
        Alert.alert("Couldn't open document", urlError?.message ?? "Please try again.");
        return;
      }
      void openExternalUrl(data.signedUrl, "this document");
    } catch (e) {
      Alert.alert("Couldn't open document", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setOpeningId(null);
    }
  }

  async function startUpload(source: "camera" | "library") {
    const uri = await pickPhoto(source);
    if (uri) setUpload({ uri, name: "", officeOnly: false });
  }

  async function saveUpload() {
    if (!upload || uploading) return;
    setUploading(true);
    try {
      const { base64 } = await prepareImage(upload.uri, { base64: true });
      if (!base64) throw new Error("Couldn't prepare the photo — take it again.");
      await uploadJobDocument(jobId, { file: base64, fileName: documentPhotoName(upload.name), officeOnly: upload.officeOnly });
      setUpload(null);
      await loadDocuments();
    } catch (e) {
      Alert.alert("Not uploaded", e instanceof Error ? e.message : "Try again.");
    } finally {
      setUploading(false);
    }
  }

  async function toggleOfficeOnly(doc: Document) {
    setBusyId(doc.id);
    try {
      const { officeOnly } = await setJobDocumentOfficeOnly(jobId, doc.id, !doc.office_only);
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, office_only: officeOnly } : d)));
    } catch (e) {
      Alert.alert("Not changed", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusyId(null);
    }
  }

  function confirmDelete(doc: Document) {
    Alert.alert(`Delete ${doc.file_name}?`, "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusyId(doc.id);
          try {
            const res = await deleteJobDocument(jobId, doc.id);
            setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
            if (res.warning) Alert.alert("Deleted", res.warning);
          } catch (e) {
            Alert.alert("Not deleted", e instanceof Error ? e.message : "Try again.");
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.blue600} />
      </View>
    );
  }

  // Checked BEFORE the list, so a broken read can never render as an empty
  // document set.
  if (error) {
    return (
      <View style={styles.container}>
        <ScreenError error={error} onRetry={() => { setLoading(true); void loadDocuments(); }} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>Plans, specs, permits &amp; compliance certificates for this job.</Text>
      {isOffice && (
        <View style={styles.uploadRow}>
          <TouchableOpacity style={styles.uploadBtn} onPress={() => void startUpload("camera")}>
            <Ionicons name="camera-outline" size={16} color={colors.blue600} />
            <Text style={styles.uploadText}>Take photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.uploadBtn} onPress={() => void startUpload("library")}>
            <Ionicons name="image-outline" size={16} color={colors.blue600} />
            <Text style={styles.uploadText}>Add photo</Text>
          </TouchableOpacity>
        </View>
      )}
      <FlatList
        data={documents}
        keyExtractor={(d) => d.id}
        scrollEnabled={false}
        contentContainerStyle={{ gap: 8, marginTop: 10 }}
        ListEmptyComponent={<Text style={styles.emptyText}>No documents uploaded for this job yet.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => handleOpen(item)} disabled={openingId === item.id}>
            <View style={styles.iconBox}>
              {openingId === item.id ? (
                <ActivityIndicator size="small" color={colors.blue600} />
              ) : (
                <Text style={styles.iconText}>{extLabel(item.file_name)}</Text>
              )}
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.fileName} numberOfLines={1}>
                {item.office_only ? "🔒 " : ""}{item.file_name}
              </Text>
              <Text style={styles.fileMeta}>
                {[formatBytes(item.file_size), item.profiles?.full_name, new Date(item.created_at).toLocaleDateString("en-AU")]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            {isOffice && (
              <>
                <TouchableOpacity
                  onPress={() => void toggleOfficeOnly(item)}
                  disabled={busyId === item.id}
                  hitSlop={8}
                  accessibilityLabel={item.office_only ? "Office only — tap to show technicians" : "Visible to technicians — tap to make office only"}
                >
                  {busyId === item.id ? (
                    <ActivityIndicator size="small" color={colors.blue600} />
                  ) : (
                    <Ionicons name={item.office_only ? "lock-closed" : "lock-open-outline"} size={20} color={item.office_only ? colors.orange700 : colors.slate400} />
                  )}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => confirmDelete(item)} disabled={busyId === item.id} hitSlop={8} accessibilityLabel={`Delete ${item.file_name}`}>
                  <Ionicons name="trash-outline" size={20} color={colors.slate400} />
                </TouchableOpacity>
              </>
            )}
            <Ionicons name="open-outline" size={20} color={colors.blue600} />
          </TouchableOpacity>
        )}
      />
      {upload && (
        <KeyboardSheet
          visible
          onRequestClose={() => !uploading && setUpload(null)}
          title="Add document"
          footer={
            <View style={styles.sheetButtons}>
              <TouchableOpacity style={[styles.sheetBtn, styles.sheetCancel]} onPress={() => setUpload(null)} disabled={uploading}>
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.sheetBtn, styles.sheetSave]} onPress={() => void saveUpload()} disabled={uploading}>
                {uploading ? <ActivityIndicator color={colors.white} /> : <Text style={styles.sheetSaveText}>Upload</Text>}
              </TouchableOpacity>
            </View>
          }
        >
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={upload.name}
            onChangeText={(name) => setUpload({ ...upload, name })}
            placeholder="e.g. Plumbing plan sheet 2"
          />
          <View style={styles.switchRow}>
            <View style={styles.rowContent}>
              <Text style={styles.label}>Office only</Text>
              <Text style={styles.fileMeta}>Hidden from technicians — for anything with prices.</Text>
            </View>
            <Switch value={upload.officeOnly} onValueChange={(officeOnly) => setUpload({ ...upload, officeOnly })} />
          </View>
        </KeyboardSheet>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  center: { paddingVertical: 30, alignItems: "center" },
  hint: { fontSize: 12, color: colors.slate500 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: colors.blue100,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { fontSize: 10, fontWeight: "700", color: colors.blue600 },
  rowContent: { flex: 1 },
  fileName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  fileMeta: { fontSize: 11, color: colors.slate500, marginTop: 2 },
  uploadRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  uploadBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.blue100, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.card },
  uploadText: { fontSize: 13, fontWeight: "600", color: colors.blue600 },
  label: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, color: colors.slate900, backgroundColor: colors.card },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14 },
  sheetButtons: { flexDirection: "row", gap: 10 },
  sheetBtn: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 8, paddingVertical: 12 },
  sheetCancel: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  sheetCancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  sheetSave: { backgroundColor: colors.blue600 },
  sheetSaveText: { color: colors.white, fontWeight: "700", fontSize: 14 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
});
