import { useEffect, useState } from "react";
import { View, Text, Modal, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from "react-native";
import { colors } from "../../lib/theme";
import { useCustomers } from "../../lib/data/hooks/useCustomers";

export interface EditableCustomer {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  abn: string | null;
  notes: string | null;
}

interface Draft {
  name: string;
  company: string;
  email: string;
  phone: string;
  mobile: string;
  abn: string;
  notes: string;
}

function toDraft(c: EditableCustomer | null): Draft {
  return {
    name: c?.name ?? "",
    company: c?.company ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    mobile: c?.mobile ?? "",
    abn: c?.abn ?? "",
    notes: c?.notes ?? "",
  };
}

// Create/edit customer form. `existing` present => edit, else => create.
export function CustomerFormSheet({
  visible,
  existing,
  onClose,
  onSaved,
}: {
  visible: boolean;
  existing?: EditableCustomer | null;
  onClose: () => void;
  onSaved: (id: string, synced: boolean) => void;
}) {
  const customers = useCustomers();
  const [draft, setDraft] = useState<Draft>(toDraft(existing ?? null));
  const [saving, setSaving] = useState(false);

  // Reset the form whenever it (re)opens for a different record.
  useEffect(() => {
    if (visible) setDraft(toDraft(existing ?? null));
  }, [visible, existing]);

  async function save() {
    if (saving || !customers.ready) return;
    if (!draft.name.trim()) {
      Alert.alert("Name required", "A customer name is required.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        company: draft.company.trim() || null,
        email: draft.email.trim() || null,
        phone: draft.phone.trim() || null,
        mobile: draft.mobile.trim() || null,
        abn: draft.abn.trim() || null,
        notes: draft.notes.trim() || null,
      };
      if (existing) {
        const { synced } = await customers.updateCustomer(existing.id, input);
        onSaved(existing.id, synced);
      } else {
        const { result, synced } = await customers.createCustomer(input);
        onSaved(result as string, synced);
      }
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => !saving && onClose()}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{existing ? "Edit customer" : "New customer"}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Field label="Name" value={draft.name} onChange={set("name")} />
            <Field label="Company" value={draft.company} onChange={set("company")} />
            <Field label="Email" value={draft.email} onChange={set("email")} keyboardType="email-address" />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Phone" value={draft.phone} onChange={set("phone")} keyboardType="phone-pad" /></View>
              <View style={{ flex: 1 }}><Field label="Mobile" value={draft.mobile} onChange={set("mobile")} keyboardType="phone-pad" /></View>
            </View>
            <Field label="ABN" value={draft.abn} onChange={set("abn")} />
            <Field label="Notes" value={draft.notes} onChange={set("notes")} multiline />
          </ScrollView>
          <View style={styles.actions}>
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

function Field({ label, value, onChange, keyboardType, multiline }: { label: string; value: string; onChange: (v: string) => void; keyboardType?: "default" | "email-address" | "phone-pad"; multiline?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline]}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType ?? "default"}
        multiline={multiline}
        autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"}
        placeholderTextColor={colors.slate400}
      />
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
  multiline: { minHeight: 64, textAlignVertical: "top" },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
