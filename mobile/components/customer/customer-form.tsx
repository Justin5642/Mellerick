import { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { colors } from "../../lib/theme";
import { useCustomers } from "../../lib/data/hooks/useCustomers";
import { BILLING_ADDRESS_MAX, normaliseBillingAddress } from "../../lib/customerAddress";

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
  billingAddress: string;
}

function toDraft(c: EditableCustomer | null, billingAddress: string | null | undefined): Draft {
  return {
    name: c?.name ?? "",
    company: c?.company ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    mobile: c?.mobile ?? "",
    abn: c?.abn ?? "",
    notes: c?.notes ?? "",
    billingAddress: billingAddress ?? "",
  };
}

// Create/edit customer form. `existing` present => edit, else => create.
//
// Billing address (customers.billing_address, 0114): printed on
// invoices and quotes. It is read online (getCustomerBillingAddress), so when
// editing, `billingAddress === undefined` means "not known" (offline, or the
// column isn't there yet): the field is then hidden and never sent, so an
// address the phone couldn't read is never saved over as blank. A new
// customer always offers it; if the database isn't ready the gateway drops
// the column and saves the rest (optionalColumns.ts).
export function CustomerFormSheet({
  visible,
  existing,
  billingAddress,
  onClose,
  onSaved,
}: {
  visible: boolean;
  existing?: EditableCustomer | null;
  billingAddress?: string | null;
  onClose: () => void;
  onSaved: (id: string, synced: boolean, name: string) => void;
}) {
  const customers = useCustomers();
  const [draft, setDraft] = useState<Draft>(toDraft(existing ?? null, billingAddress));
  const [saving, setSaving] = useState(false);
  const showAddress = !existing || billingAddress !== undefined;

  // Reset the form whenever it (re)opens for a different record.
  useEffect(() => {
    if (visible) setDraft(toDraft(existing ?? null, billingAddress));
  }, [visible, existing, billingAddress]);

  async function save() {
    if (saving || !customers.ready) return;
    if (!draft.name.trim()) {
      Alert.alert("Name required", "A customer name is required.");
      return;
    }
    const address = normaliseBillingAddress(draft.billingAddress);
    if (!address.ok) {
      Alert.alert("Billing address", address.error);
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
        ...(showAddress ? { billingAddress: address.value } : {}),
      };
      if (existing) {
        const { synced } = await customers.updateCustomer(existing.id, input);
        onSaved(existing.id, synced, input.name);
      } else {
        const { result, synced } = await customers.createCustomer(input);
        onSaved(result as string, synced, input.name);
      }
    } catch (e) {
      // try/finally with no catch left a thrown write silently discarded: the
      // button came back to "Save", the sheet stayed open, and the technician
      // was told nothing — indistinguishable from not having pressed it.
      // onSaved is deliberately NOT called here; the caller closes the sheet
      // and reloads on it, and neither should happen for a write that failed.
      Alert.alert(
        existing ? "Couldn't save the customer" : "Couldn't create the customer",
        e instanceof Error && e.message ? e.message : "Please try again."
      );
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <KeyboardSheet
      visible={visible}
      onRequestClose={() => !saving && onClose()}
      title={<Text style={styles.title}>{existing ? "Edit customer" : "New customer"}</Text>}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancel} onPress={onClose} disabled={saving}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}>
            <Text style={styles.saveText}>{saving ? "…" : "Save"}</Text>
          </TouchableOpacity>
        </View>
      }
    >
      <Field label="Name" value={draft.name} onChange={set("name")} />
      <Field label="Company" value={draft.company} onChange={set("company")} />
      <Field label="Email" value={draft.email} onChange={set("email")} keyboardType="email-address" />
      <View style={styles.twoCol}>
        <View style={{ flex: 1 }}><Field label="Phone" value={draft.phone} onChange={set("phone")} keyboardType="phone-pad" /></View>
        <View style={{ flex: 1 }}><Field label="Mobile" value={draft.mobile} onChange={set("mobile")} keyboardType="phone-pad" /></View>
      </View>
      <Field label="ABN" value={draft.abn} onChange={set("abn")} />
      {showAddress ? (
        <Field label="Billing address (on invoices and quotes)" value={draft.billingAddress} onChange={set("billingAddress")} multiline maxLength={BILLING_ADDRESS_MAX} />
      ) : null}
      <Field label="Notes" value={draft.notes} onChange={set("notes")} multiline />
    </KeyboardSheet>
  );
}

function Field({ label, value, onChange, keyboardType, multiline, maxLength }: { label: string; value: string; onChange: (v: string) => void; keyboardType?: "default" | "email-address" | "phone-pad"; multiline?: boolean; maxLength?: number }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline]}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType ?? "default"}
        multiline={multiline}
        maxLength={maxLength}
        autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"}
        placeholderTextColor={colors.slate400}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, backgroundColor: colors.bg, color: colors.slate900 },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
