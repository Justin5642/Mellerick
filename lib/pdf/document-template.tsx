import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import { formatDate } from "@/lib/date";

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#1e293b" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  logo: { width: 110, height: 55, objectFit: "contain" },
  businessBlock: { textAlign: "right", fontSize: 9, color: "#475569" },
  businessName: { fontSize: 12, fontWeight: 700, color: "#1e293b", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: 700, marginBottom: 2 },
  docNumber: { fontSize: 11, color: "#475569", marginBottom: 20 },
  section: { flexDirection: "row", justifyContent: "space-between", marginBottom: 20 },
  label: { fontSize: 8, color: "#94a3b8", textTransform: "uppercase", marginBottom: 3 },
  value: { fontSize: 10, marginBottom: 2 },
  tableHeaderRow: { flexDirection: "row", borderBottom: "1pt solid #cbd5e1", paddingBottom: 6, marginBottom: 6 },
  tableHeaderCell: { fontSize: 8, color: "#94a3b8", textTransform: "uppercase" },
  tableRow: { flexDirection: "row", paddingVertical: 6, borderBottom: "0.5pt solid #e2e8f0" },
  colItem: { flex: 3 },
  colQty: { flex: 1, textAlign: "right" },
  colPrice: { flex: 1, textAlign: "right" },
  colTotal: { flex: 1, textAlign: "right" },
  itemDesc: { fontSize: 8, color: "#94a3b8", marginTop: 2 },
  totals: { marginTop: 16, alignSelf: "flex-end", width: 220 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  grandTotalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: 6, marginTop: 4, borderTop: "1pt solid #1e293b" },
  grandTotalText: { fontWeight: 700 },
  notes: { marginTop: 30, fontSize: 9, color: "#475569" },
  footer: { position: "absolute", bottom: 30, left: 40, right: 40, fontSize: 8, color: "#94a3b8", textAlign: "center" },
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
  business: { name: string; abn?: string; address?: string; phone?: string; email?: string };
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
  business,
  logo,
}: DocumentPdfProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          {logo ? (
            <Image src={logo} style={styles.logo} />
          ) : (
            <Text style={styles.businessName}>{business.name}</Text>
          )}
          <View style={styles.businessBlock}>
            <Text style={styles.businessName}>{business.name}</Text>
            {business.address && <Text>{business.address}</Text>}
            {business.phone && <Text>{business.phone}</Text>}
            {business.email && <Text>{business.email}</Text>}
            {business.abn && <Text>ABN {business.abn}</Text>}
          </View>
        </View>

        <Text style={styles.title}>{docType}</Text>
        <Text style={styles.docNumber}>#{docNumber} · {formatDate(createdAt)}</Text>

        <View style={styles.section}>
          <View>
            <Text style={styles.label}>Billed To</Text>
            <Text style={styles.value}>{customer.name}</Text>
            {customer.email && <Text style={styles.value}>{customer.email}</Text>}
            {customer.phone && <Text style={styles.value}>{customer.phone}</Text>}
          </View>
          {dateValue && (
            <View>
              <Text style={styles.label}>{dateLabel}</Text>
              <Text style={styles.value}>{formatDate(dateValue)}</Text>
            </View>
          )}
        </View>

        <View>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.colItem, styles.tableHeaderCell]}>Item</Text>
            <Text style={[styles.colQty, styles.tableHeaderCell]}>Qty</Text>
            <Text style={[styles.colPrice, styles.tableHeaderCell]}>Unit Price</Text>
            <Text style={[styles.colTotal, styles.tableHeaderCell]}>Total</Text>
          </View>
          {items.map((item, i) => (
            <View key={i} style={styles.tableRow}>
              <View style={styles.colItem}>
                <Text>{item.name}</Text>
                {item.description && <Text style={styles.itemDesc}>{item.description}</Text>}
              </View>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colPrice}>${Number(item.unit_price).toFixed(2)}</Text>
              <Text style={styles.colTotal}>${Number(item.total).toFixed(2)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text>Subtotal (ex GST)</Text>
            <Text>${subtotal.toFixed(2)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text>GST (10%)</Text>
            <Text>${taxAmount.toFixed(2)}</Text>
          </View>
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalText}>Total</Text>
            <Text style={styles.grandTotalText}>${total.toFixed(2)}</Text>
          </View>
        </View>

        {notes && (
          <View style={styles.notes}>
            <Text style={styles.label}>Notes</Text>
            <Text>{notes}</Text>
          </View>
        )}

        <Text style={styles.footer}>
          {business.name}{business.abn ? ` · ABN ${business.abn}` : ""} — Thank you for your business.
        </Text>
      </Page>
    </Document>
  );
}
