import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import { formatDate } from "@/lib/date";
import { formatInvoiceNumber } from "@/lib/utils";
import type { JobSite } from "@/lib/job-site";
import type { ProgressBreakdown } from "@/lib/progress-claim";

// The invoice and quote PDF. Laid out like the Simpro invoices customers are
// used to (Justin, 21 Oct 2026, sent INV 27650 as the reference): pay-by /
// amount / date boxes, "TAX INVOICE NO. …", a job box with the site and the
// customer's order number, totals down to Balance Due, and a How To Pay
// remittance strip with the bank details. A progress claim adds a line under
// the items with where the job is up to (0084).

// "04/11/2026" — the Simpro invoices' date style, unambiguous on paper.
const pdfDateOpts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
const money = (n: number) => `$${n.toFixed(2)}`;

const GREY = "#8a8f98";
const LIGHT = "#e5e7eb";
const INK = "#1e293b";

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 36, fontSize: 9.5, fontFamily: "Helvetica", color: INK },

  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 },
  logo: { width: 170, height: 70, objectFit: "contain" },
  businessName: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  businessBlock: { fontSize: 9, lineHeight: 1.35, width: 170 },

  boxes: { flexDirection: "row", alignSelf: "flex-end", border: `0.75pt solid ${GREY}`, borderRadius: 2, marginBottom: 12 },
  box: { width: 82, paddingVertical: 4, alignItems: "center" },
  boxShaded: { backgroundColor: GREY },
  boxLabel: { fontSize: 6.5, textTransform: "uppercase", marginBottom: 3 },
  boxValue: { fontSize: 11, fontFamily: "Helvetica-Bold" },

  title: { alignSelf: "flex-end", fontSize: 12.5, fontFamily: "Helvetica-Bold", marginBottom: 8, textAlign: "right", maxWidth: 380 },

  partyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 },
  billTo: { paddingLeft: 22, paddingTop: 6, maxWidth: 220, lineHeight: 1.35 },
  billToName: { fontSize: 10 },
  jobBox: { width: 230, backgroundColor: LIGHT, borderRadius: 2, padding: 8 },
  jobRow: { flexDirection: "row", marginBottom: 2 },
  jobLabel: { width: 72, fontFamily: "Helvetica-Bold", fontSize: 8.5 },
  jobValue: { flex: 1, fontSize: 8.5, lineHeight: 1.3 },

  workBlock: { marginBottom: 14, lineHeight: 1.4 },
  sectionHead: { fontFamily: "Helvetica-Bold", marginBottom: 2 },

  tableHeaderRow: { flexDirection: "row", borderBottom: `0.75pt solid ${GREY}`, paddingBottom: 4, marginBottom: 2 },
  tableHeaderCell: { fontSize: 7.5, color: GREY, textTransform: "uppercase" },
  tableRow: { flexDirection: "row", paddingVertical: 5, borderBottom: `0.5pt solid ${LIGHT}` },
  colItem: { flex: 3, paddingRight: 8 },
  colQty: { flex: 0.7, textAlign: "right" },
  colPrice: { flex: 1, textAlign: "right" },
  colTotal: { flex: 1, textAlign: "right" },
  itemName: { fontFamily: "Helvetica-Bold" },
  itemDesc: { marginTop: 1, color: "#475569" },

  totalsWrap: { flexDirection: "row", justifyContent: "space-between", borderTop: `0.75pt solid ${INK}`, borderBottom: `0.75pt solid ${INK}`, marginTop: 18, paddingVertical: 4 },
  notes: { flex: 1, paddingRight: 20, lineHeight: 1.35 },
  totals: { width: 230 },
  totalRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 0.8 },
  totalLabel: { fontFamily: "Helvetica-Bold", textAlign: "right", width: 130, marginRight: 14 },
  totalValue: { width: 70, textAlign: "right" },

  remit: { marginTop: 18, borderTop: `0.75pt dashed ${GREY}`, paddingTop: 8 },
  remitHeadRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  remitTitle: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  remitInvoiceTag: { backgroundColor: GREY, color: "#fff", fontSize: 7.5, fontFamily: "Helvetica-Bold", paddingVertical: 5, paddingHorizontal: 14, borderRadius: 2 },
  remitHow: { marginTop: 6, marginLeft: 50 },
  remitHowTitle: { fontFamily: "Helvetica-Bold", fontSize: 8.5, marginBottom: 3 },
  bankRow: { flexDirection: "row", fontSize: 8, marginBottom: 1 },
  bankLabel: { width: 60 },
  bankValue: { fontFamily: "Helvetica-Bold" },
  dueBar: { flexDirection: "row", backgroundColor: LIGHT, marginTop: 8, width: 300, paddingVertical: 3, paddingHorizontal: 4, fontSize: 8 },
  dueLabel: { fontFamily: "Helvetica-Bold", width: 70 },
  dueValue: { fontFamily: "Helvetica-Bold", width: 80 },

  progress: { marginTop: 14, backgroundColor: LIGHT, borderRadius: 2, padding: 8 },
  progressHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  progressTitle: { fontFamily: "Helvetica-Bold", fontSize: 8.5, textTransform: "uppercase" },
  progressTrack: { height: 5, backgroundColor: "#fff", borderRadius: 2, flexDirection: "row", overflow: "hidden", marginBottom: 6 },
  progressPrev: { backgroundColor: GREY },
  progressThis: { backgroundColor: INK },
  progressCols: { flexDirection: "row" },
  progressCol: { flex: 1 },
  progressLabel: { fontSize: 6.5, color: "#475569", textTransform: "uppercase", marginBottom: 2 },
  progressValue: { fontSize: 9, fontFamily: "Helvetica-Bold" },
  progressPct: { fontSize: 7.5, color: "#475569" },

  footer: { position: "absolute", bottom: 22, left: 36, right: 36, fontSize: 7.5, color: GREY, textAlign: "center" },
});

