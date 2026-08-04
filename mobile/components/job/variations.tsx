import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, Alert, Image, ActivityIndicator } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { unwrapRows } from "../../lib/data/reads/unwrap";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { useIsOfficeOrAdmin } from "../../design/guards/useRole";
import { useVariations } from "../../lib/data/hooks/useVariations";
import { getJobVariationsForApproval } from "../../lib/data/reads/variations";

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
  // Office/admin-only money columns (present only when read from the base table
  // via the approval path; the technician public view never returns them).
  rate?: number | null;
  total_amount?: number | null;
  admin_notes?: string | null;
  variation_types?: { name: string } | null;
}

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  auto_approved: { bg: colors.green100, text: colors.green600, label: "Auto-approved" },
  pending_approval: { bg: colors.orange100, text: colors.orange700, label: "Pending approval" },
  approved: { bg: colors.blue100, text: colors.blue600, label: "Approved" },
  rejected: { bg: colors.red100, text: colors.red600, label: "Rejected" },
};

export function JobVariationsTab({ jobId, currentUserId }: { jobId: string; currentUserId: string }) {
  const isOfficeOrAdmin = useIsOfficeOrAdmin();
  const varWrites = useVariations();
  const [variations, setVariations] = useState<Variation[]>([]);
  const [types, setTypes] = useState<VariationType[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [description, setDescription] = useState("");
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Office/admin pricing drafts, keyed by variation id.
  const [pricing, setPricing] = useState<Record<string, { rate: string; quantity: string; notes: string }>>({});
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const loadInner = useCallback(async () => {
    // Office/admin read the base table (with rate/total_amount) so they can price
    // and approve; technicians read the rate-stripped public view.
    // Both reads used to discard their error. On the technician path that meant
    // a failed query rendered "no variations logged" — indistinguishable from a
    // job that genuinely has none — and an empty type picker, which silently
    // makes it impossible to log one. A technician then does the work with no
    // record that it was ever authorised.
    const variationsP = isOfficeOrAdmin
      ? getJobVariationsForApproval(jobId)
      : supabase
          .from("job_variations_public")
          .select("*")
          .eq("job_id", jobId)
          .order("created_at", { ascending: false })
          .then((res) => unwrapRows(res as never, "loadVariations(technician)") as unknown as Variation[]);
    const [v, typesRes] = await Promise.all([
      variationsP,
      supabase.from("variation_types_public").select("*").eq("is_active", true).order("name"),
    ]);
    const rows = (v as Variation[]) ?? [];
    setVariations(rows);
    setTypes(unwrapRows(typesRes as never, "loadVariationTypes") as unknown as VariationType[]);
    // Resolve every photo's signed URL in parallel, then commit them in ONE
    // setUrls (a per-photo setState in the loop caused an extra re-render each).
    const withPhotos = rows.filter((item) => !!item.photo_storage_path);
    if (withPhotos.length > 0) {
      const resolved = await Promise.all(
        withPhotos.map(async (item) => {
          const path = item.photo_storage_path as string;
          const { data: signed } = await supabase.storage.from("job-photos").createSignedUrl(path, 3600);
          return [path, signed?.signedUrl] as const;
        })
      );
      const next: Record<string, string> = {};
      for (const [path, url] of resolved) if (url) next[path] = url;
      if (Object.keys(next).length > 0) setUrls((prev) => ({ ...prev, ...next }));
    }
  }, [jobId, isOfficeOrAdmin]);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      await loadInner();
    } catch (e) {
      // Inline, not a full-screen error: this is a tab inside a job, and
      // blanking it would throw away whatever the technician had half-typed
      // into the form above.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [loadInner]);

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
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
      if (result.canceled || !result.assets?.length) return;
      setPhotoUri(result.assets[0].uri);
      return;
    }
    // Library pick -- lets a tech attach an existing photo (e.g. a screenshot
    // of a supplier quote/invoice) instead of only a fresh camera shot.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Photo library access is required");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
    if (result.canceled || !result.assets?.length) return;
    setPhotoUri(result.assets[0].uri);
  }

  async function submit() {
    const qty = parseFloat(quantity) || 0;
    if (!typeId && !customName.trim()) {
      Alert.alert("Missing info", "Pick a variation type or name a custom one.");
      return;
    }
    if (!varWrites.ready) { Alert.alert("Not ready", "Please try again in a moment."); return; }
    setSaving(true);

    const autoApprove = !!selectedType?.auto_approve;
    const unit = selectedType?.unit ?? "unit";

    // Offline-durable via the outbox: the photo (if any) rides the attachment
    // queue and the row replays idempotently on reconnect. Pricing/status are
    // still applied server-side by apply_variation_pricing() (migration 0028) —
    // the tech never sends rate / total_amount / status.
    try {
      const { synced } = await varWrites.submitVariation({
        jobId,
        variationTypeId: typeId,
        customName: typeId ? null : customName.trim(),
        description: description.trim() || null,
        quantity: qty,
        unit,
        loggedBy: currentUserId,
        photo: photoUri ? { sourceUri: photoUri, ext: "jpg" } : null,
      });
      setShowForm(false);
      setTypeId(null);
      setCustomName("");
      setQuantity("");
      setDescription("");
      setPhotoUri(null);
      Alert.alert(
        autoApprove ? "Auto-approved" : "Sent for approval",
        synced
          ? autoApprove
            ? "Variation logged and approved."
            : "Office will price and approve this."
          : "Saved offline — it'll sync automatically when you're back online."
      );
      load();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ---- Office/admin: price + approve, or reject a pending variation ----------
  function draftFor(v: Variation) {
    return pricing[v.id] ?? { rate: v.rate != null ? String(v.rate) : "", quantity: String(v.quantity), notes: v.admin_notes ?? "" };
  }
  function setDraft(id: string, patch: Partial<{ rate: string; quantity: string; notes: string }>) {
    setPricing((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { rate: "", quantity: "", notes: "" }), ...patch } }));
  }

  async function approveVariation(v: Variation) {
    if (!varWrites.ready || approvingId) return;
    const d = draftFor(v);
    const rate = parseFloat(d.rate);
    // Blank/invalid quantity falls back to the technician's submitted quantity
    // (the office usually only prices the rate); but a DELIBERATE 0 is honored —
    // `|| v.quantity` would swallow it (0 is falsy), so distinguish empty from 0.
    const qtyStr = d.quantity.trim();
    const qty = qtyStr !== "" && !Number.isNaN(parseFloat(qtyStr)) ? parseFloat(qtyStr) : v.quantity;
    if (Number.isNaN(rate) || rate < 0) { Alert.alert("Rate required", "Enter a rate to price this variation."); return; }
    setApprovingId(v.id);
    try {
      await varWrites.priceAndApprove({ id: v.id, rate, quantity: qty, approvedBy: currentUserId, notes: d.notes.trim() || null });
      await load();
    } catch (e) {
      Alert.alert("Couldn't approve", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setApprovingId(null);
    }
  }

  async function rejectVariation(v: Variation) {
    if (!varWrites.ready || approvingId) return;
    const d = draftFor(v);
    setApprovingId(v.id);
    try {
      await varWrites.reject({ id: v.id, approvedBy: currentUserId, notes: d.notes.trim() || null });
      await load();
    } catch (e) {
      Alert.alert("Couldn't reject", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <View style={styles.container}>
      {loadError && (
        // Says the list could not be loaded rather than showing an empty one.
        // "No variations logged" on a failed read is the lie this whole change
        // exists to remove — a technician reading it does the work believing
        // nothing was ever authorised.
        <TouchableOpacity style={styles.loadErrorBox} onPress={load} accessibilityRole="button">
          <Text style={styles.loadErrorTitle}>Couldn&apos;t load variations. Tap to retry.</Text>
          <Text style={styles.loadErrorDetail} numberOfLines={2}>
            {loadError}
          </Text>
        </TouchableOpacity>
      )}
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
          const d = draftFor(item);
          const busy = approvingId === item.id;
          const canPrice = isOfficeOrAdmin && item.status === "pending_approval";
          return (
            <View style={styles.card}>
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle}>
                  {item.custom_name ?? item.variation_types?.name ?? "Variation"} · {item.quantity} {item.unit}
                </Text>
                <View style={[styles.statusBadge, { backgroundColor: s.bg }]}>
                  <Text style={[styles.statusBadgeText, { color: s.text }]}>{s.label}</Text>
                </View>
              </View>
              {item.description && <Text style={styles.cardDescription}>{item.description}</Text>}
              {item.photo_storage_path && urls[item.photo_storage_path] && (
                <Image source={{ uri: urls[item.photo_storage_path] }} style={styles.cardPhoto} />
              )}

              {/* Priced total for approved/auto-approved (office/admin only; MoneyText
                  is itself role-gated so a technician build shows nothing). */}
              {isOfficeOrAdmin && item.total_amount != null && (item.status === "approved" || item.status === "auto_approved") && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Total{item.rate != null ? ` (@ ` : ""}</Text>
                  {item.rate != null ? <MoneyText amount={item.rate} style={styles.totalLabel} /> : null}
                  {item.rate != null ? <Text style={styles.totalLabel}>{`/${item.unit})`}</Text> : null}
                  <View style={{ flex: 1 }} />
                  <MoneyText amount={item.total_amount} style={styles.totalValue} />
                </View>
              )}
              {isOfficeOrAdmin && item.status === "rejected" && item.admin_notes ? (
                <Text style={styles.rejectNote}>Rejected: {item.admin_notes}</Text>
              ) : null}

              {/* Office/admin pricing + approval controls for pending variations. */}
              {canPrice && (
                <View style={styles.approvePanel}>
                  <View style={styles.priceRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.priceLabel}>Rate ($/{item.unit})</Text>
                      <TextInput style={styles.priceInput} value={d.rate} onChangeText={(v) => setDraft(item.id, { rate: v })} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.slate400} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.priceLabel}>Quantity</Text>
                      <TextInput style={styles.priceInput} value={d.quantity} onChangeText={(v) => setDraft(item.id, { quantity: v })} keyboardType="decimal-pad" placeholder={String(item.quantity)} placeholderTextColor={colors.slate400} />
                    </View>
                  </View>
                  <Text style={styles.priceLabel}>Notes (optional)</Text>
                  <TextInput style={styles.priceInput} value={d.notes} onChangeText={(v) => setDraft(item.id, { notes: v })} placeholder="Admin note" placeholderTextColor={colors.slate400} />
                  <View style={styles.approveActions}>
                    <TouchableOpacity style={styles.rejectBtn} onPress={() => rejectVariation(item)} disabled={busy}>
                      <Text style={styles.rejectBtnText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.approveBtn} onPress={() => approveVariation(item)} disabled={busy}>
                      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveBtnText}>Price &amp; Approve</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loadErrorBox: {
    backgroundColor: colors.red100,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  loadErrorTitle: { fontSize: 13, fontWeight: "600", color: colors.red600 },
  loadErrorDetail: { fontSize: 11, color: colors.red600, marginTop: 4 },
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
  totalRow: { flexDirection: "row", alignItems: "center", gap: 2, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.slate100 },
  totalLabel: { fontSize: 12, color: colors.slate500 },
  totalValue: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  rejectNote: { fontSize: 12, color: colors.red600, marginTop: 8, fontStyle: "italic" },
  approvePanel: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.slate100, gap: 8 },
  priceRow: { flexDirection: "row", gap: 10 },
  priceLabel: { fontSize: 12, fontWeight: "600", color: colors.slate500, marginBottom: 4 },
  priceInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  approveActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  rejectBtn: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: "center", borderWidth: 1, borderColor: colors.red600 },
  rejectBtnText: { color: colors.red600, fontWeight: "700", fontSize: 13 },
  approveBtn: { flex: 2, backgroundColor: colors.blue600, borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  approveBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
});
