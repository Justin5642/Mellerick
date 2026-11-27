import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, Modal, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Crypto from "expo-crypto";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { prepareImage } from "../../lib/imageUpload";
import { documentPickerAvailable, isPickedImage, isPickedPdf, pickDocuments, readPickedBase64, type PickedFile } from "../../lib/documentPicker";
import { base64Bytes, cleanAttachmentName } from "../../lib/invoiceAttachments";
import {
  addAttachment,
  attachmentsTotal,
  downloadAsBase64,
  formatBytes,
  isAttachableName,
  photoAttachmentName,
  ATTACHMENT_HINT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type PhoneAttachment,
} from "../../lib/invoiceSend";

// Attachments on the phone's Send Invoice screen, mirroring the web drop zone
// (components/invoice/invoice-attachments-field.tsx) with what the app binary
// can reach WITHOUT a new native module:
//  - photos from the library or the camera (expo-image-picker), shrunk first
//    by lib/imageUpload.ts, as the web shrinks them in the browser;
//  - the job's own documents (PDFs, Word, Excel… from the Documents tab),
//    downloaded from Storage;
//  - any other file on the phone (a PDF in Files / Downloads…) through
//    expo-document-picker (Nov 2026; loaded lazily — a binary built before it
//    was added hides the "Files" button).
// Same limits as the web: 10 files, 3 MB in total (lib/invoiceAttachments.ts).

interface JobDoc {
  id: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
}

