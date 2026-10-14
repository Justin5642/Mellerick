import { Modal, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "../design/components/Button";
import { colors } from "../lib/theme";

// The Google Play "prominent disclosure" screen (lib/locationDisclosure.ts).
// Full screen, not a toast or a line in settings: the policy wants it in the
// normal flow of the app, before the OS prompt, with an explicit choice. The
// wording must name location, say it is collected when the app is closed or
// not in use, and say what it is used for — keep all three if editing.

export const DISCLOSURE_TITLE = "Automatic clock in and out";
export const DISCLOSURE_BODY =
  "Mellerick Field collects your location to clock you in and out automatically when you arrive at and leave your job sites, and to record travel time between jobs for your timesheet — even when the app is closed or not in use.";
export const DISCLOSURE_POINTS = [
  "Only while you have an open job, during work hours or while you're on the clock.",
  "A notification is shown whenever it's running.",
  "Used only for your time entries. Your location history isn't stored or shared, and never used for ads.",
];
export const DISCLOSURE_NEXT =
  "On the next screens, choose \"While using the app\", then \"Allow all the time\" so travel time is recorded with the phone in your pocket.";

export function LocationDisclosure({
  visible,
  onAccept,
  onDecline,
}: {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onDecline}>
      <SafeAreaView className="flex-1 bg-white dark:bg-slate-950">
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 40, paddingBottom: 24 }}>
          <View className="items-center mb-6">
            <View className="w-20 h-20 rounded-full bg-sky-100 dark:bg-sky-900 items-center justify-center">
              <Ionicons name="location" size={40} color={colors.blue600} />
            </View>
          </View>
          <Text accessibilityRole="header" className="text-2xl font-bold text-center text-slate-900 dark:text-slate-100 mb-4">
            {DISCLOSURE_TITLE}
          </Text>
          <Text className="text-base leading-6 text-slate-700 dark:text-slate-300 mb-5">{DISCLOSURE_BODY}</Text>
          {DISCLOSURE_POINTS.map((point) => (
            <View key={point} className="flex-row mb-3">
              <Ionicons name="checkmark-circle" size={20} color={colors.blue600} style={{ marginRight: 10, marginTop: 1 }} />
              <Text className="flex-1 text-base leading-6 text-slate-700 dark:text-slate-300">{point}</Text>
            </View>
          ))}
          <Text className="text-sm leading-5 text-slate-500 dark:text-slate-400 mt-3">{DISCLOSURE_NEXT}</Text>
        </ScrollView>
        <View className="px-6 pb-6 gap-3">
          <Button title="Continue" size="lg" onPress={onAccept} />
          <Button title="No thanks — I'll clock in by hand" variant="ghost" onPress={onDecline} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
