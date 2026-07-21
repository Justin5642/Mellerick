import "../global.css";
import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View, StyleSheet, Platform, StatusBar as RNStatusBar } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { LocationTrackingProvider } from "../lib/location-tracking";
import { DataProvider } from "../lib/data/DataProvider";
import { SyncStatusPill } from "../design/components/SyncStatusPill";
import { TouchableOpacity, Text } from "react-native";
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
  const { session, profile, loading, signOut } = useAuth();
  const role = profile?.role;
  const isTech = role === "technician";
  const isOffice = role === "office" || role === "admin";
  const isAdmin = role === "admin";
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "login";
    if (!session && !inAuthGroup) {
      router.replace("/login");
    } else if (session && inAuthGroup) {
      // Role-aware landing: office/admin start on the dashboard, techs on My Jobs.
      router.replace(isOffice ? "/dashboard" : "/");
    }
  }, [session, loading, isOffice, segments]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }

  // Fail-closed: signed in but no recognizable role → no group is registered, so
  // show a safe error state instead of a blank shell (never guess a role).
  if (session && !isTech && !isOffice) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, padding: 32, gap: 12 }}>
        <Text style={{ fontSize: 16, fontWeight: "700", color: colors.slate900, textAlign: "center" }}>No role assigned</Text>
        <Text style={{ fontSize: 13, color: colors.slate500, textAlign: "center" }}>
          Your account has no access role yet. Please contact your administrator.
        </Text>
        <TouchableOpacity onPress={signOut} style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.blue600 }}>
          <Text style={{ color: "#fff", fontWeight: "600" }}>Sign out</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Route groups are REGISTERED per role via Stack.Protected — a forbidden route
  // is not mounted or navigable for the wrong role (RLS is the backstop).
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="login" />
      </Stack.Protected>

      <Stack.Protected guard={!!session && isTech}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>

      <Stack.Protected guard={!!session && isOffice}>
        <Stack.Screen name="(office)" />
        <Stack.Screen name="customers" options={{ headerShown: true }} />
        <Stack.Screen name="quotes" options={{ headerShown: true }} />
        <Stack.Screen name="invoices" options={{ headerShown: true }} />
        <Stack.Screen name="pricing" options={{ headerShown: true }} />
        <Stack.Screen name="inventory" options={{ headerShown: true }} />
        <Stack.Screen name="fleet" options={{ headerShown: true }} />
        <Stack.Screen name="reports" options={{ headerShown: true }} />
      </Stack.Protected>

      <Stack.Protected guard={!!session && isAdmin}>
        <Stack.Screen name="staff" options={{ headerShown: true }} />
        <Stack.Screen name="settings" options={{ headerShown: true }} />
      </Stack.Protected>

      {/* Shared across roles (reached from tech tabs and office Jobs/Dashboard). */}
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
