import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

// Same "office server" the voice report recorder calls
// (see components/job/voice-report.tsx) — /api/ai/polish-note on the web
// app cleans up grammar/voice-to-text artifacts via OpenAI, without
// requiring the OpenAI SDK on-device.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

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
  const [polishing, setPolishing] = useState(false);

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

  // Sends the current draft (typically dictated via the phone's own
  // voice-to-text keyboard) to the office server for AI cleanup, then drops
  // the result back into the input for the tech to review/edit — it's never
  // auto-saved, so a bad rewrite can just be edited or discarded before
  // tapping Add.
  async function handlePolish() {
    if (!content.trim() || polishing) return;
    if (!API_BASE_URL) return;
    setPolishing(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) return;
      const res = await fetch(`${API_BASE_URL}/api/ai/polish-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ text: content }),
      });
      const data = await res.json();
      if (res.ok && data.polished) setContent(data.polished);
    } catch {
      // Silently leave the draft as-is — same low-stakes failure mode as a
      // failed voice report upload elsewhere in the app.
    } finally {
      setPolishing(false);
    }
  }

  return (
    <View style={styles.container}>
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
  addButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12 },
  addButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  noteCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginBottom: 8 },
  noteHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  noteAuthor: { fontSize: 12, fontWeight: "700", color: colors.slate700 },
  noteDate: { fontSize: 11, color: colors.slate400 },
  noteContent: { fontSize: 14, color: colors.slate700 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
});
