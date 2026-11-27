import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from "react-native";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { colors } from "../../lib/theme";
import {
  bookedDayKeys,
  canFlagMissed,
  isMissed,
  missedDetailText,
  MISSED_NOTE_MAX,
  MISSED_REASONS,
  validateMissed,
  withQueuedMissed,
  type MissedFields,
  type MissedReason,
} from "../../lib/bookingAttendance";
import { useMissedFlags } from "../../lib/data/hooks/useMissedFlags";
import { businessTodayKey } from "../../lib/scheduleDisplay";
import { shiftDateKey } from "../../lib/date";
import type { Booking } from "../../lib/bookings";

// "Didn't make it" on a technician's own booking (Justin, 27 Nov 2026;
// migration 0121). The booking stays where it is, flagged; the office sees a
// red "Didn't make it — <reason>" on the schedule and reschedules it by
// dragging, which clears the flag. Through the outbox (a booking-missed side
// effect), so it works offline. No money.

/** Pick a reason (required), a note (required for Other), confirm. */
export function DidntMakeItSheet({
  visible,
  onClose,
  onConfirm,
  heading,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: MissedReason, note: string | null) => Promise<void> | void;
  heading?: string;
}) {
  const [reason, setReason] = useState<MissedReason | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = () => {
    if (saving) return;
    setReason(null);
    setNote("");
    setError(null);
    onClose();
  };

  const confirm = async () => {
    const v = validateMissed({ reason, note });
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setSaving(true);
    try {
      await onConfirm(v.reason, v.note);
      setReason(null);
      setNote("");
      setError(null);
      onClose();
    } catch {
      setError("Couldn't save that on this phone. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardSheet
      visible={visible}
      onRequestClose={close}
      testID="didnt-make-it-sheet"
      title={
        <View>
          <Text style={styles.title}>Didn&apos;t make it</Text>
          {heading ? <Text style={styles.subtitle}>{heading}</Text> : null}
        </View>
      }
      footer={
        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancel} onPress={close} disabled={saving}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirm, (!reason || saving) && styles.confirmDisabled]}
            onPress={() => void confirm()}
            disabled={!reason || saving}
            accessibilityRole="button"
          >
            <Text style={styles.confirmText}>{saving ? "Saving…" : "Confirm"}</Text>
          </TouchableOpacity>
        </View>
      }
    >
      <Text style={styles.label}>Why? (pick one)</Text>
      {MISSED_REASONS.map((r) => {
        const on = reason === r.key;
        return (
          <TouchableOpacity
            key={r.key}
            style={[styles.reason, on && styles.reasonOn]}
            onPress={() => {
              setReason(r.key);
              setError(null);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.reasonText, on && styles.reasonTextOn]}>{r.label}</Text>
          </TouchableOpacity>
        );
      })}
      <Text style={styles.label}>{reason === "other" ? "What happened? (needed)" : "Note (optional)"}</Text>
      <TextInput
        style={styles.input}
        value={note}
        onChangeText={(t) => {
          setNote(t);
          setError(null);
        }}
        placeholder={reason === "other" ? "e.g. truck broke down" : "Anything the office should know"}
        maxLength={MISSED_NOTE_MAX}
        multiline
      />
      <Text style={styles.hint}>The booking stays where it is. The office will reschedule it.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </KeyboardSheet>
  );
}

/**
 * The "Didn't make it" button on one of the signed-in technician's own
 * bookings — or, once flagged, the red line with Undo. Renders nothing when
 * the booking can't be flagged (someone else's, a future one, a closed job).
 */
