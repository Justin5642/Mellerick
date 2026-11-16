import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors } from "../lib/theme";
import { openExternalUrl } from "../lib/open-external-url";
import { deleteAccountUrl, privacyPolicyUrl } from "../lib/legalLinks";

// "Privacy policy · Delete account" — on the sign-in screen and on each role's
// account area, so the policy is reachable inside the app (App Review
// 5.1.1(i)) and staff can see how to have their account deleted (5.1.1(v)).
export function LegalLinks() {
  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={() => void openExternalUrl(privacyPolicyUrl(), "the privacy policy")} hitSlop={8}>
        <Text style={styles.link}>Privacy policy</Text>
      </TouchableOpacity>
      <Text style={styles.dot}>·</Text>
      <TouchableOpacity onPress={() => void openExternalUrl(deleteAccountUrl(), "the account deletion page")} hitSlop={8}>
        <Text style={styles.link}>Delete account</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, paddingVertical: 12 },
  link: { fontSize: 12, color: colors.slate500, textDecorationLine: "underline" },
  dot: { fontSize: 12, color: colors.slate400 },
});
