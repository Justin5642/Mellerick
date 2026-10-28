import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, Platform } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { localDateKey } from "../../lib/date";
import { cryptoIdGen } from "../../lib/data/ids";
import type { JobCostCentre } from "../../lib/data/reads/jobBilling";
import {
  loadSupplierOrders,
  raiseSupplierOrder,
  supplierOrderProblem,
  type SupplierOrdersState,
} from "../../lib/supplierOrders";

// Supplier POs on a job (Justin, 28 Oct 2026): any tech, any job, any
// supplier — raised against the cost centre so the materials marry up to the
// job. No prices anywhere on this screen; the office prices it from the
// supplier's invoice.

interface Props {
  jobId: string;
  costCentres: JobCostCentre[];
}

interface ItemRow {
  key: string;
  description: string;
  quantity: string;
}

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  ordered: { bg: colors.yellow100, text: colors.yellow700, label: "Ordered" },
  received: { bg: colors.green100, text: colors.green600, label: "Received" },
  cancelled: { bg: colors.slate100, text: colors.slate500, label: "Cancelled" },
};

const newRow = (): ItemRow => ({ key: cryptoIdGen.newId(), description: "", quantity: "1" });

function displayDate(key: string): string {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

export function JobSupplierOrdersTab({ jobId, costCentres }: Props) {
  const [state, setState] = useState<SupplierOrdersState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // One id per draft, kept across retries: a retry after a dropped connection
  // gets back the PO already raised, never a second email to the supplier.
  const [draftId, setDraftId] = useState(() => cryptoIdGen.newId());
  const [costCentreId, setCostCentreId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierEmail, setSupplierEmail] = useState("");
  const [items, setItems] = useState<ItemRow[]>([newRow()]);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [requiredBy, setRequiredBy] = useState<string | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setState(await loadSupplierOrders(jobId));
    } catch (e: any) {
      setLoadError(e?.message ?? "Couldn't load purchase orders.");
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  function openForm() {
    // The cost centre they're clocked into, else the one the job is scheduled
    // to, else the only one there is. Otherwise left for the office.
    const preferred = state?.defaultCostCenterId;
    if (preferred && costCentres.some((cc) => cc.id === preferred)) setCostCentreId(preferred);
    else setCostCentreId(costCentres.length === 1 ? costCentres[0].id : null);
    setDeliveryAddress(state?.deliveryAddress ?? "");
    setFormOpen(true);
  }

  function resetForm() {
    setFormOpen(false);
    setDraftId(cryptoIdGen.newId());
    setSupplierName("");
    setSupplierEmail("");
    setItems([newRow()]);
    setRequiredBy(null);
    setNotes("");
  }

  const supplierMatches = useMemo(() => {
    const q = supplierName.trim().toLowerCase();
    const all = state?.suppliers ?? [];
    if (!q) return all.slice(0, 6);
    return all.filter((s) => s.name.toLowerCase().includes(q) && s.name.toLowerCase() !== q).slice(0, 6);
  }, [supplierName, state?.suppliers]);

  function updateItem(key: string, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) setRequiredBy(localDateKey(selected));
  }

  async function send() {
    if (sending) return;
    const order = {
      id: draftId,
      costCenterId: costCentreId,
      supplierName: supplierName.trim(),
      supplierEmail: supplierEmail.trim() || null,
      deliveryAddress: deliveryAddress.trim() || null,
      requiredBy,
      notes: notes.trim() || null,
      items: items
        .filter((r) => r.description.trim())
        .map((r) => ({ description: r.description.trim(), quantity: Number(r.quantity.replace(",", ".")) })),
    };
    const problem = supplierOrderProblem(order);
    if (problem) {
      Alert.alert("Check the order", problem);
      return;
    }
    setSending(true);
    try {
      const res = await raiseSupplierOrder(jobId, order);
      if (res.warning) Alert.alert(`${res.poNumber} raised — email not sent`, res.warning);
      else if (res.emailed) Alert.alert(`${res.poNumber} sent`, `Emailed to ${res.emailedTo}. The office has a copy.`);
      else Alert.alert(`${res.poNumber} raised`, `Quote ${res.poNumber} to the supplier so the invoice comes back to this job.`);
      resetForm();
      await load();
    } catch (e: any) {
      Alert.alert("PO not raised", e?.message ?? "Try again.");
    } finally {
      setSending(false);
    }
  }

  const costCentreName = (id: string | null) => (id ? costCentres.find((cc) => cc.id === id)?.name ?? null : null);

  if (!state && !loadError) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.blue600} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {loadError && (
        <TouchableOpacity style={styles.errorBox} onPress={load}>
          <Text style={styles.errorTitle}>{loadError}</Text>
          <Text style={styles.errorDetail}>Tap to try again.</Text>
        </TouchableOpacity>
      )}

      {state && !formOpen && (
        <TouchableOpacity style={styles.addButton} onPress={openForm} accessibilityLabel="Raise purchase order">
          <Text style={styles.addButtonText}>+ Raise Purchase Order</Text>
        </TouchableOpacity>
      )}

      {formOpen && (
        <View style={styles.form}>
          <Text style={[styles.formLabel, { marginTop: 0 }]}>Cost centre</Text>
          <View style={styles.chipRow}>
            {costCentres.map((cc) => (
              <TouchableOpacity
                key={cc.id}
                style={[styles.chip, costCentreId === cc.id && styles.chipActive]}
                onPress={() => setCostCentreId(cc.id)}
              >
                <Text style={[styles.chipText, costCentreId === cc.id && styles.chipTextActive]}>{cc.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[styles.chip, costCentreId === null && styles.chipActive]} onPress={() => setCostCentreId(null)}>
              <Text style={[styles.chipText, costCentreId === null && styles.chipTextActive]}>Not sure — office to allocate</Text>
            </TouchableOpacity>
          </View>
          {state?.clockedIn && costCentreId && costCentreId === state.defaultCostCenterId && (
            <Text style={styles.hint}>The cost centre you're clocked into.</Text>
          )}

          <Text style={styles.formLabel}>Supplier</Text>
          <TextInput
            style={styles.input}
            value={supplierName}
            onChangeText={setSupplierName}
            placeholder="e.g. Reece Epping"
            placeholderTextColor={colors.slate400}
          />
          {supplierMatches.length > 0 && (
            <View style={[styles.chipRow, { marginTop: 6 }]}>
              {supplierMatches.map((s) => (
                <TouchableOpacity
                  key={s.name}
                  style={styles.chip}
                  onPress={() => {
                    setSupplierName(s.name);
                    setSupplierEmail(s.email);
                  }}
                >
                  <Text style={styles.chipText}>{s.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.formLabel}>Supplier email</Text>
          <TextInput
            style={styles.input}
            value={supplierEmail}
            onChangeText={setSupplierEmail}
            placeholder="orders@supplier.com.au"
            placeholderTextColor={colors.slate400}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>Leave blank if you're at the counter or ordering by phone — you'll still get a PO number to quote.</Text>

          <Text style={styles.formLabel}>Items</Text>
          {items.map((row) => (
            <View key={row.key} style={styles.itemRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={row.description}
                onChangeText={(t) => updateItem(row.key, { description: t })}
                placeholder="Description"
                placeholderTextColor={colors.slate400}
              />
              <TextInput
                style={[styles.input, styles.qtyInput]}
                value={row.quantity}
                onChangeText={(t) => updateItem(row.key, { quantity: t })}
                keyboardType="decimal-pad"
                placeholder="Qty"
                placeholderTextColor={colors.slate400}
                accessibilityLabel="Quantity"
              />
              <TouchableOpacity
                onPress={() => setItems((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== row.key) : [newRow()]))}
                accessibilityLabel="Remove item"
                style={styles.removeBtn}
              >
                <Ionicons name="close-circle" size={22} color={colors.slate400} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity onPress={() => setItems((rows) => [...rows, newRow()])} style={styles.addItem}>
            <Ionicons name="add" size={16} color={colors.blue600} />
            <Text style={styles.addItemText}>Add item</Text>
          </TouchableOpacity>

          <Text style={styles.formLabel}>Deliver to</Text>
          <TextInput
            style={styles.input}
            value={deliveryAddress}
            onChangeText={setDeliveryAddress}
            placeholder="Site address, or 'Pick up'"
            placeholderTextColor={colors.slate400}
          />

          <Text style={styles.formLabel}>Required by (optional)</Text>
          <View style={styles.itemRow}>
            <TouchableOpacity style={[styles.input, styles.selector]} onPress={() => setShowDate(true)}>
              <Text style={{ color: requiredBy ? colors.slate900 : colors.slate400, fontSize: 14 }}>
                {requiredBy ? displayDate(requiredBy) : "No date"}
              </Text>
              <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
            </TouchableOpacity>
            {requiredBy && (
              <TouchableOpacity onPress={() => setRequiredBy(null)} accessibilityLabel="Clear date" style={styles.removeBtn}>
                <Ionicons name="close-circle" size={22} color={colors.slate400} />
              </TouchableOpacity>
            )}
          </View>
          {showDate && (
            <DateTimePicker value={requiredBy ? new Date(`${requiredBy}T12:00:00`) : new Date()} mode="date" minimumDate={new Date()} onChange={onDateChange} />
          )}

          <Text style={styles.formLabel}>Notes for the supplier (optional)</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. Call on arrival, gate code 1234"
            placeholderTextColor={colors.slate400}
            multiline
          />

          <View style={styles.formButtonRow}>
            <TouchableOpacity style={styles.cancelButton} onPress={resetForm} disabled={sending}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.submitButton, sending && { opacity: 0.6 }]} onPress={send} disabled={sending}>
              {sending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitButtonText}>{supplierEmail.trim() ? "Send PO" : "Raise PO"}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {state && state.orders.length === 0 && !formOpen && (
        <Text style={styles.empty}>No purchase orders on this job yet.</Text>
      )}

      {state?.orders.map((o) => {
        const st = STATUS_STYLE[o.status] ?? STATUS_STYLE.ordered;
        const cc = costCentreName(o.costCenterId);
        return (
          <View key={o.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.poNumber}>{o.poNumber}</Text>
              <View style={[styles.pill, { backgroundColor: st.bg }]}>
                <Text style={[styles.pillText, { color: st.text }]}>{st.label}</Text>
              </View>
            </View>
            <Text style={styles.supplier}>{o.supplierName}</Text>
            <Text style={styles.meta}>{cc ?? "Cost centre not allocated yet"}</Text>
            {o.items.map((i, n) => (
              <Text key={n} style={styles.item}>
                {Number.isInteger(i.quantity) ? i.quantity : i.quantity.toFixed(2)} × {i.description}
              </Text>
            ))}
            <Text style={styles.meta}>
              {[o.raisedBy, new Date(o.createdAt).toLocaleDateString("en-AU"), o.requiredBy ? `needed ${displayDate(o.requiredBy)}` : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Text style={[styles.meta, { color: o.emailedAt ? colors.green600 : colors.slate500 }]}>
              {o.emailedAt ? `Emailed to ${o.supplierEmail}` : o.supplierEmail ? "Email didn't send — phone it through" : "Not emailed"}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { padding: 40, alignItems: "center" },
  container: { padding: 16, gap: 10 },
  errorBox: { backgroundColor: colors.red100, borderRadius: 8, padding: 12 },
  errorTitle: { fontSize: 13, fontWeight: "600", color: colors.red600 },
  errorDetail: { fontSize: 11, color: colors.red600, marginTop: 4 },
  addButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  addButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  form: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14 },
  formLabel: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginBottom: 6, marginTop: 12 },
  hint: { fontSize: 11, color: colors.slate500, marginTop: 4 },
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
  itemRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  qtyInput: { width: 64, textAlign: "center" },
  removeBtn: { padding: 2 },
  addItem: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 },
  addItemText: { color: colors.blue600, fontWeight: "600", fontSize: 13 },
  selector: { flex: 1, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  formButtonRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  cancelButton: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelButtonText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  submitButton: { flex: 1, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  empty: { textAlign: "center", color: colors.slate500, fontSize: 13, marginTop: 12 },
  card: { backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 2 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  poNumber: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: "600" },
  supplier: { fontSize: 14, fontWeight: "600", color: colors.slate700, marginTop: 2 },
  item: { fontSize: 13, color: colors.slate700 },
  meta: { fontSize: 12, color: colors.slate500, marginTop: 2 },
});
