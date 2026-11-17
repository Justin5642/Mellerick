import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useAuth } from "../../lib/auth-context";
import { colors } from "../../lib/theme";

export default function TabsLayout() {
  const { profile } = useAuth();
  // A limited-access account (the App Store review login; draft migration
  // 0110, not applied yet) receives no backflow register — RLS and the sync
  // streams withhold it — so the tab would only ever be empty. Hidden, not
  // unregistered: the data boundary is the server's, this is cosmetic.
  const hideBackflow = profile?.limited_access === true;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.blue600,
        tabBarInactiveTintColor: colors.slate400,
        tabBarStyle: { borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "My Jobs",
          tabBarIcon: ({ color, size }) => <Ionicons name="briefcase-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: ({ color, size }) => <Ionicons name="search-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="backflow"
        options={{
          title: "Backflow",
          href: hideBackflow ? null : undefined,
          tabBarIcon: ({ color, size }) => <Ionicons name="water-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
