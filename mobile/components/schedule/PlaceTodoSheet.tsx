// The confirm for placing a to-do job on the phone's Schedule tab (office/
// admin only — the (office) route group). It used to be a plain alert; every
// booking now asks for a cost centre (19 Nov 2026), so it is a sheet: what
// will be booked, any "already booked" / leave warning, and the cost centre
// picker (the job's PO lines, or a company cost centre added to the job on
// the spot when there's signal). Names only — never an amount.
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { KeyboardSheet } from "../KeyboardSheet";
import { colors } from "../../lib/theme";
import { bookingCostCentreProblem, defaultBookingCostCentre, type BookingLineOption, type CompanyCostCentreOption } from "../../lib/bookingCostCentre";
import { loadCompanyCostCentres, loadJobLines } from "../../lib/bookingCostCentreOptions";
import { CostCentrePicker } from "./CostCentrePicker";

export interface PlaceRequest {
  jobId: string;
  title: string;
  message: string;
  /** A clash or leave warning is in the message: the button says "Book anyway". */
  warned: boolean;
}

interface Props {
  request: PlaceRequest | null;
  onCancel: () => void;
  onBook: (costCentre: { id: string; name: string }) => void;
}

export function PlaceTodoSheet({ request, onCancel, onBook }: Props) {
  const [lines, setLines] = useState<BookingLineOption[]>([]);
  const [company, setCompany] = useState<CompanyCostCentreOption[]>([]);
  const [online, setOnline] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const jobId = request?.jobId ?? null;
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    setLoading(true);
    setValue(null);
    void Promise.all([loadJobLines(jobId), loadCompanyCostCentres()]).then(([jobLines, companyList]) => {
      if (!live) return;
      setLines(jobLines);
      setCompany(companyList.list);
      setOnline(companyList.online);
      setValue(defaultBookingCostCentre({ lines: jobLines }));
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  const picked = value ? lines.find((l) => l.id === value) : undefined;
  const problem = bookingCostCentreProblem(picked?.id);

  return (
    <KeyboardSheet
      visible={!!request}
      onRequestClose={onCancel}
      title={request?.title ?? ""}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.doneBtn, !!problem && styles.doneBtnDisabled]}
            disabled={!!problem}
            onPress={() => picked && onBook({ id: picked.id, name: picked.name })}
          >
            <Text style={styles.doneText}>{request?.warned ? "Book anyway" : "Book"}</Text>
          </TouchableOpacity>
        </View>
      }
    >
      {request && (
        <View style={{ gap: 10 }}>
          <Text style={styles.message}>{request.message}</Text>
          <Text style={styles.label}>Cost centre</Text>
          {loading ? (
            <Text style={styles.hint}>Loading the job&apos;s cost centres…</Text>
          ) : (
            <CostCentrePicker
              jobId={request.jobId}
              value={value}
              lines={lines}
              company={company}
              online={online}
              onChange={setValue}
              onLineAdded={(line) => setLines((prev) => (prev.some((l) => l.id === line.id) ? prev : [...prev, line]))}
              showProblem
            />
          )}
        </View>
      )}
    </KeyboardSheet>
  );
}

const styles = StyleSheet.create({
  message: { fontSize: 14, color: colors.slate700 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  hint: { fontSize: 12, color: colors.slate400 },
  actions: { flexDirection: "row", gap: 10 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  doneBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  doneBtnDisabled: { opacity: 0.5 },
  doneText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
