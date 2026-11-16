import { useEffect, useMemo, useState } from "react";
import { Modal, View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { filterSites, siteDetail } from "../../lib/sitePicker";
import type { Site } from "../../lib/data/reads/customers";

// The site picker on New Job. Justin, Nov 2026: "Add new site" at the top and
// a search instead of scrolling every address. Same shape as the Orders tab's
// supplier sheet: full screen, search box pinned at the top so the keyboard
// comes up under it, never over it. Sites A–Z, filtered by name, street,
// suburb or postcode (lib/sitePicker.ts, a copy of the website's rules).

interface Props {
  visible: boolean;
  sites: Site[];
  selectedId: string | null;
  onPick: (site: Site) => void;
  onAddNew: () => void;
  onClose: () => void;
}

export function SitePickerSheet({ visible, sites, selectedId, onPick, onAddNew, onClose }: Props) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);

  const shown = useMemo(() => filterSites(sites, query), [sites, query]);
  const typed = query.trim();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen} edges={Platform.OS === "ios" ? ["bottom"] : ["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Select site</Text>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close site list" style={styles.closeBtn}>
            <Text style={styles.closeText}>Cancel</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={colors.slate400} style={styles.searchIcon} />
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search name, street or suburb"
            placeholderTextColor={colors.slate400}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            returnKeyType="search"
            accessibilityLabel="Search sites"
          />
        </View>
        <FlatList
          data={shown}
          keyExtractor={(s) => s.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          ListHeaderComponent={
            <TouchableOpacity style={[styles.row, styles.addRow]} onPress={onAddNew} accessibilityRole="button">
              <Ionicons name="add-circle-outline" size={18} color={colors.blue600} />
              <Text style={styles.addRowText}>Add new site</Text>
            </TouchableOpacity>
          }
          renderItem={({ item }) => {
            const detail = siteDetail(item);
            const selected = item.id === selectedId;
            return (
              <TouchableOpacity
                style={[styles.row, selected && styles.rowSelected]}
                onPress={() => onPick(item)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
              >
                <Text style={styles.rowText}>{item.name}</Text>
                {detail && detail !== item.name ? <Text style={styles.rowSub}>{detail}</Text> : null}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>{sites.length === 0 ? "No sites yet for this customer." : `No site matches "${typed}".`}</Text>
          }
          ListFooterComponent={<View style={{ height: 24 }} />}
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
  row: { paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowSelected: { backgroundColor: colors.slate100 },
  rowText: { fontSize: 16, fontWeight: "600", color: colors.slate700 },
  rowSub: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  addRowText: { fontSize: 16, fontWeight: "600", color: colors.blue600 },
  empty: { padding: 16, fontSize: 14, color: colors.slate500 },
});
