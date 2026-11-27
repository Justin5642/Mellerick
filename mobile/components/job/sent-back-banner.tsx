import { StyleSheet, Text, View } from "react-native";
import { colors } from "../../lib/theme";
import { sentBackNotice, sentBackWhen, type SentBackJob } from "../../lib/sentBack";

// "Sent back by the office" (0122, a draft) — the note the office wrote to the crew,
// shown above every tab while the job is sent back and open. The job screen
// leaves it off view-only jobs. Rule in lib/sentBack.ts (a copy of the web's).
// Offline it shows what the mirror holds; before the stream redeploy the
// mirror has no admin_status, so nothing shows (the remote read has it).
export function SentBackBanner({ job }: { job: SentBackJob }) {
  const notice = sentBackNotice(job);
  if (!notice) return null;
  const when = sentBackWhen(notice.at);
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.title}>
        ↩ Sent back by the office{when ? <Text style={styles.when}> · {when}</Text> : null}
      </Text>
      <Text style={styles.note}>{notice.note ?? "Ask the office what's needed before it can be approved."}</Text>
      <Text style={styles.hint}>Sort it out, then sign the job off again — it goes back to the office for approval.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    margin: 12,
    marginBottom: 0,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.red100,
    borderWidth: 1,
    borderColor: colors.red600,
  },
  title: { fontSize: 14, fontWeight: "700", color: colors.red600 },
  when: { fontSize: 13, fontWeight: "400" },
  note: { fontSize: 15, color: "#7f1d1d", marginTop: 4 },
  hint: { fontSize: 12, color: colors.red600, marginTop: 6 },
});
