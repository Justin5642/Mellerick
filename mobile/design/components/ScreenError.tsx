import React from "react";
import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { colors } from "../../lib/theme";

// One honest failure state, shared by every screen.
//
// Read modules throw now instead of returning [] when a query fails. Without
// this, a screen that awaits a read and then flips `loading` to false simply
// never flips it — the user gets an infinite spinner, which tells them less than
// the wrong "no jobs" ever did.
//
// Deliberately ONE component rather than a per-screen judgement about whether to
// show stale data, an empty state, or an error. Classifying ~35 screens is ~35
// chances to classify one wrong, and the wrong call here is the expensive
// direction: a screen that decides a failure is "probably empty" recreates the
// exact bug this whole change exists to remove.

export interface ReadFailure {
  title: string;
  detail: string;
  isOffline: boolean;
}

/**
 * Turn whatever was thrown into something a person can act on.
 *
 * The headline is plain language, because the reader may be standing on a roof.
 * The detail keeps the raw message — including the calling function and the
 * Postgres code — because that is the only diagnostic anyone downstream gets,
 * and hiding it is how the Staff screen stayed broken for the app's entire life.
 */
export function describeReadFailure(error: unknown): ReadFailure {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error == null
          ? ""
          : String(error);

  const detail = raw.trim().length > 0 ? raw.trim() : "No error message was reported.";

  // Offline is the one cause the user can actually do something about, so it
  // gets its own headline instead of being buried in a generic failure.
  const isOffline = /network request failed|network error|fetch failed|offline/i.test(detail);

  return {
    title: isOffline ? "You appear to be offline" : "Couldn't load this",
    detail,
    isOffline,
  };
}

export function ScreenError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { title, detail, isOffline } = describeReadFailure(error);

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>
        {isOffline
          ? "Anything you've already saved is safe and will sync when you're back on."
          : "This is a fault on our side, not something you did."}
      </Text>
      <View style={styles.detailBox}>
        <Text style={styles.detail} selectable>
          {detail}
        </Text>
      </View>
      {onRetry ? (
        <Pressable style={styles.button} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 24, alignItems: "center", justifyContent: "center", flexGrow: 1 },
  title: { fontSize: 18, fontWeight: "700", color: colors.slate900, textAlign: "center" },
  body: { marginTop: 8, fontSize: 14, color: colors.slate500, textAlign: "center" },
  detailBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.slate100,
    alignSelf: "stretch",
  },
  // Selectable and monospace: this string is what gets read down a phone line
  // or pasted into a message, so it has to be copyable and unambiguous.
  detail: { fontSize: 12, color: colors.slate500, fontFamily: "monospace" },
  button: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 8,
    backgroundColor: colors.blue600,
  },
  buttonText: { color: colors.white, fontWeight: "600", fontSize: 15 },
});
