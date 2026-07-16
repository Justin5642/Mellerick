import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import { formatDate } from "@/lib/date";
import { getDeviceTypeLabel, getWaterAuthorityLabel } from "@/lib/backflow";

const pdfDateOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 9, fontFamily: "Helvetica", color: "#1e293b" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 },
  logo: { width: 100, height: 50, objectFit: "contain" },
  businessBlock: { textAlign: "right", fontSize: 8, color: "#475569" },
  businessName: { fontSize: 11, fontWeight: 700, color: "#1e293b", marginBottom: 2 },
  title: { fontSize: 15, fontWeight: 700, marginBottom: 2 },
  subtitle: { fontSize: 10, color: "#475569", marginBottom: 14 },
  sectionTitle: { fontSize: 8, fontWeight: 700, color: "#ffffff", backgroundColor: "#1e293b", padding: 4, textTransform: "uppercase", marginTop: 12, marginBottom: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  field: { width: "33%", marginBottom: 6, paddingRight: 8 },
  fieldWide: { width: "50%", marginBottom: 6, paddingRight: 8 },
  label: { fontSize: 7, color: "#94a3b8", textTransform: "uppercase", marginBottom: 1 },
  value: { fontSize: 9 },
  resultBadge: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4, fontSize: 11, fontWeight: 700 },
  resultPass: { backgroundColor: "#dcfce7", color: "#166534" },
  resultFail: { backgroundColor: "#fee2e2", color: "#991b1b" },
  table: { marginTop: 4 },
  tableHeaderRow: { flexDirection: "row", backgroundColor: "#f1f5f9", paddingVertical: 4, paddingHorizontal: 4 },
  tableHeaderCell: { fontSize: 7, fontWeight: 700, color: "#475569", textTransform: "uppercase" },
  tableRow: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: 4, borderBottom: "0.5pt solid #e2e8f0" },
  tableCell: { fontSize: 8 },
  colGroup: { width: "16%" },
  colDevice: { width: "20%" },
  colCheck: { width: "16%" },
  colValve: { width: "16%" },
  colRelief: { width: "16%" },
  signatureRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 24, alignItems: "flex-end" },
  signatureImage: { width: 160, height: 50, objectFit: "contain", marginBottom: 2, borderBottom: "0.5pt solid #94a3b8" },
  signatureLabel: { fontSize: 7, color: "#94a3b8" },
  footer: { position: "absolute", bottom: 24, left: 36, right: 36, fontSize: 7, color: "#94a3b8", textAlign: "center" },
});

function yn(value: boolean | null | undefined, yes = "Yes", no = "No") {
  if (value === true) return yes;
  if (value === false) return no;
  return "—";
}

export interface BackflowTestGroupResult {
  group_label: string;
  make?: string | null;
  model?: string | null;
  serial_number?: string | null;
  size_mm?: number | string | null;
  check_valve_1_kpa?: number | string | null;
  check_valve_1_leaked?: boolean | null;
  check_valve_2_kpa?: number | string | null;
  check_valve_2_leaked?: boolean | null;
  upstream_isolation_valve_tight?: boolean | null;
  downstream_isolation_valve_tight?: boolean | null;
  relief_valve_opened?: boolean | null;
}

export interface BackflowPdfProps {
  business: { name: string; abn?: string; address?: string; phone?: string; email?: string };
  logo?: { data: Buffer; format: "png" | "jpg" };
  waterAuthority: string;
  jobNumber?: number | null;
  customer: { name: string };
  siteAddress?: string | null;
  device: {
    device_type: string;
    protection_type?: string | null;
    make?: string | null;
    model?: string | null;
    serial_number?: string | null;
    size_mm?: number | string | null;
    location_description?: string | null;
    water_authority_property_number?: string | null;
    water_meter_number?: string | null;
    fire_service_meter_number?: string | null;
  };
  test: {
    test_type: string;
    test_date: string;
    result: "pass" | "fail";
    mains_pressure_kpa?: number | string | null;
    permission_to_turn_off_water?: boolean | null;
    strainer_installed?: boolean | null;
    strainer_cleaned?: boolean | null;
    isolating_valves_padlocked?: boolean | null;
    complies_with_as_nzs_3500_1?: boolean | null;
    reason_for_failure?: string | null;
    repair_scheduled_date?: string | null;
    test_kit_serial_number?: string | null;
    test_kit_calibration_date?: string | null;
    tester_name: string;
    tester_licence_number?: string | null;
    tester_phone?: string | null;
    remarks?: string | null;
    test_results?: BackflowTestGroupResult[];
  };
  signature?: { data: Buffer; format: "png" | "jpg" } | null;
}

