// A booking's cost centre on the phone — required (19 Nov 2026: "Quite often
// we have folks on multiple days on the same job achieving different tasks to
// different costs"). The job's PO lines first; then, under "Add to this job",
// the company cost centres the job has no line for — tapping one adds it to
// the job as a $0 PO line on the server (online only) and picks it. Office/
// admin screens only. Names only — never an amount.
import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { ADD_COST_CENTRE_OFFLINE, addableCostCentres, lineLabel, PICK_COST_CENTRE, type BookingLineOption, type CompanyCostCentreOption } from "../../lib/bookingCostCentre";
import { addCostCentreToJob, type AddedLine } from "../../lib/bookingCostCentreOptions";

interface Props {
  jobId: string;
  value: string | null;
  lines: BookingLineOption[];
  company: CompanyCostCentreOption[];
  /** False when the company list couldn't be read now (no signal): adding says it needs signal. */
  online: boolean;
  onChange: (lineId: string) => void;
  onLineAdded: (line: AddedLine) => void;
  /** "Pick a cost centre" in red when nothing is picked. */
  showProblem?: boolean;
}

export function CostCentrePicker({ jobId, value, lines, company, online, onChange, onLineAdded, showProblem }: Props) {
  const [adding, setAdding] = useState<string | null>(null);
  const addable = addableCostCentres(lines, company);

  async function add(centre: CompanyCostCentreOption) {
    if (adding) return;
    if (!online) {
      Alert.alert("Can't add it now", `${ADD_COST_CENTRE_OFFLINE} Pick one of the job's cost centres, or try again with signal.`);
      return;
    }
    setAdding(centre.id);
    try {
      const line = await addCostCentreToJob(jobId, centre.id);
      onLineAdded(line);
      onChange(line.id);
    } catch (e) {
      Alert.alert("Couldn't add the cost centre", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setAdding(null);
    }
  }

  return (
    <View style={{ gap: 6 }}>
      {lines.length === 0 && addable.length === 0 && (
        <Text style={styles.hint}>{online ? "No cost centres yet — add them on the website (Settings → Cost Centres)." : ADD_COST_CENTRE_OFFLINE}</Text>
      )}
      {lines.map((l) => {
        const active = value === l.id;
        return (
          <TouchableOpacity key={l.id} style={[styles.row, active && styles.rowActive]} onPress={() => onChange(l.id)} accessibilityState={{ selected: active }}>
            <Text style={[styles.rowText, { flex: 1 }]}>{lineLabel(l)}</Text>
            {active && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
          </TouchableOpacity>
        );
      })}
      {addable.length > 0 && (
        <>
          <Text style={styles.section}>Add to this job</Text>
          {!online && <Text style={styles.hint}>{ADD_COST_CENTRE_OFFLINE}</Text>}
          {addable.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={[styles.row, !online && styles.rowDisabled]}
              onPress={() => void add(c)}
              disabled={!!adding}
              accessibilityLabel={`Add ${c.name} to this job`}
            >
              <Ionicons name="add" size={16} color={online ? colors.blue600 : colors.slate400} />
              <Text style={[styles.rowText, { flex: 1 }, !online && { color: colors.slate400 }]}>{c.name}</Text>
              {adding === c.id && <ActivityIndicator size="small" color={colors.blue600} />}
            </TouchableOpacity>
          ))}
          <Text style={styles.hint}>Added to the job&apos;s PO with nothing allocated yet.</Text>
        </>
      )}
      {showProblem && !value && <Text style={styles.problem}>{PICK_COST_CENTRE}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  rowActive: { borderColor: colors.blue600, backgroundColor: colors.blue100 },
  rowDisabled: { opacity: 0.6 },
  rowText: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 8 },
  hint: { fontSize: 12, color: colors.slate400 },
  problem: { fontSize: 13, fontWeight: "700", color: colors.red600 },
});
