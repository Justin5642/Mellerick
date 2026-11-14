import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { colors } from "../../lib/theme";

// Office/admin 5-tab IA — a separate navigator from the technician (tabs) group.
// Which group mounts is decided by role in the root layout (Stack.Protected), so
// a technician never sees these tabs and vice-versa.
// Schedule is the first tab and where office/admin land when the app opens
// (Justin, 15 Nov 2026: "probably the most used part"). initialRouteName
// covers a cold start with a saved session, which skips the login redirect.
export const unstable_settings = { initialRouteName: "schedule" };

export default function OfficeTabsLayout() {
  return (
    <Tabs
      initialRouteName="schedule"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.blue600,
        tabBarInactiveTintColor: colors.slate400,
        tabBarStyle: { borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen
        name="schedule"
        options={{ title: "Schedule", tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="dashboard"
        options={{ title: "Dashboard", tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="jobs"
        options={{ title: "Jobs", tabBarIcon: ({ color, size }) => <Ionicons name="briefcase-outline" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="approvals"
        options={{ title: "Approvals", tabBarIcon: ({ color, size }) => <Ionicons name="checkmark-done-outline" size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: "More", tabBarIcon: ({ color, size }) => <Ionicons name="ellipsis-horizontal" size={size} color={color} /> }}
      />
    </Tabs>
  );
}