export interface DocumentPdfItem {
  name: string;
  description?: string | null;
  quantity: number;
  unit_price: number;
  total: number;
}

export interface DocumentPdfProps {
  docType: "Quote" | "Tax Invoice";
  docNumber: number | string;
  customer: { name: string; email?: string | null; phone?: string | null };
  items: DocumentPdfItem[];
  subtotal: number;
  taxAmount: number;
  total: number;
  createdAt: string;
  dateLabel: string;
  dateValue?: string | null;
  notes?: string | null;
  // Customer-facing summary of the work performed (invoices only). Rendered
  // above the line items.
  workDescription?: string | null;
  // Where the work was done (lib/job-site.ts) — the "Job Name" in the job box.
  jobSite?: JobSite | null;
  // The customer's purchase order number (0083) — "Order No." in the job box.
  poNumber?: string | null;
  // Invoices: payments recorded so far (0081) — "Amount Applied" / "Balance Due".
  amountPaid?: number | null;
  // A progress claim's breakdown (lib/progress-claim.ts), ex GST.
  progress?: ProgressBreakdown | null;
  business: {
    name: string;
    abn?: string;
    address?: string;
    phone?: string;
    email?: string;
    bank?: { bank: string; accountName: string; bsb: string; accountNumber: string } | null;
  };
  logo?: { data: Buffer; format: "png" | "jpg" };
}