export function BackflowPdf({
  business,
  logo,
  waterAuthority,
  jobNumber,
  customer,
  siteAddress,
  device,
  test,
  signature,
}: BackflowPdfProps) {
  const groups = test.test_results ?? [];
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          {logo ? <Image src={logo} style={styles.logo} /> : <Text style={styles.businessName}>{business.name}</Text>}
          <View style={styles.businessBlock}>
            <Text style={styles.businessName}>{business.name}</Text>
            {business.address && <Text>{business.address}</Text>}
            {business.phone && <Text>{business.phone}</Text>}
            {business.email && <Text>{business.email}</Text>}
            {business.abn && <Text>ABN {business.abn}</Text>}
          </View>
        </View>

        <Text style={styles.title}>Backflow Prevention Device — Inspection &amp; Test Report</Text>
        <Text style={styles.subtitle}>
          Submitted to {getWaterAuthorityLabel(waterAuthority)} · {formatDate(test.test_date, pdfDateOpts)}
          {jobNumber ? ` · Job #${jobNumber}` : ""}
        </Text>

        <Text style={styles.sectionTitle}>Property &amp; Owner Details</Text>
        <View style={styles.row}>
          <View style={styles.fieldWide}><Text style={styles.label}>Owner / Occupier</Text><Text style={styles.value}>{customer.name}</Text></View>
          <View style={styles.fieldWide}><Text style={styles.label}>Address</Text><Text style={styles.value}>{siteAddress ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Property No.</Text><Text style={styles.value}>{device.water_authority_property_number ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Water Meter No.</Text><Text style={styles.value}>{device.water_meter_number ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Fire Service Meter No.</Text><Text style={styles.value}>{device.fire_service_meter_number ?? "—"}</Text></View>
        </View>

        <Text style={styles.sectionTitle}>Test Details</Text>
        <View style={styles.row}>
          <View style={styles.field}><Text style={styles.label}>Test Type</Text><Text style={styles.value}>{test.test_type.replace(/_/g, " ")}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Date of Test</Text><Text style={styles.value}>{formatDate(test.test_date, pdfDateOpts)}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Permission to Turn Off Water</Text><Text style={styles.value}>{yn(test.permission_to_turn_off_water)}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Mains Pressure</Text><Text style={styles.value}>{test.mains_pressure_kpa != null ? `${test.mains_pressure_kpa} kPa` : "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Protection Type</Text><Text style={styles.value}>{device.protection_type ?? "—"}</Text></View>
        </View>

        <Text style={styles.sectionTitle}>Device Details</Text>
        <View style={styles.row}>
          <View style={styles.field}><Text style={styles.label}>Device Type</Text><Text style={styles.value}>{getDeviceTypeLabel(device.device_type)}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Location of Device</Text><Text style={styles.value}>{device.location_description ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Make / Model</Text><Text style={styles.value}>{[device.make, device.model].filter(Boolean).join(" / ") || "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Serial No.</Text><Text style={styles.value}>{device.serial_number ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Size (mm)</Text><Text style={styles.value}>{device.size_mm ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Strainer Installed / Cleaned</Text><Text style={styles.value}>{yn(test.strainer_installed)} / {yn(test.strainer_cleaned)}</Text></View>
        </View>

        {groups.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Test Results</Text>
            <View style={styles.table}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.colGroup, styles.tableHeaderCell]}>Group</Text>
                <Text style={[styles.colDevice, styles.tableHeaderCell]}>Make / Model / Serial</Text>
                <Text style={[styles.colCheck, styles.tableHeaderCell]}>Check Valve 1</Text>
                <Text style={[styles.colCheck, styles.tableHeaderCell]}>Check Valve 2</Text>
                <Text style={[styles.colValve, styles.tableHeaderCell]}>Isolation Valves</Text>
                <Text style={[styles.colRelief, styles.tableHeaderCell]}>Relief Valve</Text>
              </View>
              {groups.map((g, i) => (
                <View key={i} style={styles.tableRow}>
                  <Text style={[styles.colGroup, styles.tableCell]}>{g.group_label}</Text>
                  <Text style={[styles.colDevice, styles.tableCell]}>{[g.make, g.model, g.serial_number].filter(Boolean).join(" / ") || "—"}</Text>
                  <Text style={[styles.colCheck, styles.tableCell]}>
                    {g.check_valve_1_kpa != null ? `${g.check_valve_1_kpa} kPa` : "—"} · {yn(g.check_valve_1_leaked, "Leaked", "Closed tight")}
                  </Text>
                  <Text style={[styles.colCheck, styles.tableCell]}>
                    {g.check_valve_2_kpa != null ? `${g.check_valve_2_kpa} kPa` : "—"} · {yn(g.check_valve_2_leaked, "Leaked", "Closed tight")}
                  </Text>
                  <Text style={[styles.colValve, styles.tableCell]}>
                    Up: {yn(g.upstream_isolation_valve_tight, "Tight", "Leaked")} · Down: {yn(g.downstream_isolation_valve_tight, "Tight", "Leaked")}
                  </Text>
                  <Text style={[styles.colRelief, styles.tableCell]}>{yn(g.relief_valve_opened, "Opened", "Didn't open")}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        <Text style={styles.sectionTitle}>Compliance &amp; Result</Text>
        <View style={styles.row}>
          <View style={styles.field}><Text style={styles.label}>Isolating Valves Padlocked</Text><Text style={styles.value}>{yn(test.isolating_valves_padlocked)}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Complies with AS/NZS3500.1</Text><Text style={styles.value}>{yn(test.complies_with_as_nzs_3500_1)}</Text></View>
          <View style={styles.field}>
            <Text style={styles.label}>Device Test Result</Text>
            <Text style={[styles.resultBadge, test.result === "pass" ? styles.resultPass : styles.resultFail]}>
              {test.result.toUpperCase()}
            </Text>
          </View>
        </View>

        {test.result === "fail" && (
          <View style={styles.row}>
            <View style={styles.fieldWide}><Text style={styles.label}>Reason for Failure</Text><Text style={styles.value}>{test.reason_for_failure ?? "—"}</Text></View>
            <View style={styles.field}><Text style={styles.label}>Repair Scheduled</Text><Text style={styles.value}>{test.repair_scheduled_date ? formatDate(test.repair_scheduled_date, pdfDateOpts) : "—"}</Text></View>
          </View>
        )}

        <Text style={styles.sectionTitle}>Test Kit &amp; Authorised Tester</Text>
        <View style={styles.row}>
          <View style={styles.field}><Text style={styles.label}>Test Kit Serial No.</Text><Text style={styles.value}>{test.test_kit_serial_number ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Test Kit Calibration Date</Text><Text style={styles.value}>{test.test_kit_calibration_date ? formatDate(test.test_kit_calibration_date, pdfDateOpts) : "—"}</Text></View>
          <View style={styles.field} />
          <View style={styles.field}><Text style={styles.label}>Authorised Tester</Text><Text style={styles.value}>{test.tester_name}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Licence No.</Text><Text style={styles.value}>{test.tester_licence_number ?? "—"}</Text></View>
          <View style={styles.field}><Text style={styles.label}>Phone</Text><Text style={styles.value}>{test.tester_phone ?? "—"}</Text></View>
        </View>

        {test.remarks && (
          <View style={styles.row}>
            <View style={{ width: "100%" }}><Text style={styles.label}>Tester's Remarks</Text><Text style={styles.value}>{test.remarks}</Text></View>
          </View>
        )}

        <View style={styles.signatureRow}>
          <View>
            {signature ? <Image src={signature} style={styles.signatureImage} /> : <View style={{ width: 160, height: 50 }} />}
            <Text style={styles.signatureLabel}>Authorised Tester's Signature</Text>
          </View>
          <View>
            <Text style={styles.value}>{formatDate(test.test_date, pdfDateOpts)}</Text>
            <Text style={styles.signatureLabel}>Date</Text>
          </View>
        </View>

        <Text style={styles.footer}>
          {business.name}{business.abn ? ` · ABN ${business.abn}` : ""} — generated electronically, submitted to {getWaterAuthorityLabel(waterAuthority)}.
        </Text>
      </Page>
    </Document>
  );
}
