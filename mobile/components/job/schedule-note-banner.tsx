import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { bookingNotesToShow, type BookingNoteToShow } from "../../lib/bookingNotes";
import type { JobBooking } from "../../lib/data/reads/bookings";

// The scheduling notes for this job's CURRENT and UPCOMING bookings, at the
// very top of the Overview tab — the first thing a technician sees on opening
// the job. Since migration 0109 (a draft until applied) a note belongs to the booking it was written
// for (job_bookings.note), so it stops showing once that booking is over
// (Justin, 16 Nov 2026: "that note needs to be just for that schedule and not
// carry on every time the job is opened"). Which notes, for whom: see
// lib/bookingNotes.ts. The job_notes copy (source 'schedule') stays in Notes &
// Activity as the history, badged "Scheduling note"; it is no longer read
// here, so a note written before 0109 no longer follows the job around.
//
// The bookings come from the job screen's own read (listJobBookings — local
// first, so this works offline once the sync streams carry `note`). No
// bookings, or none with a note that is still current → no banner.
//
// The first time a given note is shown on this device it ALSO pops up as a
// modal, so a technician opening the job from My Jobs can't miss it. Seen-ness
// is keyed by booking + the note's text, so an edited note (or a new booking's
// note) pops up again, while reopening the job or switching tabs doesn't.
const SEEN_KEY_PREFIX = "scheduleNoteSeen:booking:";

export function seenKey(bookingId: string): string {
  return `${SEEN_KEY_PREFIX}${bookingId}`;
}

/** True when this booking's note (this exact text) hasn't been acknowledged on this device yet. */
export async function shouldPopUp(bookingId: string, note: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(seenKey(bookingId))) !== note;
  } catch {
    return false; // storage unavailable: the banner still shows; don't nag
  }
}

export async function markSeen(bookingId: string, note: string): Promise<void> {
  try {
    await AsyncStorage.setItem(seenKey(bookingId), note);
  } catch {
    // Best-effort: worst case it pops up once more next time.
  }
}

function label(n: BookingNoteToShow): string {
  return n.staffName ? `${n.staffName} · ${n.when}` : n.when;
}

export function ScheduleNoteBanner({
  bookings,
  userId,
  isOffice,
}: {
  /** The job's bookings (null before bookings exist, or when unreadable — no banner). */
  bookings: JobBooking[] | null | undefined;
  userId: string | null;
  isOffice: boolean;
}) {
  const notes = useMemo(() => bookingNotesToShow(bookings, { userId, isOffice }), [bookings, userId, isOffice]);
  const [unseen, setUnseen] = useState<BookingNoteToShow[]>([]);
  // Stands for `notes` in the effect below: a fresh array holding the same
  // notes (every bookings reload) must not re-run it.
  const notesKey = JSON.stringify(notes.map((n) => [n.bookingId, n.note]));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fresh: BookingNoteToShow[] = [];
      for (const n of notes) if (await shouldPopUp(n.bookingId, n.note)) fresh.push(n);
      if (!cancelled) setUnseen(fresh);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesKey]);

  if (notes.length === 0) return null;

  function dismiss() {
    const seen = unseen;
    setUnseen([]);
    for (const n of seen) void markSeen(n.bookingId, n.note);
  }

  return (
    <>
      <Modal visible={unseen.length > 0} transparent animationType="fade" onRequestClose={dismiss}>
        <View style={styles.overlay}>
          <View style={styles.dialog} accessibilityRole="alert">
            <View style={styles.header}>
              <Ionicons name="calendar" size={16} color={colors.blue600} />
              <Text style={styles.dialogTitle}>Scheduling note{unseen.length === 1 ? "" : "s"}</Text>
            </View>
            {unseen.map((n) => (
              <View key={n.bookingId} style={styles.item}>
                <Text style={styles.meta}>{label(n)}</Text>
                <Text style={styles.dialogContent}>{n.note}</Text>
              </View>
            ))}
            <TouchableOpacity style={styles.okBtn} onPress={dismiss} accessibilityLabel="Dismiss scheduling note">
              <Text style={styles.okText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <View style={styles.banner}>
        <View style={styles.header}>
          <Ionicons name="calendar" size={14} color={colors.blue600} />
          <Text style={styles.headerText}>Scheduling note{notes.length === 1 ? "" : "s"}</Text>
        </View>
        {notes.map((n) => (
          <View key={n.bookingId} style={styles.item}>
            <Text style={styles.meta}>{label(n)}</Text>
            <Text style={styles.content}>{n.note}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.blue100, borderRadius: 10, padding: 12, marginBottom: 12, gap: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { fontSize: 12, fontWeight: "700", color: colors.blue600, textTransform: "uppercase" },
  item: { gap: 2 },
  content: { fontSize: 14, color: colors.slate900 },
  meta: { fontSize: 11, color: colors.slate400 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 24 },
  dialog: { backgroundColor: colors.card, borderRadius: 14, padding: 18, gap: 10 },
  dialogTitle: { fontSize: 13, fontWeight: "800", color: colors.blue600, textTransform: "uppercase" },
  dialogContent: { fontSize: 16, color: colors.slate900, lineHeight: 22 },
  okBtn: { marginTop: 6, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  okText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
