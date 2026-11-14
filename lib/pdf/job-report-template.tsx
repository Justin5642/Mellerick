import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import { formatDate } from "@/lib/date";
import { formatInvoiceNumber } from "@/lib/utils";
import type { JobSite } from "@/lib/job-site";
import { chunk, photoCaptionLine, type ReportVisit } from "@/lib/job-report";

// The customer job report attached to an invoice email (lib/job-report.ts has
// what may and may not appear). Header as on the invoice PDF
// (document-template.tsx). Plain text only — the notes are whatever the office
// left in the dialog, printed as typed. No hours, no money.

const GREY = "#8a8f98";
const LIGHT = "#e5e7eb";
const INK = "#1e293b";

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 36, fontSize: 9.5, fontFamily: "Helvetica", color: INK },

  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 },
  logo: { width: 170, height: 70, objectFit: "contain" },
  businessName: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  businessBlock: { fontSize: 9, lineHeight: 1.35, width: 170 },

  title: { alignSelf: "flex-end", fontSize: 14, fontFamily: "Helvetica-Bold", marginBottom: 2, textAlign: "right" },
  subtitle: { alignSelf: "flex-end", fontSize: 9, color: "#475569", marginBottom: 12, textAlign: "right", maxWidth: 380 },

  partyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  billTo: { paddingLeft: 22, paddingTop: 6, maxWidth: 220, lineHeight: 1.35 },
  billToName: { fontSize: 10 },
  jobBox: { width: 250, backgroundColor: LIGHT, borderRadius: 2, padding: 8 },
  jobRow: { flexDirection: "row", marginBottom: 2 },
  jobLabel: { width: 72, fontFamily: "Helvetica-Bold", fontSize: 8.5 },
  jobValue: { flex: 1, fontSize: 8.5, lineHeight: 1.3 },

  section: { marginBottom: 16 },
  sectionHead: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10.5,
    borderBottom: `0.75pt solid ${GREY}`,
    paddingBottom: 3,
    marginBottom: 6,
  },
  visitRow: { flexDirection: "row", paddingVertical: 3, borderBottom: `0.5pt solid ${LIGHT}` },
  visitDate: { width: 110, fontFamily: "Helvetica-Bold" },
  visitNames: { flex: 1 },
  notes: { fontSize: 9.5, lineHeight: 1.35 },
  notesPara: { marginBottom: 7 },
  empty: { color: GREY },

  photoRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  photoCell: { width: "48.5%" },
  photo: { width: "100%", height: 190, objectFit: "contain", backgroundColor: "#f8fafc" },
  photoCaption: { fontSize: 8, color: "#475569", marginTop: 3, lineHeight: 1.3 },

  signBox: { flexDirection: "row", alignItems: "flex-end", gap: 16 },
  signImage: { width: 220, height: 90, objectFit: "contain", borderBottom: `0.75pt solid ${INK}` },
  signMeta: { lineHeight: 1.4 },

  footer: { position: "absolute", bottom: 22, left: 36, right: 36, fontSize: 7.5, color: GREY, textAlign: "center" },
});

export interface JobReportPhoto {
  image: { data: Buffer; format: "jpg" | "png" };
  caption: string | null;
  createdAt: string;
}

export interface JobReportPdfProps {
  business: { name: string; abn?: string; address?: string; phone?: string; email?: string };
  logo?: { data: Buffer; format: "png" | "jpg" };
  invoiceNumber: number | string;
  jobNumber: number | null;
  jobTitle: string | null;
  customerName: string;
  site: JobSite | null;
  visits: ReportVisit[];
  notes: string;
  photos: JobReportPhoto[];
  signature: { image: { data: Buffer; format: "png" } | null; signerName: string | null; createdAt: string } | null;
}

