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
import { formatQuoteNumber } from "../../../lib/finance";
import { RoleGate } from "../../../design/guards/RoleGate";
import { ScreenError } from "../../../design/components/ScreenError";
import { MoneyText } from "../../../design/components/MoneyText";
import { getQuote, type QuoteDetail } from "../../../lib/data/reads/finance";
import { markWritesSettled } from "../../../lib/data/reads/source";
import { KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../../../components/KeyboardSheet";
import { sendQuote } from "../../../lib/invoiceOffice";

// Send Quote on the phone — the web's Send dialog (send to, a personal note)
// over the same POST /api/quotes/[id]/send, which emails the quote PDF and
// marks a draft as sent. Office/admin only: registered for the office group
// alone (app/_layout.tsx), inside a RoleGate, and the route checks
// requireOfficeOrAdmin. Online only (lib/invoiceOffice.ts).

export default function SendQuoteScreen() {
  return (
    <RoleGate
      roles={["office", "admin"]}
      fallback={
        <View style={styles.center}>
          <Stack.Screen options={{ title: "Send Quote" }} />
          <Text style={styles.muted}>Only the office can send quotes.</Text>
        </View>
      }
    >
      <SendQuote />
    </RoleGate>
  );
}

function SendQuote() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const q = await getQuote(id);
      setQuote(q);
      setTo(q?.customers?.email ?? "");
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send() {
    if (!quote) return;
    if (!to.trim()) {
      Alert.alert("Can't send yet", "Enter an email address to send to");
      return;
    }
    setSending(true);
    try {
      const r = await sendQuote(quote.id, to, message);
      markWritesSettled();
      Alert.alert("Sent", `Quote emailed to ${r.sentTo}`, [{ text: "OK", onPress: () => router.back() }]);
    } catch (e) {
      Alert.alert("Not sent", e instanceof Error ? e.message : "Failed to send quote");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Send Quote" }} />
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Send Quote" }} />
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
  if (!quote) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Send Quote" }} />
        <Text style={styles.muted}>Quote not found.</Text>
      </View>
    );
  }

  const number = formatQuoteNumber(quote.quote_number);
  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: `Send ${number}` }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.summary}>
          <Text style={styles.title} numberOfLines={2}>
            {quote.title}
          </Text>
          <MoneyText amount={quote.total} style={styles.total} />
        </View>
        <Text style={styles.muted}>Emails a PDF copy of this quote to the customer.</Text>

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
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
        <TouchableOpacity style={[styles.sendBtn, sending && styles.disabled]} onPress={() => void send()} disabled={sending} accessibilityRole="button">
          {sending ? <ActivityIndicator size="small" color={colors.white} /> : <Ionicons name="send" size={16} color={colors.white} />}
          <Text style={styles.sendText}>{sending ? "Sending..." : "Send Email"}</Text>
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
