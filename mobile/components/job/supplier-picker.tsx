import { useEffect, useMemo, useState } from "react";
import { Modal, View, Text, TextInput, TouchableOpacity, SectionList, StyleSheet, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { groupSuppliers, type SupplierGroupKey } from "../../lib/supplierPicker";
import type { Supplier } from "../../lib/supplierOrders";

// The supplier picker on the Orders tab: a full-screen sheet with the search
// box pinned at the top — the keyboard comes up under it, never over it — and
// the list scrolling beneath. Groups (lib/supplierPicker.ts): Pinned (set in
// Settings → Suppliers on the website), Recent (this tech's own POs first,
// then the company's), then everyone else A–Z. Search filters all of them.

interface Props {
  visible: boolean;
  suppliers: Supplier[];
  recentIds: string[];
  onPick: (s: Supplier) => void;
  /** "Other supplier": a one-off, typed by name. `typed` is what was in the search box. */
  onOther: (typed: string) => void;
  onClose: () => void;
}

const ICONS: Record<SupplierGroupKey, keyof typeof Ionicons.glyphMap | null> = {
  pinned: "pin",
  recent: "time-outline",
  all: null,
};

export function SupplierPickerSheet({ visible, suppliers, recentIds, onPick, onOther, onClose }: Props) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);

  const sections = useMemo(
    () =>
      groupSuppliers(suppliers, { recentIds, query }).map((g) => ({
        key: g.key,
        title: g.label,
        data: g.suppliers,
      })),
    [suppliers, recentIds, query]
  );

  const typed = query.trim();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen} edges={Platform.OS === "ios" ? ["bottom"] : ["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Choose a supplier</Text>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close supplier list" style={styles.closeBtn}>
            <Text style={styles.closeText}>Cancel</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={colors.slate400} style={styles.searchIcon} />
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search suppliers"
            placeholderTextColor={colors.slate400}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            returnKeyType="search"
            accessibilityLabel="Search suppliers"
          />
        </View>
        <SectionList
          sections={sections}
          keyExtractor={(s, i) => s.id ?? `${s.name}-${i}`}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => {
            const icon = ICONS[section.key as SupplierGroupKey];
            return (
              <View style={styles.sectionHeader}>
                {icon && <Ionicons name={icon} size={13} color={colors.slate500} />}
                <Text style={styles.sectionTitle}>{section.title}</Text>
              </View>
            );
          }}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => onPick(item)} accessibilityRole="button">
              <Text style={styles.rowText}>{item.name}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>{typed ? "No supplier by that name on our list." : "No suppliers on the list yet."}</Text>
          }
          ListFooterComponent={
            <TouchableOpacity style={[styles.row, styles.otherRow]} onPress={() => onOther(typed)} accessibilityRole="button">
              <Text style={[styles.rowText, { color: colors.blue600 }]}>
                {typed ? `Other supplier: "${typed}"` : "Other supplier (not on the list)"}
              </Text>
            </TouchableOpacity>
          }
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.card },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.slate900 },
  closeBtn: { paddingVertical: 6, paddingLeft: 12 },
  closeText: { fontSize: 16, color: colors.blue600 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.bg,
  },
  searchIcon: { marginLeft: 12 },
  search: { flex: 1, fontSize: 16, paddingVertical: 12, paddingHorizontal: 8, color: colors.slate900 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.slate100,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", letterSpacing: 0.5 },
  row: { paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowText: { fontSize: 16, fontWeight: "600", color: colors.slate700 },
  otherRow: { borderBottomWidth: 0, marginBottom: 24 },
  empty: { padding: 16, fontSize: 14, color: colors.slate500 },
});