export function JobReportPdf({
  business,
  logo,
  invoiceNumber,
  jobNumber,
  jobTitle,
  customerName,
  site,
  visits,
  notes,
  photos,
  signature,
}: JobReportPdfProps) {
  const addressLines = (business.address ?? "").split(/,\s*/).filter(Boolean);
  const trimmedNotes = notes.trim();
  const jobHeading = [jobNumber ? `Job #${jobNumber}` : "", jobTitle?.trim() ?? ""].filter(Boolean).join(" — ");

  return (
    <Document title={`Job Report${jobNumber ? ` #${jobNumber}` : ""}`} author={business.name}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          {logo ? <Image src={logo} style={styles.logo} /> : <Text style={styles.businessName}>{business.name}</Text>}
          <View style={styles.businessBlock}>
            {addressLines.map((l, i) => <Text key={i}>{l}</Text>)}
            {business.email && <Text>{business.email}</Text>}
            {business.phone && <Text>Tel. {business.phone}</Text>}
            {business.abn && <Text>ABN {business.abn}</Text>}
          </View>
        </View>

        <Text style={styles.title}>JOB REPORT</Text>
        {jobHeading ? <Text style={styles.subtitle}>{jobHeading}</Text> : null}

        <View style={styles.partyRow}>
          <View style={styles.billTo}>
            <Text style={styles.billToName}>{customerName}</Text>
          </View>
          <View style={styles.jobBox}>
            <View style={styles.jobRow}>
              <Text style={styles.jobLabel}>Job site:</Text>
              <Text style={styles.jobValue}>{site?.lines.length ? site.lines.join(", ") : "—"}</Text>
            </View>
            {jobNumber ? (
              <View style={styles.jobRow}>
                <Text style={styles.jobLabel}>Job No.:</Text>
                <Text style={styles.jobValue}>{jobNumber}</Text>
              </View>
            ) : null}
            <View style={styles.jobRow}>
              <Text style={styles.jobLabel}>Invoice:</Text>
              <Text style={styles.jobValue}>{formatInvoiceNumber(invoiceNumber)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHead}>Dates attended</Text>
          {visits.length === 0 ? (
            <Text style={styles.empty}>No site visits recorded.</Text>
          ) : (
            visits.map((v) => (
              <View key={v.dateKey} style={styles.visitRow} wrap={false}>
                <Text style={styles.visitDate}>{v.label}</Text>
                <Text style={styles.visitNames}>{v.names.length ? v.names.join(", ") : "—"}</Text>
              </View>
            ))
          )}
        </View>

        {trimmedNotes ? (
          <View style={styles.section}>
            <Text style={styles.sectionHead}>Work carried out</Text>
            {/* One Text per line: a "\n" inside a single Text spaces lines unevenly. */}
            {trimmedNotes.split(/\n\s*\n/).map((para, i) => (
              <View key={i} style={styles.notesPara}>
                {para.split("\n").map((line, j) => (
                  <Text key={j} style={styles.notes}>{line || " "}</Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}

        {photos.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionHead} minPresenceAhead={210}>Photos</Text>
            {chunk(photos, 2).map((row, r) => (
              <View key={r} style={styles.photoRow} wrap={false}>
                {row.map((p, i) => (
                  <View key={i} style={styles.photoCell}>
                    <Image src={p.image} style={styles.photo} />
                    <Text style={styles.photoCaption}>{photoCaptionLine({ caption: p.caption, created_at: p.createdAt })}</Text>
                  </View>
                ))}
                {row.length === 1 ? <View style={styles.photoCell} /> : null}
              </View>
            ))}
          </View>
        )}

        {signature && (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionHead}>Customer sign-off</Text>
            <View style={styles.signBox}>
              {signature.image ? <Image src={signature.image} style={styles.signImage} /> : null}
              <View style={styles.signMeta}>
                <Text>Signed by: {signature.signerName?.trim() || "Customer"}</Text>
                <Text>Date: {formatDate(signature.createdAt, { day: "numeric", month: "short", year: "numeric" })}</Text>
              </View>
            </View>
          </View>
        )}

        <Text style={styles.footer} render={({ pageNumber, totalPages }) => `Page ${pageNumber}/${totalPages}`} fixed />
      </Page>
    </Document>
  );
}
