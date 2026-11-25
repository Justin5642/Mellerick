import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, Image, ScrollView } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { colors } from "../../lib/theme";
import { BUSINESS_TIME_ZONE, dateKeyInBusinessTZ, formatBusinessTime } from "../../lib/date";

import { cryptoIdGen } from "../../lib/data/ids";
import { prepareImage } from "../../lib/imageUpload";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { addMistakePhoto, isMistakesOffline, loadMistakes, MISTAKES_OFFLINE, raiseMistake, type CrewMistakeState } from "../../lib/mistakes";
import {
  buildRaiseBody,
  causeLabel,
  emptyRaiseForm,
  MAX_MISTAKE_PHOTOS,
  MISTAKE_CAUSES,
  MISTAKE_DESCRIPTION_MAX,
  mistakeStatusLabel,
  myMistakeSummary,
  type RaiseMistakeForm,
} from "../../lib/mistakeRaise";

const formatTime = formatBusinessTime;
/** "Tue 25 Nov" — a date key or an instant, in Melbourne. */
function formatDate(value: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });
}

// "Mistakes" on the job (Justin, 25 Nov 2026: crew raise, office costs;
// migration 0119 (a draft, not applied yet)). Anyone on the job — and office — logs a mistake: what kind,
// the stage, the cause if known, what happened, photos, and their own time on
// the job that went on rework. NO MONEY: the crew never enter or see a dollar
// figure; the office costs it on the website. Online only (lib/mistakes.ts).

type Status = { kind: "loading" } | { kind: "offline" } | { kind: "error"; message: string } | { kind: "ok"; state: CrewMistakeState };

