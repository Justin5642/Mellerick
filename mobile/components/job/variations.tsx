import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, Alert, Image, ActivityIndicator } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { decode } from "base64-arraybuffer";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

// Mobile side of CRM spec items "Variations — Auto Approve" and
// "Variations — Manual Approval". Crew picks a standard variation type
// (preset rate, auto-approves instantly) or logs a custom one-off
// variation (goes to the office for pricing + approval before the job
// can be invoiced). Optional photo evidence uploads to the job-photos
// bucket under a `<jobId>/variations/` prefix.

// NOTE: techs must never see dollar figures (migration 0027/0028). We read
// the rate-stripped views (variation_types_public / job_variations_public) --
// the base tables carrying rate/total_amount are office/admin-only RLS -- so
// there is deliberately no `rate` / `total_amount` field here. Pricing is
// applied server-side by the apply_variation_pricing() trigger.
interface VariationType {
  id: string;
  name: string;
  unit: string;
  auto_approve: boolean;
}

interface Variation {
  id: string;
  variation_type_id: string | null;
  custom_name: string | null;
  description: string | null;
  quantity: number;
  unit: string;
  photo_storage_path: string | null;
  status: "auto_approved" | "pending_approval" | "approved" | "rejected";
  created_at: string;
}

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  auto_approved: { bg: colors.green100, text: colors.green600, label: "Auto-approved" },
  pending_approval: { bg: colors.orange100, text: colors.orange700, label: "Pending approval" },
  approved: { bg: colors.blue100, text: colors.blue600, label: "Approved" },
  rejected: { bg: colors.red100, text: colors.red600, label: "Rejected" },
};