export function InvoiceAttachmentsField({
  value,
  onChange,
  jobId,
  disabled,
}: {
  value: PhoneAttachment[];
  onChange: (next: PhoneAttachment[]) => void;
  /** The invoice's job — its documents can be attached. */
  jobId: string | null;
  disabled?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<JobDoc[] | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const total = attachmentsTotal(value);

  /** Adds files one by one, as the web field does; each refusal is said and the rest still go in. */
  function addAll(files: PhoneAttachment[]) {
    let next = value;
    const errors: string[] = [];
    for (const f of files) {
      const r = addAttachment(next, f);
      if (r.ok) next = r.list;
      else errors.push(r.error);
    }
    onChange(next);
    if (errors.length) Alert.alert("Not attached", errors.join("\n"));
  }

  async function photoToAttachment(asset: ImagePicker.ImagePickerAsset, n: number): Promise<PhoneAttachment> {
    try {
      const img = await prepareImage(asset.uri, { base64: true });
      const content = img.base64 ?? "";
      return { id: Crypto.randomUUID(), filename: photoAttachmentName(asset.fileName, n), content, bytes: base64Bytes(content) };
    } catch {
      // Couldn't be re-encoded: send the original, as the web does for HEIC.
      const content = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      const name = cleanAttachmentName(asset.fileName ?? "") || `photo-${n}.jpg`;
      return { id: Crypto.randomUUID(), filename: name, content, bytes: base64Bytes(content) };
    }
  }

  async function pickPhotos(fromCamera: boolean) {
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", fromCamera ? "Camera access is required" : "Photo library access is required");
      return;
    }
    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsMultipleSelection: true, mediaTypes: ["images"] });
    if (result.canceled || !result.assets?.length) return;
    setBusy(true);
    try {
      const files: PhoneAttachment[] = [];
      for (const asset of result.assets) files.push(await photoToAttachment(asset, value.length + files.length + 1));
      addAll(files);
    } catch (e) {
      Alert.alert("Couldn't add photo", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /** A file from the phone: refused by name/size before it is read; a photo is shrunk like the others. */
  async function fileToAttachment(file: PickedFile, n: number): Promise<PhoneAttachment> {
    if (isPickedImage(file) && !isPickedPdf(file)) {
      try {
        const img = await prepareImage(file.uri, { base64: true });
        const content = img.base64 ?? "";
        if (content) return { id: Crypto.randomUUID(), filename: photoAttachmentName(file.name, n), content, bytes: base64Bytes(content) };
      } catch {
        // Couldn't be re-encoded (HEIC on an old phone…): send the original.
      }
    }
    const content = await readPickedBase64(file);
    return { id: Crypto.randomUUID(), filename: cleanAttachmentName(file.name) || `file-${n}`, content, bytes: base64Bytes(content) };
  }

  async function pickFiles() {
    let files: PickedFile[] | null;
    try {
      files = await pickDocuments({ multiple: true });
    } catch (e) {
      Alert.alert("Couldn't open your files", e instanceof Error ? e.message : "Please try again.");
      return;
    }
    if (!files) return;
    setBusy(true);
    try {
      const ready: PhoneAttachment[] = [];
      const refused: string[] = [];
      let room = MAX_ATTACHMENT_TOTAL_BYTES - total;
      for (const f of files) {
        if (!isPickedImage(f) && !isAttachableName(f.name)) {
          refused.push(`${f.name} can't be attached (${ATTACHMENT_HINT})`);
          continue;
        }
        // Known size first, so a file that can't fit isn't read for nothing (photos are shrunk, so they may still fit).
        if (f.size != null && f.size > room && !isPickedImage(f)) {
          refused.push(`${f.name} (${formatBytes(f.size)}) would take the attachments over ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}`);
          continue;
        }
        const a = await fileToAttachment(f, value.length + ready.length + 1);
        room -= a.bytes;
        ready.push(a);
      }
      addAll(ready);
      if (refused.length) Alert.alert("Not attached", refused.join("\n"));
    } catch (e) {
      Alert.alert("Couldn't add the file", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function openDocs() {
    if (!jobId) return;
    setDocsOpen(true);
    if (docs) return;
    try {
      const { data, error } = await supabase
        .from("job_documents")
        .select("id, storage_path, file_name, file_size")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setDocs(((data as JobDoc[] | null) ?? []).filter((d) => isAttachableName(d.file_name)));
    } catch (e) {
      setDocsOpen(false);
      Alert.alert("Couldn't load the job's documents", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function addDoc(doc: JobDoc) {
    // Known size first, so a file that can't fit isn't downloaded for nothing.
    if (doc.file_size != null && total + doc.file_size > MAX_ATTACHMENT_TOTAL_BYTES) {
      Alert.alert(
        "Not attached",
        `${doc.file_name} (${formatBytes(doc.file_size)}) would take the attachments over ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}`
      );
      return;
    }
    setDocsOpen(false);
    setBusy(true);
    try {
      const { data, error } = await supabase.storage.from("job-documents").createSignedUrl(doc.storage_path, 300);
      if (error || !data?.signedUrl) throw new Error(error?.message ?? "The document could not be opened.");
      const content = await downloadAsBase64(data.signedUrl);
      addAll([{ id: Crypto.randomUUID(), filename: cleanAttachmentName(doc.file_name), content, bytes: base64Bytes(content) }]);
    } catch (e) {
      Alert.alert("Couldn't attach the document", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const off = disabled || busy;

  return (
    <View style={styles.wrap}>
      <View style={styles.buttons}>
        <SourceButton icon="images-outline" label="Photos" onPress={() => void pickPhotos(false)} disabled={off} />
        <SourceButton icon="camera-outline" label="Camera" onPress={() => void pickPhotos(true)} disabled={off} />
        {jobId ? <SourceButton icon="document-text-outline" label="Job documents" onPress={() => void openDocs()} disabled={off} /> : null}
        {documentPickerAvailable() ? <SourceButton icon="folder-open-outline" label="Files" onPress={() => void pickFiles()} disabled={off} /> : null}
      </View>
      <Text style={styles.hint}>
        {busy ? "Adding…" : documentPickerAvailable() ? `${ATTACHMENT_HINT}.` : `${ATTACHMENT_HINT}. Other files from the phone: attach them on the web.`}
      </Text>

      {value.length > 0 && (
        <View style={styles.list}>
          {value.map((a) => (
            <View key={a.id} style={styles.item}>
              <Ionicons name="document-outline" size={16} color={colors.slate500} />
              <Text style={styles.name} numberOfLines={1}>
                {a.filename}
              </Text>
              <Text style={styles.size}>{formatBytes(a.bytes)}</Text>
              <TouchableOpacity
                onPress={() => onChange(value.filter((x) => x.id !== a.id))}
                disabled={disabled}
                accessibilityLabel={`Remove ${a.filename}`}
                hitSlop={8}
              >
                <Ionicons name="close" size={18} color={colors.slate400} />
              </TouchableOpacity>
            </View>
          ))}
          <Text style={styles.total}>
            {formatBytes(total)} of {formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}
          </Text>
        </View>
      )}

      <Modal visible={docsOpen} animationType="slide" transparent onRequestClose={() => setDocsOpen(false)}>
        <View style={styles.overlay}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Attach a job document</Text>
              <TouchableOpacity onPress={() => setDocsOpen(false)} hitSlop={8}>
                <Text style={styles.link}>Close</Text>
              </TouchableOpacity>
            </View>
            {!docs ? (
              <ActivityIndicator color={colors.blue600} style={{ marginVertical: 24 }} />
            ) : docs.length === 0 ? (
              <Text style={styles.empty}>No documents on this job that can be attached.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 420 }}>
                {docs.map((d) => (
                  <TouchableOpacity key={d.id} style={styles.docRow} onPress={() => void addDoc(d)}>
                    <Ionicons name="document-attach-outline" size={18} color={colors.blue600} />
                    <Text style={styles.name} numberOfLines={1}>
                      {d.file_name}
                    </Text>
                    {d.file_size != null && <Text style={styles.size}>{formatBytes(d.file_size)}</Text>}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SourceButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity style={[styles.source, disabled && styles.disabled]} onPress={onPress} disabled={disabled} accessibilityRole="button">
      <Ionicons name={icon} size={16} color={colors.blue600} />
      <Text style={styles.sourceText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  source: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.slate400,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  sourceText: { fontSize: 14, fontWeight: "600", color: colors.blue600 },
  disabled: { opacity: 0.5 },
  hint: { fontSize: 11, color: colors.slate400 },
  list: { gap: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: colors.bg,
  },
  name: { flex: 1, fontSize: 13, color: colors.slate700 },
  size: { fontSize: 11, color: colors.slate400 },
  total: { fontSize: 11, color: colors.slate400, textAlign: "right" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 8 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  link: { fontSize: 15, fontWeight: "700", color: colors.blue600 },
  empty: { fontSize: 13, color: colors.slate500, paddingVertical: 16 },
  docRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.slate100,
  },
});
