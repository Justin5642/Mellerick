import { useCallback, useEffect, useState } from "react";
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { colors } from "../../lib/theme";
import type { SyncStatus } from "../../lib/data/useSyncStatus";
import type { Operation } from "../../lib/data/outbox/types";
import { describeOperation, explainError, whenQueued } from "../../lib/data/outbox/describe";

// What didn't sync, and why. Opened from the red "N not synced" pill.
//
// Before this, the pill only offered Retry: a change the server refuses every
// time (a time entry on a job you've been taken off, a booking on a job that's
// since been completed) could never be identified, cleared or explained, and
// sat on the phone for good. Each row now says what it was, when it was made,
// and the server's reason — and can be retried or, deliberately, discarded.
export function UnsyncedSheet({ status, onClose }: { status: SyncStatus; onClose: () => void }) {
  const [ops, setOps] = useState<Operation[] | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setOps(await status.listFailed());
    } catch {
      setOps([]);
    }
  }, [status]);

  useEffect(() => {
    void reload();
  }, [reload, status.failed]);

  function retryAll() {
    setBusy(true);
    status.retry();
    // The pill updates itself as the retry drains; close so it can be watched.
    setTimeout(() => {
      setBusy(false);
      onClose();
    }, 600);
  }

  function discard(op: Operation) {
    Alert.alert(
      "Discard this change?",
      `${describeOperation(op)} (${whenQueued(op.createdAt)}) only exists on this phone. Discarding it means the office will never get it. This can't be undone.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: async () => {
            await status.discard(op.id);
            await reload();
          },
        },
      ]
    );
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Not synced</Text>
          <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.close}>Close</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.intro}>
          The office refused these changes, so they are only on this phone. Retry once the reason is sorted, or discard one you no longer need.
        </Text>

        {ops === null ? (
          <ActivityIndicator color={colors.blue600} style={{ marginTop: 24 }} />
        ) : ops.length === 0 ? (
          <Text style={styles.empty}>Everything has synced.</Text>
        ) : (
          <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 24 }}>
            {ops.map((op) => (
              <View key={op.id} style={styles.row} testID={`unsynced-${op.id}`}>
                <Text style={styles.what}>{describeOperation(op)}</Text>
                <Text style={styles.when}>{whenQueued(op.createdAt)}</Text>
                <Text style={styles.why}>{explainError(op.error)}</Text>
                {!!op.error && <Text style={styles.raw} selectable>{op.error}</Text>}
                <TouchableOpacity style={styles.discard} onPress={() => discard(op)} accessibilityRole="button" accessibilityLabel={`Discard ${describeOperation(op)}`}>
                  <Text style={styles.discardText}>Discard</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

        {ops !== null && ops.length > 0 && (
          <TouchableOpacity style={styles.retry} onPress={retryAll} disabled={busy} accessibilityRole="button">
            <Text style={styles.retryText}>{busy ? "Retrying…" : `Retry ${ops.length === 1 ? "it" : `all ${ops.length}`}`}</Text>
          </TouchableOpacity>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12, backgroundColor: colors.bg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 8 },
  title: { fontSize: 20, fontWeight: "700", color: colors.slate900 },
  close: { fontSize: 16, fontWeight: "600", color: colors.blue600 },
  intro: { fontSize: 14, color: colors.slate500 },
  empty: { fontSize: 15, color: colors.slate500, marginTop: 24, textAlign: "center" },
  row: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 4 },
  what: { fontSize: 16, fontWeight: "700", color: colors.slate900 },
  when: { fontSize: 12, color: colors.slate500 },
  why: { fontSize: 14, color: colors.slate700, marginTop: 4 },
  raw: { fontSize: 11, color: colors.slate500 },
  discard: { alignSelf: "flex-start", marginTop: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: colors.red600 },
  discardText: { fontSize: 14, fontWeight: "600", color: colors.red600 },
  retry: { paddingVertical: 16, borderRadius: 12, alignItems: "center", backgroundColor: colors.blue600 },
  retryText: { fontSize: 16, fontWeight: "700", color: "#fff" },
});
