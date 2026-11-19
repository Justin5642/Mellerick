import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../../../lib/theme";
import { formatInvoiceNumber } from "../../../lib/finance";
import { RoleGate } from "../../../design/guards/RoleGate";
import { ScreenError } from "../../../design/components/ScreenError";
import { MoneyText } from "../../../design/components/MoneyText";
import { getInvoice, type InvoiceDetail } from "../../../lib/data/reads/finance";
import { KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../../../components/KeyboardSheet";
import { JobReportOptions } from "../../../components/finance/job-report-options";
import { InvoiceAttachmentsField } from "../../../components/finance/invoice-attachments-field";
import {
  sendInvoice,
  sendProblem,
  sentMessage,
  UnpricedHoursError,
  type JobReportRequest,
  type PhoneAttachment,
} from "../../../lib/invoiceSend";

// Send Invoice on the phone — the web dialog's options (send to, a personal
// note, attached files, "Include job report and photos") over the same
// POST /api/invoices/[id]/send. Office/admin only: the route is registered
// for the office group alone (app/_layout.tsx), the screen sits in a RoleGate,
// and the server checks requireOfficeOrAdmin. Online only (lib/invoiceSend.ts).

export default function SendInvoiceScreen() {
  return (
    <RoleGate
      roles={["office", "admin"]}
      fallback={
        <View style={styles.center}>
          <Stack.Screen options={{ title: "Send Invoice" }} />
          <Text style={styles.muted}>Only the office can send invoices.</Text>
        </View>
      }
    >
      <SendInvoice />
    </RoleGate>
  );
}

function SendInvoice() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<PhoneAttachment[]>([]);
  const [includeReport, setIncludeReport] = useState(false);
  // Mounted on first tick and kept, so unticking and re-ticking keeps edits.
  const [reportShown, setReportShown] = useState(false);
  const [report, setReport] = useState<JobReportRequest | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const inv = await getInvoice(id);
      setInvoice(inv);
      setTo(inv?.customers?.email ?? "");
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onReportChange = useCallback((s: JobReportRequest | null) => setReport(s), []);

  async function send(confirmUnpriced = false) {
    if (!invoice) return;
    const selection = includeReport ? report : null;
    const problem = sendProblem({
      to,
      includeReport,
      report: selection,
      attachments,
      invoiceNumber: invoice.invoice_number,
    });
    if (problem) {
      Alert.alert("Can't send yet", problem);
      return;
    }
    setSending(true);
    try {
      const result = await sendInvoice(invoice.id, {
        to,
        message,
        jobReport: selection,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })),
        confirmUnpriced,
      });
      const notes = [result.reportNotice, result.warning].filter(Boolean).join("\n\n");
      Alert.alert(result.warning ? "Sent — check this" : "Sent", [sentMessage(result), notes].filter(Boolean).join("\n\n"), [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e) {
      if (e instanceof UnpricedHoursError) {
        Alert.alert("Hours not on this invoice", `${e.message}\n\nSend it without them?`, [
          { text: "Cancel", style: "cancel" },
          { text: "Send anyway", onPress: () => void send(true) },
        ]);
      } else {
        Alert.alert("Not sent", e instanceof Error ? e.message : "Failed to send invoice");
      }
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Send Invoice" }} />
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Send Invoice" }} />
        <ScreenError
          error={error}
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      </View>
    );
  }
  if (!invoice) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Send Invoice" }} />
        <Text style={styles.muted}>Invoice not found.</Text>
      </View>
    );
  }

  const number = formatInvoiceNumber(invoice.invoice_number);
  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: `Send ${number}` }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.summary}>
          <Text style={styles.title} numberOfLines={2}>
            {invoice.title}
          </Text>
          <MoneyText amount={invoice.total} style={styles.total} />
        </View>
        <Text style={styles.muted}>
          Emails a PDF copy of this invoice to the customer{invoice.job_id ? ", optionally with a job report and photos" : ""}.
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Send to</Text>
          <TextInput
            value={to}
            onChangeText={setTo}
            placeholder="customer@example.com"
            placeholderTextColor={colors.slate400}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            editable={!sending}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Message (optional)</Text>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="Add a personal note..."
            placeholderTextColor={colors.slate400}
            multiline
            style={[styles.input, styles.multiline]}
            textAlignVertical="top"
            editable={!sending}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Attachments (optional)</Text>
          <InvoiceAttachmentsField value={attachments} onChange={setAttachments} jobId={invoice.job_id} disabled={sending} />
        </View>

        {invoice.job_id ? (
          <View style={styles.field}>
            <TouchableOpacity
              style={styles.checkRow}
              onPress={() => {
                setIncludeReport((v) => !v);
                setReportShown(true);
              }}
              disabled={sending}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: includeReport }}
            >
              <Ionicons name={includeReport ? "checkbox" : "square-outline"} size={22} color={colors.blue600} />
              <Text style={styles.checkText}>Include job report and photos</Text>
            </TouchableOpacity>
            {reportShown && (
              <View style={includeReport ? undefined : styles.hidden}>
                <JobReportOptions invoiceId={invoice.id} invoiceNumber={invoice.invoice_number} onChange={onReportChange} />
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
        <TouchableOpacity style={[styles.sendBtn, sending && styles.disabled]} onPress={() => void send()} disabled={sending} accessibilityRole="button">
          {sending ? <ActivityIndicator size="small" color={colors.white} /> : <Ionicons name="send" size={16} color={colors.white} />}
          <Text style={styles.sendText}>{sending ? (includeReport ? "Making report and sending..." : "Sending...") : "Send Email"}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, padding: 24 },
  muted: { fontSize: 13, color: colors.slate500 },
  summary: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { flex: 1, fontSize: 17, fontWeight: "800", color: colors.slate900 },
  total: { fontSize: 17, fontWeight: "800", color: colors.slate900 },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    color: colors.slate900,
    backgroundColor: colors.white,
  },
  multiline: { minHeight: 80 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  checkText: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  hidden: { display: "none" },
  footer: { padding: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 14,
  },
  sendText: { fontSize: 16, fontWeight: "700", color: colors.white },
  disabled: { opacity: 0.6 },
});
