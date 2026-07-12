import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList } from "react-native";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

interface Note {
  id: string;
  content: string;
  created_at: string;
  profiles: { full_name: string } | null;
}

export function JobNotesTab({ jobId, currentUserId }: { jobId: string; currentUserId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const loadNotes = useCallback(async () => {
    const { data } = await supabase
      .from("job_notes")
      .select("*, profiles(full_name)")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false });
    setNotes((data as any) ?? []);
  }, [jobId]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  async function handleAdd() {
    if (!content.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("job_notes").insert({
      job_id: jobId,
      author_id: currentUserId,
      content: content.trim(),
    });
    if (!error) {
      setContent("");
      await loadNotes();
    }
    setSaving(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          value={content}
          onChangeText={setContent}
          placeholder="Add a note..."
          multiline
        />
        <TouchableOpacity style={styles.addButton} onPress={handleAdd} disabled={saving || !content.trim()}>
          <Text style={styles.addButtonText}>{saving ? "..." : "Add"}</Text>
        </TouchableOpacity>
      </View>

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
            <Text style={styles.noteContent}>{item.content}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  addRow: { flexDirection: "row", gap: 8, alignItems: "flex-end", marginBottom: 16 },
  input: {
    flex: 1,
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
  addButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12 },
  addButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  noteCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginBottom: 8 },
  noteHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  noteAuthor: { fontSize: 12, fontWeight: "700", color: colors.slate700 },
  noteDate: { fontSize: 11, color: colors.slate400 },
  noteContent: { fontSize: 14, color: colors.slate700 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
});
