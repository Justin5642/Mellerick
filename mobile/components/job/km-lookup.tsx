import { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors } from "../../lib/theme";
import { distanceNote, kmFieldText, type TripEnds } from "../../lib/distanceTrip";
import { lookupDistance, shouldFillKm } from "../../lib/distanceLookup";

// "Work out km" under a km box (truck loads, Day Works floats / cartage by
// km). Online only: one call to /api/distance; the answer fills the box only
// if nobody typed in it while the lookup ran, and the box stays editable.
// Places and km only — no money.
export function KmLookup({ jobId, km, ends, onKm }: {
  jobId: string;
  km: string;
  /** The trip to measure, worked out at the press (or why it can't be). */
  ends: () => TripEnds | { error: string };
  onKm: (km: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  // The latest km and setter, so an answer that lands after more typing sees them.
  const kmRef = useRef(km);
  const onKmRef = useRef(onKm);
  useEffect(() => {
    kmRef.current = km;
    onKmRef.current = onKm;
  });

  async function press() {
    if (busy) return;
    const trip = ends();
    if ("error" in trip) {
      setNote({ text: trip.error, warn: true });
      return;
    }
    const kmAtPress = kmRef.current;
    setBusy(true);
    setNote(null);
    try {
      const r = await lookupDistance(jobId, trip);
      if (shouldFillKm(kmAtPress, kmRef.current)) onKmRef.current(kmFieldText(r.km));
      setNote({ text: distanceNote(r), warn: r.approximate });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "Couldn't work out the km — type them in.", warn: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 4 }}>
      <TouchableOpacity style={styles.button} onPress={() => void press()} disabled={busy} accessibilityRole="button" accessibilityLabel="Work out km by road">
        <Text style={styles.buttonText}>{busy ? "Working out km…" : "📍 Work out km"}</Text>
      </TouchableOpacity>
      {note && <Text style={[styles.note, note.warn && styles.warn]}>{note.text}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { alignSelf: "flex-start", borderWidth: 1, borderColor: colors.blue600, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  buttonText: { color: colors.blue600, fontWeight: "600", fontSize: 14 },
  note: { fontSize: 13, color: colors.slate500 },
  warn: { color: colors.yellow700 },
});
