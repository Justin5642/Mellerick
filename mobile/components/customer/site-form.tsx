import { useEffect, useState } from "react";
import { View, Text, Modal, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from "react-native";
import { colors } from "../../lib/theme";
import { useCustomers } from "../../lib/data/hooks/useCustomers";
import type { Site } from "../../lib/data/reads/customers";

interface Draft {
  name: string;
  address_line1: string;
  address_line2: string;
  suburb: string;
  state: string;
  postcode: string;
  notes: string;
}

function toDraft(s: Site | null): Draft {
  return {
    name: s?.name ?? "",
    address_line1: s?.address_line1 ?? "",
    address_line2: s?.address_line2 ?? "",
    suburb: s?.suburb ?? "",
    state: s?.state ?? "",
    postcode: s?.postcode ?? "",
    notes: s?.notes ?? "",
  };
}

// Create/edit a site for a customer. `existing` present => edit.
export function SiteFormSheet({
  visible,
  customerId,
  existing,
  onClose,
  onSaved,
  onRemoved,
}: {
  visible: boolean;
  customerId: string;
  existing?: Site | null;
  onClose: () => void;
  onSaved: () => void;
  onRemoved?: () => void;
}) {
  const customers = useCustomers();
  const [draft, setDraft] = useState<Draft>(toDraft(existing ?? null));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) setDraft(toDraft(existing ?? null));
  }, [visible, existing]);

  async function save() {
    if (saving || !customers.ready) return;
    if (!draft.name.trim() || !draft.address_line1.trim() || !draft.suburb.trim() || !draft.state.trim() || !draft.postcode.trim()) {
      Alert.alert("Missing details", "Name, address, suburb, state and postcode are required.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        customerId,
        name: draft.name.trim(),
        addressLine1: draft.address_line1.trim(),
        addressLine2: draft.address_line2.trim() || null,
        suburb: draft.suburb.trim(),
        state: draft.state.trim(),
        postcode: draft.postcode.trim(),
        notes: draft.notes.trim() || null,
      };
      if (existing) await customers.updateSite(existing.id, input);
      else await customers.createSite(input);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing || saving) return;
    setSaving(true);
    try {
      await customers.removeSite(existing.id);
      onRemoved?.();
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => !saving && onClose()}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{existing ? "Edit site" : "New site"}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Field label="Site name" value={draft.name} onChange={set("name")} />
            <Field label="Address line 1" value={draft.address_line1} onChange={set("address_line1")} />
            <Field label="Address line 2" value={draft.address_line2} onChange={set("address_line2")} />
            <Field label="Suburb" value={draft.suburb} onChange={set("suburb")} />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="State" value={draft.state} onChange={set("state")} /></View>
              <View style={{ flex: 1 }}><Field label="Postcode" value={draft.postcode} onChange={set("postcode")} keyboardType="number-pad" /></View>
            </View>
            <Field label="Notes" value={draft.notes} onChange={set("notes")} multiline />
          </ScrollView>
          <View style={styles.actions}>
            {existing && onRemoved ? (
              <TouchableOpacity style={styles.remove} onPress={remove} disabled={saving}>
                <Text style={styles.removeText}>Remove</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.cancel} onPress={onClose} disabled={saving}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}>
              <Text style={styles.saveText}>{saving ? "…" : "Save"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({ label, value, onChange, keyboardType, multiline }: { label: string; value: string; onChange: (v: string) => void; keyboardType?: "default" | "number-pad"; multiline?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={[styles.input, multiline && styles.multiline]} value={value} onChangeText={onChange} keyboardType={keyboardType ?? "default"} multiline={multiline} placeholderTextColor={colors.slate400} />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, maxHeight: "88%" },
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  multiline: { minHeight: 60, textAlignVertical: "top" },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12, alignItems: "center" },
  remove: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.red100, borderWidth: 1, borderColor: colors.red600 },
  removeText: { color: colors.red600, fontWeight: "600", fontSize: 13 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