export function JobMistakesTab({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RaiseMistakeForm>(emptyRaiseForm);
  const [photos, setPhotos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Made before the first Save and kept across retries, so a retry after a
  // dropped answer can't log the mistake twice.
  const mistakeId = useRef(cryptoIdGen.newId());

  const reload = useCallback(() => {
    loadMistakes(jobId)
      .then((state) => setStatus({ kind: "ok", state }))
      .catch((e) => setStatus(isMistakesOffline(e) ? { kind: "offline" } : { kind: "error", message: e instanceof Error ? e.message : "Couldn't load." }));
  }, [jobId]);
  useEffect(reload, [reload]);

  function start() {
    if (status.kind !== "ok") return;
    const openStages = status.state.stages.filter((s) => !s.completed);
    mistakeId.current = cryptoIdGen.newId();
    setForm({ ...emptyRaiseForm(), costCenterId: openStages.length === 1 ? openStages[0].id : "" });
    setPhotos([]);
    setFormError(null);
    setOpen(true);
  }

  async function pick(fromCamera: boolean) {
    const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(fromCamera ? "Camera needed" : "Photos needed", "Allow access to add a photo of the mistake.");
      return;
    }
    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsMultipleSelection: true });
    if (result.canceled || !result.assets?.length) return;
    setPhotos((list) => [...list, ...result.assets.map((a) => a.uri)].slice(0, MAX_MISTAKE_PHOTOS));
  }

  async function save() {
    const built = buildRaiseBody(mistakeId.current, form, dateKeyInBusinessTZ(new Date()));
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const state = await raiseMistake(jobId, built.body);
      let failed = 0;
      for (const uri of photos) {
        try {
          const { base64 } = await prepareImage(uri, { base64: true });
          if (!base64) throw new Error("no photo");
          await addMistakePhoto(jobId, built.body.id, base64);
        } catch {
          failed += 1;
        }
      }
      setStatus({ kind: "ok", state });
      setOpen(false);
      Alert.alert("Mistake logged", failed ? `${failed} photo${failed === 1 ? "" : "s"} didn't upload — the mistake is saved.` : "Thanks — the office will cost it.");
    } catch (e) {
      setFormError(isMistakesOffline(e) ? MISTAKES_OFFLINE : e instanceof Error ? e.message : "Couldn't log the mistake. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (status.kind === "loading") return <ActivityIndicator style={{ marginTop: 24 }} color={colors.blue600} />;
  if (status.kind === "offline") return <Text style={styles.note}>{MISTAKES_OFFLINE}</Text>;
  if (status.kind === "error") return <Text style={[styles.note, { color: colors.red600 }]}>{status.message}</Text>;
  const { state } = status;
  if (!state.ready) return <Text style={styles.note}>Logging mistakes isn&apos;t switched on yet — tell the office.</Text>;
  const taken = new Set(state.mistakes.flatMap((m) => m.reworkEntryIds));

  return (
    <View style={{ padding: 16, gap: 12 }}>
      <TouchableOpacity style={styles.primary} onPress={start} accessibilityRole="button">
        <Text style={styles.primaryText}>Log mistake</Text>
      </TouchableOpacity>
      {state.mistakes.length === 0 ? (
        <Text style={styles.note}>Wrong material, damage, rework, a callback? Log it here so the office can sort it out.</Text>
      ) : (
        state.mistakes.map((m) => (
          <View key={m.id} style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.title}>{myMistakeSummary(m)}</Text>
              <Text style={styles.meta}>
                {formatDate(m.occurredOn)} · {mistakeStatusLabel(m.status)}
              </Text>
            </View>
            <Text style={styles.body}>{m.description}</Text>
            <Text style={styles.meta}>
              {[causeLabel(m.causeCode), m.photoCount ? `${m.photoCount} photo${m.photoCount === 1 ? "" : "s"}` : null, m.reworkEntryIds.length ? `${m.reworkEntryIds.length} rework time entr${m.reworkEntryIds.length === 1 ? "y" : "ies"}` : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
        ))
      )}

      <KeyboardSheet
        visible={open}
        onRequestClose={() => !saving && setOpen(false)}
        title="Log a mistake"
        footer={
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <TouchableOpacity style={styles.secondary} onPress={() => setOpen(false)} disabled={saving}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primary} onPress={() => void save()} disabled={saving}>
              {saving ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryText}>Log mistake</Text>}
            </TouchableOpacity>
          </View>
        }
      >
        <Text style={styles.label}>What kind of mistake</Text>
        <Chips options={state.categories.map((c) => ({ value: c.id, label: c.name }))} value={form.categoryId} onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))} />
        {state.stages.length > 0 && (
          <>
            <Text style={styles.label}>Stage / cost centre</Text>
            <Chips
              options={[{ value: "", label: "Not sure" }, ...state.stages.map((s) => ({ value: s.id, label: s.completed ? `${s.name} (complete)` : s.name }))]}
              value={form.costCenterId}
              onChange={(v) => setForm((f) => ({ ...f, costCenterId: v }))}
            />
          </>
        )}
        <Text style={styles.label}>Cause (if you know)</Text>
        <Chips options={[{ value: "", label: "Not sure" }, ...MISTAKE_CAUSES.map((c) => ({ value: c.value, label: c.label }))]} value={form.causeCode} onChange={(v) => setForm((f) => ({ ...f, causeCode: v }))} />
        <Text style={styles.label}>What went wrong</Text>
        <TextInput
          style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
          multiline
          maxLength={MISTAKE_DESCRIPTION_MAX}
          value={form.description}
          onChangeText={(t) => setForm((f) => ({ ...f, description: t }))}
          placeholder="e.g. Pit set 50 mm too high — dug out and reset"
          placeholderTextColor={colors.slate400}
        />
        <Text style={styles.label}>Photos</Text>
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
          {photos.map((uri, i) => (
            <TouchableOpacity key={uri} onPress={() => setPhotos((l) => l.filter((_, j) => j !== i))} accessibilityLabel="Remove photo">
              <Image source={{ uri }} style={styles.thumb} />
            </TouchableOpacity>
          ))}
        </ScrollView>
        {photos.length < MAX_MISTAKE_PHOTOS && (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity style={styles.secondary} onPress={() => void pick(true)}>
              <Text style={styles.secondaryText}>Take photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondary} onPress={() => void pick(false)}>
              <Text style={styles.secondaryText}>From library</Text>
            </TouchableOpacity>
          </View>
        )}
        {state.timeEntries.length > 0 && (
          <>
            <Text style={styles.label}>Your time that went on fixing it</Text>
            {state.timeEntries.map((t) => {
              const ticked = form.timeEntryIds.includes(t.id);
              const done = taken.has(t.id);
              return (
                <TouchableOpacity
                  key={t.id}
                  disabled={done}
                  style={[styles.entry, ticked && styles.entryOn]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: ticked, disabled: done }}
                  onPress={() =>
                    setForm((f) => ({ ...f, timeEntryIds: ticked ? f.timeEntryIds.filter((x) => x !== t.id) : [...f.timeEntryIds, t.id] }))
                  }
                >
                  <Text style={[styles.body, done && { color: colors.slate400 }]}>
                    {ticked ? "☑ " : "☐ "}
                    {formatDate(t.clockIn)} · {formatTime(t.clockIn)}
                    {t.clockOut ? `–${formatTime(t.clockOut)}` : " (on now)"}
                    {t.hours != null ? ` · ${t.hours} h` : ""}
                    {done ? " · already marked" : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}
        {formError && <Text style={{ color: colors.red600 }}>{formError}</Text>}
      </KeyboardSheet>
    </View>
  );
}

function Chips({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => (
        <TouchableOpacity
          key={o.value || "none"}
          style={[styles.chip, value === o.value && styles.chipOn]}
          onPress={() => onChange(o.value)}
          accessibilityRole="button"
          accessibilityState={{ selected: value === o.value }}
        >
          <Text style={[styles.chipText, value === o.value && { color: colors.white }]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { padding: 16, color: colors.slate500, fontSize: 14 },
  card: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  title: { fontWeight: "600", color: colors.slate900, flexShrink: 1 },
  body: { color: colors.slate700, fontSize: 14 },
  meta: { color: colors.slate500, fontSize: 12 },
  label: { color: colors.slate700, fontWeight: "600", marginTop: 8 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, color: colors.slate900, backgroundColor: colors.white },
  primary: { backgroundColor: colors.blue600, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
  primaryText: { color: colors.white, fontWeight: "600" },
  secondary: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: "center" },
  secondaryText: { color: colors.slate700, fontWeight: "500" },
  chip: { borderColor: colors.border, borderWidth: 1, borderRadius: 16, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: colors.white },
  chipOn: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { color: colors.slate700, fontSize: 13 },
  thumb: { width: 64, height: 64, borderRadius: 6 },
  entry: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 8 },
  entryOn: { borderColor: colors.blue600, backgroundColor: colors.blue100 },
});
