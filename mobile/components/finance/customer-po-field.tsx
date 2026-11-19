import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { CUSTOMER_PO_MAX } from "../../lib/customerPo";
import { poForCustomerPo, type JobPo } from "../../lib/poInvoice";

// "Customer PO number" on the phone's New / Edit Invoice, with the web's
// builder-PO picker: when the job has more than one priced PO, tapping one
// puts its number on the invoice (and a progress claim then claims against
// that PO's value). Rules: lib/poInvoice.ts, mirror of lib/po-invoice.ts.
export function CustomerPoField({
  value,
  onChange,
  pos,
  alreadyInvoiced,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The job's priced POs (pricedPos). The picker shows only with two or more. */
  pos: JobPo[];
  /** Set when the picked PO already has an invoice — "check before sending another". */
  alreadyInvoiced?: string | null;
}) {
  const picked = poForCustomerPo(pos, value);
  return (
    <View>
      <Text style={styles.label}>Customer PO number</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        maxLength={CUSTOMER_PO_MAX}
        placeholder="The builder's PO number (optional)"
        placeholderTextColor={colors.slate400}
        autoCapitalize="characters"
      />
      {!!alreadyInvoiced && (
        <Text style={styles.warn}>
          This PO already has an invoice{alreadyInvoiced !== "yes" ? ` (${alreadyInvoiced})` : ""}. Check before sending another.
        </Text>
      )}
      {pos.length > 1 && (
        <View style={styles.picker}>
          <Text style={styles.hint}>Which builder PO is this invoice for?</Text>
          {pos.map((p) => {
            const on = picked?.id === p.id;
            return (
              <TouchableOpacity
                key={p.id}
                style={[styles.option, on && styles.optionOn]}
                onPress={() => onChange(p.po_number)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <Text style={[styles.optionText, on && styles.optionTextOn]}>PO {p.po_number}</Text>
                <MoneyText amount={Number(p.total_value)} style={[styles.optionText, on && styles.optionTextOn]} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.card, color: colors.slate900 },
  warn: { fontSize: 12, color: colors.orange700, marginTop: 6 },
  picker: { marginTop: 8, gap: 6 },
  hint: { fontSize: 12, color: colors.slate500 },
  option: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.card,
  },
  optionOn: { borderColor: colors.blue600, backgroundColor: colors.blue100 },
  optionText: { fontSize: 14, color: colors.slate700 },
  optionTextOn: { color: colors.blue600, fontWeight: "700" },
});
