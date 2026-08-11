import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { ScreenError } from "../../design/components/ScreenError";
import { openExternalUrl } from "../../lib/open-external-url";

interface Document {
  id: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
  file_type: string | null;
  created_at: string;
  profiles: { full_name: string } | null;
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

export function JobDocumentsTab({ jobId }: { jobId: string }) {
  const [documents, setDocuments] = useState<Document[]>([]);
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
                {item.file_name}
              </Text>
              <Text style={styles.fileMeta}>
                {[formatBytes(item.file_size), item.profiles?.full_name, new Date(item.created_at).toLocaleDateString("en-AU")]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            <Ionicons name="open-outline" size={20} color={colors.blue600} />
          </TouchableOpacity>
        )}
      />
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
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
});
