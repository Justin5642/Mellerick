import "../global.css";
import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View, StyleSheet, Platform, StatusBar as RNStatusBar } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { LocationTrackingProvider } from "../lib/location-tracking";
import { DataProvider } from "../lib/data/DataProvider";
import { SyncStatusPill } from "../design/components/SyncStatusPill";
import { colors } from "../lib/theme";

// Floating, app-wide sync indicator: invisible when synced, "Syncing N…" while
// writes are in flight, and a tappable "N not synced · Retry" when writes have
// terminally failed — so a dead-lettered offline write is never invisible.
// box-none lets touches pass through everywhere except the pill itself.
function SyncStatusOverlay() {
  const top = (Platform.OS === "android" ? RNStatusBar.currentHeight ?? 24 : 50) + 6;
  return (
    <View pointerEvents="box-none" style={[styles.syncOverlay, { top }]}>
      <SyncStatusPill />
    </View>
  );
}

function RootNavigation() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "login";

    if (!session && !inAuthGroup) {
      router.replace("/login");
    } else if (session && inAuthGroup) {
      router.replace("/");
    }
  }, [session, loading, segments]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="job/[id]" options={{ headerShown: true, title: "Job Details" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <DataProvider>
        <LocationTrackingProvider>
          <StatusBar style="dark" />
          <RootNavigation />
          <SyncStatusOverlay />
        </LocationTrackingProvider>
      </DataProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  syncOverlay: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 1000 },
});
