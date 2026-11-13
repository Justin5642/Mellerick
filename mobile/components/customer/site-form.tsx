import { useEffect, useState } from "react";
import { View, Text, Modal, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from "react-native";
import { colors } from "../../lib/theme";
import { useCustomers } from "../../lib/data/hooks/useCustomers";
import { useWriteOutcome } from "../../lib/data/hooks/useWriteOutcome";
import type { Site } from "../../lib/data/reads/customers";
import { composeSiteNotes, findDuplicateSite, validateSiteAddress, type SiteAddressField } from "../../lib/siteAddress";

interface Draft {
  name: string;
  address_line1: string;
  address_line2: string;
  suburb: string;
  state: string;
  postcode: string;
  notes: string;
  // New sites only: kept in `notes`, labelled (composeSiteNotes).
  contact: string;
  access: string;
}

function toDraft(s: Site | null): Draft {
  return {
    name: s?.name ?? "",
    address_line1: s?.address_line1 ?? "",
    address_line2: s?.address_line2 ?? "",
    suburb: s?.suburb ?? "",
    state: s ? s.state ?? "" : "VIC",
    postcode: s?.postcode ?? "",
    notes: s?.notes ?? "",
    contact: "",
    access: "",
  };
}

/**
 * Where a NEW site stands after Save: "settled" = the server has it;
 * "pending" = saved on this phone, still queued (offline, or waiting for a
 * customer that is itself still queued); "failed" = the server has not
 * accepted it yet (the outbox keeps retrying; Sync status shows why).
 */
export type SiteSaveStatus = "settled" | "pending" | "failed";

// Create/edit a site for a customer. `existing` present => edit.
//
// Address rules and the duplicate check are lib/siteAddress.ts, shared with
// the website. Writes go through the outbox like every other write; for a new
// site the sheet waits for the drain and reports what the server said, so the
// caller never presents a queued site as confirmed.
export function SiteFormSheet({
  visible,
  customerId,
  existing,
  existingSites,
  onClose,
  onSaved,
  onUseExisting,
}: {
  visible: boolean;
  customerId: string;
  existing?: Site | null;
  /** The customer's sites, for the duplicate check on a new site. */
  existingSites?: readonly Site[];
  onClose: () => void;
  // Also called after archive/restore, so the caller reloads the list. A new
  // site is passed back with its save status.
  onSaved: (created?: Site, status?: SiteSaveStatus) => void;
  /** Offered when a new site's address matches one the customer already has. */
  onUseExisting?: (site: Site) => void;
}) {
  const customers = useCustomers();
  const writeOutcome = useWriteOutcome();
  const [draft, setDraft] = useState<Draft>(toDraft(existing ?? null));
  const [errors, setErrors] = useState<Partial<Record<SiteAddressField, string>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setDraft(toDraft(existing ?? null));
      setErrors({});
    }
  }, [visible, existing]);

  function offerExisting(dup: Site) {
    const where = `${dup.name}${dup.suburb ? ` · ${dup.suburb}` : ""}`;
    if (onUseExisting) {
      Alert.alert("Site already exists", `This customer already has a site at this address: ${where}.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Use existing site", onPress: () => onUseExisting(dup) },
      ]);
    } else {
      Alert.alert("Site already exists", `This customer already has a site at this address: ${where}.`);
    }
  }

  async function save() {
    if (saving || !customers.ready) return;
    const checked = validateSiteAddress(draft);
    // An edit is not held to the new-site rules when the address is merely
    // imperfect (Simpro imports carry odd states/postcodes); it must still
    // have every part filled in, as it always did.
    const lenient =
      !checked.ok && !!existing && [draft.address_line1, draft.suburb, draft.state, draft.postcode].every((s) => s.trim() !== "");
    if (!checked.ok && !lenient) {
      setErrors(checked.errors);
      Alert.alert("Check the address", checked.message);
      return;
    }
    setErrors({});
    const v = checked.ok
      ? checked.value
      : {
          name: draft.name.trim() || draft.address_line1.trim(),
          address_line1: draft.address_line1.trim(),
          address_line2: draft.address_line2.trim() || null,
          suburb: draft.suburb.trim(),
          state: draft.state.trim(),
          postcode: draft.postcode.trim(),
        };
    if (!existing) {
      const dup = findDuplicateSite(v, existingSites ?? []);
      if (dup) {
        offerExisting(dup);
        return;
      }
    }
    setSaving(true);
    try {
      const notes = existing ? draft.notes.trim() || null : composeSiteNotes({ contact: draft.contact, access: draft.access });
      const input = {
        customerId,
        name: v.name,
        addressLine1: v.address_line1,
        addressLine2: v.address_line2,
        suburb: v.suburb,
        state: v.state,
        postcode: v.postcode,
        notes,
      };
      if (existing) {
        await customers.updateSite(existing.id, input);
        onSaved();
        return;
      }
      // createSite drains the outbox before resolving, so writeOutcome reads
      // what the server said (or "pending" when there is no signal).
      const { result: id } = await customers.createSite(input);
      const status = await writeOutcome(id);
      const site: Site = {
        id,
        name: v.name,
        address_line1: v.address_line1,
        address_line2: v.address_line2,
        suburb: v.suburb,
        state: v.state,
        postcode: v.postcode,
        notes,
        is_active: true,
      };
      if (status === "failed") {
        Alert.alert(
          "Site not saved to the server yet",
          "It's kept on this phone and will keep retrying. Check Sync status if it doesn't clear."
        );
      }
      onSaved(site, status);
    } catch (e) {
      // Nothing was queued: say so, and keep the sheet open with what was typed.
      Alert.alert(existing ? "Couldn't save the site" : "Couldn't add the site", e instanceof Error && e.message ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function setActive(active: boolean) {
    if (!existing || saving || !customers.ready) return;
    setSaving(true);
    try {
      await customers.setSiteActive(existing.id, active);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  function confirmArchive() {
    Alert.alert(
      "Archive site?",
      "It will be hidden from site lists and pickers. Existing jobs and quotes keep it, and you can restore it any time.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Archive", style: "destructive", onPress: () => void setActive(false) },
      ]
    );
  }

  const set = (k: keyof Draft) => (v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (k in errors) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => !saving && onClose()}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{existing ? "Edit site" : "New site"}</Text>
          <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">
            <Field label="Street address" value={draft.address_line1} onChange={set("address_line1")} error={errors.address_line1} placeholder="12 Smith St" />
            <Field label="Address line 2" value={draft.address_line2} onChange={set("address_line2")} placeholder="Unit, lot (optional)" />
            <Field label="Suburb" value={draft.suburb} onChange={set("suburb")} error={errors.suburb} />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="State" value={draft.state} onChange={(t) => set("state")(t.toUpperCase())} error={errors.state} placeholder="VIC" /></View>
              <View style={{ flex: 1 }}><Field label="Postcode" value={draft.postcode} onChange={set("postcode")} error={errors.postcode} keyboardType="number-pad" /></View>
            </View>
            <Field label="Site name (optional)" value={draft.name} onChange={set("name")} placeholder="Defaults to the street address" />
            {existing ? (
              <Field label="Notes" value={draft.notes} onChange={set("notes")} multiline />
            ) : (
              <>
                <Field label="Site contact (optional)" value={draft.contact} onChange={set("contact")} placeholder="Name and phone" />
                <Field label="Access notes (optional)" value={draft.access} onChange={set("access")} placeholder="Gate code, parking, dogs…" multiline />
              </>
            )}
          </ScrollView>
          <View style={styles.actions}>
            {existing ? (
              existing.is_active ? (
                <TouchableOpacity style={styles.remove} onPress={confirmArchive} disabled={saving}>
                  <Text style={styles.removeText}>Archive</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.restore} onPress={() => void setActive(true)} disabled={saving}>
                  <Text style={styles.restoreText}>Restore</Text>
                </TouchableOpacity>
              )
            ) : null}
            <TouchableOpacity style={styles.cancel} onPress={onClose} disabled={saving}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={save} disabled={saving}>
              <Text style={styles.saveText}>{saving ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  keyboardType,
  multiline,
  error,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboardType?: "default" | "number-pad";
  multiline?: boolean;
  error?: string;
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline, !!error && styles.inputError]}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType ?? "default"}
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={label}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
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
  inputError: { borderColor: colors.red600 },
  errorText: { fontSize: 12, color: colors.red600, marginTop: 4 },
  multiline: { minHeight: 60, textAlignVertical: "top" },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12, alignItems: "center" },
  remove: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.red100, borderWidth: 1, borderColor: colors.red600 },
  removeText: { color: colors.red600, fontWeight: "600", fontSize: 13 },
  restore: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.blue600 },
  restoreText: { color: colors.blue600, fontWeight: "600", fontSize: 13 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