export function DidntMakeItControl({
  jobId,
  jobStatus,
  booking,
  currentUserId,
  heading,
}: {
  jobId: string;
  jobStatus: string | null | undefined;
  booking: Booking;
  currentUserId: string | null;
  heading?: string;
}) {
  const { queued, flag, clear } = useMissedFlags();
  const [open, setOpen] = useState(false);
  if (!currentUserId || booking.staff_id !== currentUserId) return null;
  if (!canFlagMissed(booking, jobStatus, businessTodayKey())) return null;
  const shown: MissedFields = withQueuedMissed(booking, queued.get(booking.id));
  const pending = queued.has(booking.id);

  if (isMissed(shown)) {
    return (
      <View style={styles.flagged}>
        <Text style={styles.flaggedText} numberOfLines={3}>
          {missedDetailText(shown)}
          {pending ? " · not sent yet" : ""}
        </Text>
        <TouchableOpacity
          onPress={() =>
            Alert.alert("Undo \"Didn't make it\"?", "The office will see this booking as normal again.", [
              { text: "Keep it", style: "cancel" },
              { text: "Undo", onPress: () => void clear(jobId, booking.id).catch(() => Alert.alert("Couldn't undo", "Try again.")) },
            ])
          }
          accessibilityRole="button"
        >
          <Text style={styles.undo}>Undo</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity style={styles.button} onPress={() => setOpen(true)} accessibilityRole="button" testID="didnt-make-it">
        <Text style={styles.buttonText}>Didn&apos;t make it</Text>
      </TouchableOpacity>
      <DidntMakeItSheet
        visible={open}
        onClose={() => setOpen(false)}
        heading={heading}
        onConfirm={async (reason, note) => {
          await flag(jobId, booking.id, reason, note);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: "700", color: colors.slate900 },
  subtitle: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  label: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginTop: 12, marginBottom: 6 },
  reason: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8, backgroundColor: colors.white },
  reasonOn: { borderColor: colors.red600, backgroundColor: colors.red100 },
  reasonText: { fontSize: 15, color: colors.slate900 },
  reasonTextOn: { color: colors.red600, fontWeight: "700" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    minHeight: 70,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    color: colors.slate900,
    textAlignVertical: "top",
  },
  hint: { fontSize: 12, color: colors.slate500, marginTop: 8 },
  error: { fontSize: 13, color: colors.red600, marginTop: 8, fontWeight: "600" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  cancel: { paddingVertical: 12, paddingHorizontal: 16 },
  cancelText: { fontSize: 15, color: colors.slate700, fontWeight: "600" },
  confirm: { backgroundColor: colors.red600, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20 },
  confirmDisabled: { opacity: 0.5 },
  confirmText: { fontSize: 15, color: colors.white, fontWeight: "700" },
  button: { alignSelf: "flex-start", borderWidth: 1, borderColor: colors.red600, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, marginTop: 8 },
  buttonText: { fontSize: 13, color: colors.red600, fontWeight: "700" },
  flagged: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8, backgroundColor: colors.red100, borderRadius: 8, padding: 8 },
  flaggedText: { flex: 1, fontSize: 13, color: colors.red600, fontWeight: "600" },
  undo: { fontSize: 13, color: colors.blue600, fontWeight: "700" },
});

/** How far back the job screen offers "Didn't make it" (older ones are the office's to sort out). */
export const MISSED_OFFER_DAYS = 7;

/**
 * The job screen's Overview: the signed-in technician's own bookings on this
 * job from the last week up to today, each with "Didn't make it" (or its flag
 * and Undo). Nothing when there are none.
 */
export function MyBookingsDidntMakeIt({
  jobId,
  jobStatus,
  bookings,
  currentUserId,
  describe,
}: {
  jobId: string;
  jobStatus: string | null | undefined;
  bookings: readonly Booking[] | null;
  currentUserId: string | null;
  describe: (b: Booking) => string;
}) {
  if (!bookings || !currentUserId) return null;
  const today = businessTodayKey();
  const from = shiftDateKey(today, -MISSED_OFFER_DAYS);
  const mine = bookings.filter((b) => {
    if (b.staff_id !== currentUserId || !canFlagMissed(b, jobStatus, today)) return false;
    const days = bookedDayKeys(b);
    return isMissed(b) || (days[days.length - 1] ?? today) >= from;
  });
  if (mine.length === 0) return null;
  return (
    <View style={cardStyles.card}>
      <Text style={cardStyles.title}>Couldn&apos;t get to it?</Text>
      {mine.map((b) => (
        <View key={b.id} style={cardStyles.row}>
          <Text style={cardStyles.when}>{describe(b)}</Text>
          <DidntMakeItControl jobId={jobId} jobStatus={jobStatus} booking={b} currentUserId={currentUserId} heading={describe(b)} />
        </View>
      ))}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, marginHorizontal: 16, marginTop: 12 },
  title: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  row: { marginTop: 8 },
  when: { fontSize: 13, color: colors.slate700 },
});
