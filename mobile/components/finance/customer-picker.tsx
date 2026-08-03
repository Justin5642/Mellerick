import { useCallback, useEffect, useState } from "react";
import { View, Text, Modal, TextInput, TouchableOpacity, FlatList, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { listCustomers, type CustomerListRow } from "../../lib/data/reads/customers";

// Modal customer selector used by the invoice/quote builders.
export function CustomerPicker({ visible, onClose, onSelect }: { visible: boolean; onClose: () => void; onSelect: (c: CustomerListRow) => void }) {
  const [rows, setRows] = useState<CustomerListRow[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<unknown>(null);

  // listCustomers now THROWS on a failed query instead of returning []. Uncaught,
  // that rejection would leave the sheet showing "No customers found." — the
  // customer book looking empty rather than broken, which is the whole bug.
  const search = useCallback(async (q: string) => {
    try {
      setError(null);
      setRows(await listCustomers(0, 50, q));
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => search(query), 200);
    return () => clearTimeout(t);
  }, [visible, query, search]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>Select customer</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={colors.slate500} /></TouchableOpacity>
          </View>
          <View style={styles.search}>
            <Ionicons name="search" size={16} color={colors.slate400} />
            <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="Search name or company" placeholderTextColor={colors.slate400} autoFocus />
          </View>
          {/* Checked BEFORE the list, so a failed search can never fall through
              to the "No customers found." empty state. */}
          {error ? (
            <TouchableOpacity onPress={() => search(query)}>
              <Text style={styles.empty}>Couldn&apos;t load customers. Tap to retry.</Text>
            </TouchableOpacity>
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(c) => c.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={styles.empty}>No customers found.</Text>}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => onSelect(item)}>
                  <Text style={styles.name}>{item.name}</Text>
                  {!!item.company && <Text style={styles.company}>{item.company}</Text>}
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 24, height: "75%" },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8 },
  searchInput: { flex: 1, fontSize: 14, color: colors.slate900, padding: 0 },
  row: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  name: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  company: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 30, fontSize: 13 },
});
