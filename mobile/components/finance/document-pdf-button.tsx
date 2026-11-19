import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import { colors } from "../../lib/theme";
import { fetchDocumentPdf, pdfFileName } from "../../lib/invoiceOffice";
import { PdfPreview } from "./pdf-preview";

// "PDF" on the invoice and quote screens: the same PDF the web's PDF button
// opens (and the email attaches), from GET /api/{invoices|quotes}/[id]/pdf with
// the user's Bearer token, shown in the viewer the job report preview uses.
// Online only — the PDF is rendered on the server.
export function DocumentPdfButton({ kind, id, number, title }: { kind: "invoice" | "quote"; id: string; number: number | string; title: string }) {
  const [loading, setLoading] = useState(false);
  const [pdf, setPdf] = useState<{ uri: string; base64: string } | null>(null);

  async function open() {
    setLoading(true);
    try {
      const base64 = await fetchDocumentPdf(kind, id);
      const uri = `${FileSystem.cacheDirectory}${pdfFileName(kind, number)}`;
      await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
      setPdf({ uri, base64 });
    } catch (e) {
      Alert.alert("Couldn't open the PDF", e instanceof Error ? e.message : "Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <TouchableOpacity style={styles.btn} onPress={open} disabled={loading} accessibilityRole="button" accessibilityLabel={`Open ${kind} PDF`}>
        {loading ? <ActivityIndicator size="small" color={colors.blue600} /> : <Ionicons name="document-outline" size={16} color={colors.blue600} />}
        <Text style={styles.text}>{loading ? "Making PDF…" : "PDF"}</Text>
      </TouchableOpacity>
      <PdfPreview visible={!!pdf} title={title} fileUri={pdf?.uri ?? null} base64={pdf?.base64 ?? null} onClose={() => setPdf(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 12,
    backgroundColor: colors.card,
  },
  text: { fontSize: 14, fontWeight: "700", color: colors.blue600 },
});