export function DocumentPdf({
  docType,
  docNumber,
  customer,
  items,
  subtotal,
  taxAmount,
  total,
  createdAt,
  dateLabel,
  dateValue,
  notes,
  workDescription,
  jobSite,
  poNumber,
  amountPaid,
  progress,
  business,
  logo,
}: DocumentPdfProps) {
  const isInvoice = docType === "Tax Invoice";
  const number = isInvoice ? formatInvoiceNumber(docNumber).replace(/^INV-/, "") : String(docNumber);
  const applied = isInvoice ? Math.max(0, Number(amountPaid ?? 0)) : 0;
  const balance = Math.max(0, Math.round((total - applied) * 100) / 100);
  // Pay-by box: the due date, else "On receipt" (the Xero push treats a blank
  // due date as due on the issue date).
  const firstBox = dateValue ? formatDate(dateValue, pdfDateOpts) : isInvoice ? "On receipt" : "—";
  const addressLines = (business.address ?? "").split(/,\s*/).filter(Boolean);

  return (
    <Document>
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

        <View style={styles.boxes}>
          <View style={styles.box}>
            <Text style={styles.boxLabel}>{isInvoice ? "Please pay by" : dateLabel}</Text>
            <Text style={styles.boxValue}>{firstBox}</Text>
          </View>
          <View style={[styles.box, styles.boxShaded]}>
            <Text style={[styles.boxLabel, { color: "#fff" }]}>Amount</Text>
            <Text style={[styles.boxValue, { color: "#fff" }]}>{money(isInvoice ? balance : total)}</Text>
          </View>
          <View style={styles.box}>
            <Text style={styles.boxLabel}>{isInvoice ? "Invoice date" : "Quote date"}</Text>
            <Text style={styles.boxValue}>{formatDate(createdAt, pdfDateOpts)}</Text>
          </View>
        </View>

        <Text style={styles.title}>{isInvoice ? `TAX INVOICE NO. ${number}` : `QUOTE NO. ${number}`}
          {isInvoice && progress ? ` - PROGRESS CLAIM NO. ${progress.claimNumber}` : ""}</Text>

        <View style={styles.partyRow}>
          <View style={styles.billTo}>
            <Text style={styles.billToName}>{customer.name}</Text>
            {customer.email && <Text>{customer.email}</Text>}
            {customer.phone && <Text>{customer.phone}</Text>}
          </View>
          <View style={styles.jobBox}>
            <View style={styles.jobRow}>
              <Text style={styles.jobLabel}>Job Name:</Text>
              <Text style={styles.jobValue}>{jobSite?.lines.length ? jobSite.lines.join(", ") : "—"}</Text>
            </View>
            <View style={styles.jobRow}>
              <Text style={styles.jobLabel}>Order No.:</Text>
              <Text style={styles.jobValue}>{poNumber ?? ""}</Text>
            </View>
            {jobSite?.jobNumber ? (
              <View style={styles.jobRow}>
                <Text style={styles.jobLabel}>Job No.:</Text>
                <Text style={styles.jobValue}>{jobSite.jobNumber}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {workDescription && (
          <View style={styles.workBlock}>
            <Text style={styles.sectionHead}>Work Carried Out</Text>
            <Text>{workDescription}</Text>
          </View>
        )}

        <View>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.colItem, styles.tableHeaderCell]}>Description</Text>
            <Text style={[styles.colQty, styles.tableHeaderCell]}>Qty</Text>
            <Text style={[styles.colPrice, styles.tableHeaderCell]}>Unit Price</Text>
            <Text style={[styles.colTotal, styles.tableHeaderCell]}>Amount</Text>
          </View>
          {items.map((item, i) => (
            <View key={i} style={styles.tableRow} wrap={false}>
              <View style={styles.colItem}>
                <Text style={styles.itemName}>{item.name}</Text>
                {item.description ? <Text style={styles.itemDesc}>{item.description}</Text> : null}
              </View>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colPrice}>{money(Number(item.unit_price))}</Text>
              <Text style={styles.colTotal}>{money(Number(item.total))}</Text>
            </View>
          ))}
        </View>

        {isInvoice && progress && (
          <View style={styles.progress} wrap={false}>
            <View style={styles.progressHead}>
              <Text style={styles.progressTitle}>Progress claim no. {progress.claimNumber}</Text>
              <Text style={styles.progressTitle}>{progress.pctToDate}% claimed to date</Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressPrev, { width: `${Math.min(100, Math.max(0, progress.pctPrevious))}%` }]} />
              <View style={[styles.progressThis, { width: `${Math.min(100 - Math.min(100, Math.max(0, progress.pctPrevious)), Math.max(0, progress.pctThis))}%` }]} />
            </View>
            <View style={styles.progressCols}>
              {[
                { label: "Contract value", value: progress.contractValue, pct: null },
                { label: "Previously claimed", value: progress.previous, pct: progress.pctPrevious },
                { label: "This claim", value: progress.thisClaim, pct: progress.pctThis },
                { label: "Claimed to date", value: progress.toDate, pct: progress.pctToDate },
                { label: "Balance to claim", value: progress.balance, pct: Math.round((100 - progress.pctToDate) * 10) / 10 },
              ].map((c) => (
                <View key={c.label} style={styles.progressCol}>
                  <Text style={styles.progressLabel}>{c.label}</Text>
                  <Text style={styles.progressValue}>{money(c.value)}</Text>
                  <Text style={styles.progressPct}>{c.pct != null ? `${c.pct}%` : "ex GST"}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.totalsWrap} wrap={false}>
          <Text style={styles.notes}>{notes || "Thank you."}</Text>
          <View style={styles.totals}>
            <View style={styles.totalRow}><Text style={styles.totalLabel}>Sub-Total ex GST</Text><Text style={styles.totalValue}>{money(subtotal)}</Text></View>
            <View style={styles.totalRow}><Text style={styles.totalLabel}>GST</Text><Text style={styles.totalValue}>{money(taxAmount)}</Text></View>
            <View style={styles.totalRow}><Text style={styles.totalLabel}>Total inc GST</Text><Text style={styles.totalValue}>{money(total)}</Text></View>
            {isInvoice && (
              <>
                <View style={styles.totalRow}><Text style={styles.totalLabel}>Amount Applied</Text><Text style={styles.totalValue}>{money(applied)}</Text></View>
                <View style={styles.totalRow}><Text style={styles.totalLabel}>Balance Due</Text><Text style={styles.totalValue}>{money(balance)}</Text></View>
              </>
            )}
          </View>
        </View>

        {isInvoice && (
          <View style={styles.remit} wrap={false}>
            <View style={styles.remitHeadRow}>
              <Text style={styles.remitTitle}>How To Pay</Text>
              <Text style={styles.remitInvoiceTag}>INVOICE NO. {number}</Text>
            </View>
            {business.bank && (
              <View style={styles.remitHow}>
                <Text style={styles.remitHowTitle}>Direct Deposit</Text>
                <View style={styles.bankRow}><Text style={styles.bankLabel}>Bank</Text><Text style={styles.bankValue}>{business.bank.bank}</Text></View>
                <View style={styles.bankRow}><Text style={styles.bankLabel}>Acc. Name</Text><Text style={styles.bankValue}>{business.bank.accountName}</Text></View>
                <View style={styles.bankRow}><Text style={styles.bankLabel}>BSB</Text><Text style={styles.bankValue}>{business.bank.bsb}</Text></View>
                <View style={styles.bankRow}><Text style={styles.bankLabel}>Acc. No.</Text><Text style={styles.bankValue}>{business.bank.accountNumber}</Text></View>
                <Text style={[styles.bankRow, { marginTop: 3 }]}>Please use INVOICE NO. {number} as the payment reference.</Text>
              </View>
            )}
            <View style={styles.dueBar}>
              <Text style={styles.dueLabel}>DUE DATE:</Text>
              <Text style={styles.dueValue}>{firstBox}</Text>
              <Text style={styles.dueLabel}>AMOUNT DUE:</Text>
              <Text style={styles.dueValue}>{money(balance)}</Text>
            </View>
          </View>
        )}

        <Text style={styles.footer} render={({ pageNumber, totalPages }) => `Page ${pageNumber}/${totalPages}`} fixed />
      </Page>
    </Document>
  );
}