export function JobVariationsTab({ jobId, currentUserId }: { jobId: string; currentUserId: string }) {
  const [variations, setVariations] = useState<Variation[]>([]);
  const [types, setTypes] = useState<VariationType[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [description, setDescription] = useState("");
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [{ data: v }, { data: t }] = await Promise.all([
      supabase.from("job_variations_public").select("*").eq("job_id", jobId).order("created_at", { ascending: false }),
      supabase.from("variation_types_public").select("*").eq("is_active", true).order("name"),
    ]);
    setVariations((v as any) ?? []);
    setTypes((t as any) ?? []);
    for (const item of (v as any) ?? []) {
      if (item.photo_storage_path) {
        supabase.storage
          .from("job-photos")
          .createSignedUrl(item.photo_storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed?.signedUrl) setUrls((prev) => ({ ...prev, [item.photo_storage_path]: signed.signedUrl }));
          });
      }
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  const selectedType = types.find((t) => t.id === typeId);

  async function pickPhoto(source: "camera" | "library") {
    if (source === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Camera access is required");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
      if (result.canceled || !result.assets?.length) return;
      setPhotoUri(result.assets[0].uri);
      setPhotoBase64(result.assets[0].base64 ?? null);
      return;
    }
    // Library pick -- lets a tech attach an existing photo (e.g. a screenshot
    // of a supplier quote/invoice) instead of only a fresh camera shot.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Photo library access is required");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true });
    if (result.canceled || !result.assets?.length) return;
    setPhotoUri(result.assets[0].uri);
    setPhotoBase64(result.assets[0].base64 ?? null);
  }

  async function submit() {
    const qty = parseFloat(quantity) || 0;
    if (!typeId && !customName.trim()) {
      Alert.alert("Missing info", "Pick a variation type or name a custom one.");
      return;
    }
    setSaving(true);

    let photoPath: string | null = null;
    if (photoBase64) {
      photoPath = `${jobId}/variations/${Date.now()}.jpg`;
      const { error: uploadErr } = await supabase.storage.from("job-photos").upload(photoPath, decode(photoBase64), {
        contentType: "image/jpeg",
      });
      if (uploadErr) {
        Alert.alert("Photo upload failed", uploadErr.message);
        setSaving(false);
        return;
      }
    }

    const autoApprove = !!selectedType?.auto_approve;
    const unit = selectedType?.unit ?? "unit";

    // Pricing is applied server-side by the apply_variation_pricing() trigger
    // (migration 0028) -- we intentionally never send rate / total_amount /
    // status so a tech can neither see nor set a figure. The trigger fills the
    // preset rate for auto-approve types and leaves custom ones for the office.
    const { error } = await supabase.from("job_variations").insert({
      job_id: jobId,
      variation_type_id: typeId,
      custom_name: typeId ? null : customName.trim(),
      description: description.trim() || null,
      quantity: qty,
      unit,
      photo_storage_path: photoPath,
      logged_by: currentUserId,
      logged_at: new Date().toISOString(),
    });

    setSaving(false);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    setShowForm(false);
    setTypeId(null);
    setCustomName("");
    setQuantity("");
    setDescription("");
    setPhotoUri(null);
    setPhotoBase64(null);
    Alert.alert(autoApprove ? "Auto-approved" : "Sent for approval", autoApprove ? "Variation logged and approved." : "Office will price and approve this.");
    load();
  }

  return (
    <View style={styles.container}>
      {!showForm && (
        <TouchableOpacity style={styles.addButton} onPress={() => setShowForm(true)}>
          <Text style={styles.addButtonText}>+ Log Variation</Text>
        </TouchableOpacity>
      )}

      {showForm && (
        <View style={styles.form}>
          <Text style={styles.formLabel}>Type</Text>
          <View style={styles.chipRow}>
            {types.map((t) => (
              <TouchableOpacity
                key={t.id}
                style={[styles.chip, typeId === t.id && styles.chipActive]}
                onPress={() => setTypeId(t.id)}
              >
                <Text style={[styles.chipText, typeId === t.id && styles.chipTextActive]}>
                  {t.name}
                  {t.unit ? ` (${t.unit})` : ""}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[styles.chip, typeId === null && styles.chipActive]} onPress={() => setTypeId(null)}>
              <Text style={[styles.chipText, typeId === null && styles.chipTextActive]}>Custom / Other</Text>
            </TouchableOpacity>
          </View>

          {typeId === null && (
            <>
              <Text style={styles.formLabel}>Name</Text>
              <TextInput style={styles.input} value={customName} onChangeText={setCustomName} placeholder="e.g. Extra trenching" />
            </>
          )}

          <Text style={styles.formLabel}>Quantity {selectedType ? `(${selectedType.unit})` : ""}</Text>
          <TextInput style={styles.input} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" placeholder="0" />

          <Text style={styles.formLabel}>Description</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="What happened on site..."
            multiline
          />

          <View style={styles.photoButtonRow}>
            <TouchableOpacity style={[styles.photoButton, styles.photoButtonHalf]} onPress={() => pickPhoto("camera")}>
              <Text style={styles.photoButtonText}>{photoUri ? "📷 Retake Photo" : "📷 Take Photo"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.photoButton, styles.photoButtonHalf]} onPress={() => pickPhoto("library")}>
              <Text style={styles.photoButtonText}>🖼️ Choose Existing</Text>
            </TouchableOpacity>
          </View>
          {photoUri && <Image source={{ uri: photoUri }} style={styles.photoPreview} />}

          <View style={styles.formButtonRow}>
            <TouchableOpacity style={styles.cancelButton} onPress={() => setShowForm(false)} disabled={saving}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.submitButton} onPress={submit} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Submit</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}

      <FlatList
        data={variations}
        keyExtractor={(v) => v.id}
        scrollEnabled={false}
        contentContainerStyle={{ marginTop: 12, gap: 8 }}
        ListEmptyComponent={!showForm ? <Text style={styles.emptyText}>No variations logged yet</Text> : null}
        renderItem={({ item }) => {
          const s = STATUS_STYLE[item.status];
          return (
            <View style={styles.card}>
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle}>
                  {item.custom_name ?? "Variation"} · {item.quantity} {item.unit}
                </Text>
                <View style={[styles.statusBadge, { backgroundColor: s.bg }]}>
                  <Text style={[styles.statusBadgeText, { color: s.text }]}>{s.label}</Text>
                </View>
              </View>
              {item.description && <Text style={styles.cardDescription}>{item.description}</Text>}
              {item.photo_storage_path && urls[item.photo_storage_path] && (
                <Image source={{ uri: urls[item.photo_storage_path] }} style={styles.cardPhoto} />
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
  addButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  addButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  form: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14 },
  formLabel: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginBottom: 6, marginTop: 10 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.slate700 },
  chipTextActive: { color: "#fff" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: colors.bg,
    color: colors.slate900,
  },
  textArea: { minHeight: 60, textAlignVertical: "top" },
  photoButtonRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  photoButton: { marginTop: 10, backgroundColor: colors.blue100, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  photoButtonHalf: { flex: 1, marginTop: 0 },
  photoButtonText: { color: colors.blue600, fontWeight: "600", fontSize: 13 },
  photoPreview: { width: "100%", height: 160, borderRadius: 10, marginTop: 8 },
  formButtonRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  cancelButton: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  submitButton: { flex: 1, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  card: { backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 12 },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 13, fontWeight: "600", color: colors.slate700, flex: 1, marginRight: 8 },
  cardMeta: { fontSize: 13, fontWeight: "700", color: colors.slate900, marginTop: 4 },
  cardDescription: { fontSize: 12, color: colors.slate500, marginTop: 4 },
  cardPhoto: { width: "100%", height: 140, borderRadius: 8, marginTop: 8 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusBadgeText: { fontSize: 10, fontWeight: "700" },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 10, fontSize: 13 },
});
