import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Modal, TextInput, Alert, ScrollView, Switch } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { supabase } from "../lib/supabase";
import {
  listStaff,
  saveStaff,
  listLeave,
  addLeave,
  removeLeave,
  LEAVE_TYPES,
  type StaffMember,
  type LeaveEntry,
  type LeaveType,
} from "../lib/data/reads/staff";
import { leaveLabel, validateLeaveTimes } from "../lib/staffLeave";
import {
  autoClockEnabled,
  inviteStaff,
  loginDetailsChanged,
  resendInvite,
  setAutoClock,
  staffFormProblem,
  updateStaffLogin,
  type StaffRole,
} from "../lib/staffAdmin";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../components/KeyboardSheet";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

/** "07:30" → "07:30"; "07:30:00" (Postgres time) → "07:30". */
const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");

const ROLES = ["technician", "office", "admin"] as const;
const roleColor: Record<string, { bg: string; text: string }> = {
  admin: { bg: colors.purple100, text: colors.purple700 },
  office: { bg: colors.blue100, text: colors.blue600 },
  technician: { bg: colors.slate100, text: colors.slate500 },
};

interface Draft {
  id: string;
  full_name: string;
  email: string;
  role: (typeof ROLES)[number];
  is_active: boolean;
  phone: string;
  hourly_rate: string;
  super_rate: string;
  workers_comp_rate: string;
  leave_loading_rate: string;
  annual_fixed_oncosts: string;
  target_hours_per_week: string;
  charge_out_rate: string;
  /** As loaded — the login route is only called when name or email changed. */
  original: { full_name: string; email: string };
  auto_clock: boolean | null;
}

function toDraft(s: StaffMember): Draft {
  const c = s.staff_cost_profiles;
  return {
    id: s.id,
    full_name: s.full_name,
    email: s.email,
    original: { full_name: s.full_name, email: s.email },
    auto_clock: s.auto_clock ?? null,
    role: (s.role as Draft["role"]) ?? "technician",
    is_active: s.is_active,
    phone: s.phone ?? "",
    hourly_rate: String(c?.hourly_rate ?? 0),
    super_rate: String(c?.super_rate ?? 12), // Super Guarantee from 1 July 2025
    workers_comp_rate: String(c?.workers_comp_rate ?? 0),
    leave_loading_rate: String(c?.leave_loading_rate ?? 0),
    annual_fixed_oncosts: String(c?.annual_fixed_oncosts ?? 0),
    target_hours_per_week: String(c?.target_hours_per_week ?? 38),
    charge_out_rate: c?.charge_out_rate != null ? String(c.charge_out_rate) : "",
  };
}

export default function StaffScreen() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [leave, setLeave] = useState<LeaveEntry[]>([]);
  const [leaveDraft, setLeaveDraft] = useState<{
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    hours: string;
    notes: string;
    startTime: string;
    endTime: string;
  } | null>(null);
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resetSending, setResetSending] = useState(false);
  const [inviteResending, setInviteResending] = useState(false);
  const [autoClockSaving, setAutoClockSaving] = useState(false);
  // "+ Invite" (admin — this screen is only registered for admins).
  const [invite, setInvite] = useState<{ full_name: string; email: string; phone: string; role: StaffRole } | null>(null);
  const [inviting, setInviting] = useState(false);

  // A failed load must not look like an empty roster. listStaff now throws
  // rather than returning [], so the screen can say "could not load" instead of
  // "No staff." — the latter is a lie that reads as fact.
  const load = useCallback(async () => {
    try {
      setStaff(await listStaff());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      if (__DEV__) console.warn("[staff] load failed:", e);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  // ?staff=<id> — opened from a leave block on the Schedule tab ("Open leave
  // record", admin only): open that person's editor, where the Leave log is,
  // once the roster has loaded. Once per visit, so closing it stays closed.
  const { staff: openStaffId } = useLocalSearchParams<{ staff?: string }>();
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!openStaffId || openedFor.current === openStaffId) return;
    const member = staff.find((s) => s.id === openStaffId);
    if (!member) return;
    openedFor.current = openStaffId;
    setDraft(toDraft(member));
  }, [openStaffId, staff]);

  // Load the leave log whenever the editor opens for a staff member.
  const staffId = draft?.id;
  useEffect(() => {
    if (!staffId) { setLeave([]); setLeaveDraft(null); return; }
    let cancelled = false;
    listLeave(staffId).then((l) => !cancelled && setLeave(l)).catch(() => {});
    return () => { cancelled = true; };
  }, [staffId]);

  async function saveLeave() {
    if (!leaveDraft || !staffId || leaveSaving) return;
    const hours = parseFloat(leaveDraft.hours);
    if (!leaveDraft.startDate.trim() || !leaveDraft.endDate.trim() || Number.isNaN(hours)) {
      Alert.alert("Missing details", "Start date, end date and hours are required.");
      return;
    }
    // Part day (0112): optional From/To, Melbourne time, the same on each day.
    const startTime = leaveDraft.startTime.trim();
    const endTime = leaveDraft.endTime.trim();
    const timeError = validateLeaveTimes(startTime, endTime);
    if (timeError) {
      Alert.alert("Check the times", timeError);
      return;
    }
    setLeaveSaving(true);
    try {
      await addLeave({
        staffId,
        leaveType: leaveDraft.leaveType,
        startDate: leaveDraft.startDate.trim(),
        endDate: leaveDraft.endDate.trim(),
        hours,
        notes: leaveDraft.notes.trim() || null,
        startTime: startTime || null,
        endTime: endTime || null,
      });
      setLeaveDraft(null);
      setLeave(await listLeave(staffId));
    } catch (e) {
      Alert.alert("Couldn't add leave", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setLeaveSaving(false);
    }
  }
  function confirmRemoveLeave(l: LeaveEntry) {
    Alert.alert("Remove leave", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await removeLeave(l.id); if (staffId) setLeave(await listLeave(staffId)); } },
    ]);
  }

  async function save() {
    if (!draft || saving) return;
    const num = (s: string) => (s.trim() === "" ? 0 : parseFloat(s));
    const loginChanged = loginDetailsChanged(draft.original, draft);
    if (loginChanged) {
      const problem = staffFormProblem(draft);
      if (problem) {
        Alert.alert("Check the details", problem);
        return;
      }
    }
    setSaving(true);
    try {
      // Name / login email first, through the admin route — it also moves the
      // Supabase Auth login. If that's refused, nothing else is saved.
      if (loginChanged) {
        try {
          await updateStaffLogin({ id: draft.id, full_name: draft.full_name, email: draft.email, phone: draft.phone, role: draft.role });
        } catch (e) {
          Alert.alert("Couldn't change the login", e instanceof Error ? e.message : "Please try again.");
          return;
        }
      }
      await saveStaff({
        id: draft.id,
        role: draft.role,
        isActive: draft.is_active,
        phone: draft.phone.trim() || null,
        cost: {
          hourly_rate: num(draft.hourly_rate),
          super_rate: num(draft.super_rate),
          workers_comp_rate: num(draft.workers_comp_rate),
          leave_loading_rate: num(draft.leave_loading_rate),
          annual_fixed_oncosts: num(draft.annual_fixed_oncosts),
          target_hours_per_week: num(draft.target_hours_per_week),
          // Blank clears the override (null) so the default charge-out applies.
          charge_out_rate: draft.charge_out_rate.trim() === "" ? null : parseFloat(draft.charge_out_rate),
        },
      });
      setDraft(null);
      await load();
    } catch {
      Alert.alert("Save failed", "Couldn't save — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  // Same call the login screen's own "Forgot password?" makes — Supabase sends
  // the reset link regardless of who triggers it. Doing it from here means a
  // dismissed or locked-out tech doesn't need to be talked through finding
  // their own reset flow.
  async function sendPasswordReset() {
    if (!draft || resetSending) return;
    setResetSending(true);
    // The saved login, not an unsaved edit in the Login email field.
    const email = draft.original.email;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${API_BASE_URL}/update-password`,
    });
    setResetSending(false);
    if (error) {
      Alert.alert("Couldn't send reset email", error.message);
    } else {
      Alert.alert("Sent", `Password reset email sent to ${email}.`);
    }
  }

  // A fresh invite link, for someone who never set a password.
  async function onResendInvite() {
    if (!draft || inviteResending) return;
    setInviteResending(true);
    try {
      await resendInvite({ email: draft.original.email, full_name: draft.original.full_name, role: draft.role });
      Alert.alert("Sent", `Invite re-sent to ${draft.original.email}.`);
    } catch (e) {
      Alert.alert("Couldn't resend the invite", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setInviteResending(false);
    }
  }

  // Auto clock on site arrival (0082). Saved straight away, like the web
  // switch; shows the effective value (by role until an admin chooses).
  async function onToggleAutoClock(next: boolean) {
    if (!draft || autoClockSaving) return;
    setAutoClockSaving(true);
    try {
      await setAutoClock(draft.id, next);
      setDraft((d) => d && { ...d, auto_clock: next });
      setStaff((s) => s.map((m) => (m.id === draft.id ? { ...m, auto_clock: next } : m)));
    } catch (e) {
      Alert.alert("Couldn't change auto clock", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setAutoClockSaving(false);
    }
  }

  async function sendInvite() {
    if (!invite || inviting) return;
    const problem = staffFormProblem(invite);
    if (problem) {
      Alert.alert("Check the details", problem);
      return;
    }
    setInviting(true);
    try {
      await inviteStaff(invite);
      Alert.alert("Invite sent", `${invite.full_name.trim()} will get an email at ${invite.email.trim().toLowerCase()} to set a password.`);
      setInvite(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't send the invite", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setInviting(false);
    }
  }

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => d && { ...d, [k]: v });

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Staff",
          headerRight: () => (
            <TouchableOpacity
              onPress={() => setInvite({ full_name: "", email: "", phone: "", role: "technician" })}
              accessibilityLabel="Invite staff member"
              style={styles.headerBtn}
            >
              <Text style={styles.addText}>+ Invite</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <FlatList
        data={staff}
        keyExtractor={(s) => s.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        ListEmptyComponent={
          loadError
            ? <Text style={styles.empty}>{`Could not load staff.

${loadError}

Pull down to retry.`}</Text>
            : <Text style={styles.empty}>No staff.</Text>
        }
        renderItem={({ item }) => {
          const rc = roleColor[item.role] ?? roleColor.technician;
          return (
            <TouchableOpacity style={styles.row} onPress={() => setDraft(toDraft(item))}>
              <View style={styles.body}>
                <View style={styles.nameRow}>
                  <Text style={[styles.name, !item.is_active && styles.inactive]} numberOfLines={1}>{item.full_name}</Text>
                  <View style={[styles.roleBadge, { backgroundColor: rc.bg }]}><Text style={[styles.roleText, { color: rc.text }]}>{item.role}</Text></View>
                  {!item.is_active && <Text style={styles.inactiveTag}>inactive</Text>}
                </View>
                <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
              </View>
              <View style={styles.rateCol}>
                <MoneyText amount={item.staff_cost_profiles?.hourly_rate} style={styles.rate} />
                <Text style={styles.rateUnit}>/ hr</Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{draft?.full_name}</Text>
            <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>Role</Text>
              <View style={styles.segment}>
                {ROLES.map((r) => (
                  <TouchableOpacity key={r} style={[styles.segItem, draft?.role === r && styles.segItemActive]} onPress={() => setDraft((d) => d && { ...d, role: r })}>
                    <Text style={[styles.segText, draft?.role === r && styles.segTextActive]}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Active</Text>
                <Switch value={draft?.is_active ?? true} onValueChange={(v) => setDraft((d) => d && { ...d, is_active: v })} />
              </View>
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchLabel}>Auto clock on/off at sites</Text>
                  <Text style={styles.switchHint}>
                    {draft?.auto_clock == null ? "By role (technicians on, office off). " : ""}Saved straight away.
                  </Text>
                </View>
                <Switch
                  value={draft ? autoClockEnabled({ role: draft.role, auto_clock: draft.auto_clock }) : false}
                  onValueChange={(v) => void onToggleAutoClock(v)}
                  disabled={autoClockSaving}
                />
              </View>
              <Field label="Name" value={draft?.full_name ?? ""} onChange={set("full_name")} />
              <Field label="Login email" value={draft?.email ?? ""} onChange={set("email")} email />
              {draft && draft.email.trim().toLowerCase() !== draft.original.email.trim().toLowerCase() && (
                <Text style={styles.switchHint}>Saving changes the email they sign in with.</Text>
              )}
              <TouchableOpacity style={styles.resetBtn} onPress={sendPasswordReset} disabled={resetSending}>
                <Ionicons name="key-outline" size={14} color={colors.blue600} />
                <Text style={styles.resetBtnText}>{resetSending ? "Sending…" : "Send password reset email"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resetBtn} onPress={onResendInvite} disabled={inviteResending}>
                <Ionicons name="mail-outline" size={14} color={colors.blue600} />
                <Text style={styles.resetBtnText}>{inviteResending ? "Sending…" : "Resend invite (never set a password)"}</Text>
              </TouchableOpacity>
              <Field label="Phone" value={draft?.phone ?? ""} onChange={set("phone")} />
              <Text style={styles.section}>Pay & on-costs</Text>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Hourly rate ($)" value={draft?.hourly_rate ?? ""} onChange={set("hourly_rate")} num /></View>
                <View style={{ flex: 1 }}><Field label="Super (%)" value={draft?.super_rate ?? ""} onChange={set("super_rate")} num /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Workers comp (%)" value={draft?.workers_comp_rate ?? ""} onChange={set("workers_comp_rate")} num /></View>
                <View style={{ flex: 1 }}><Field label="Leave loading (%)" value={draft?.leave_loading_rate ?? ""} onChange={set("leave_loading_rate")} num /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Annual oncosts ($)" value={draft?.annual_fixed_oncosts ?? ""} onChange={set("annual_fixed_oncosts")} num /></View>
                <View style={{ flex: 1 }}><Field label="Target hrs/wk" value={draft?.target_hours_per_week ?? ""} onChange={set("target_hours_per_week")} num /></View>
              </View>
              <Field label="Charge-out rate ($/h, optional — blank = default)" value={draft?.charge_out_rate ?? ""} onChange={set("charge_out_rate")} num />

              <View style={styles.leaveHead}>
                <Text style={styles.section}>Leave log</Text>
                {!leaveDraft && (
                  <TouchableOpacity onPress={() => setLeaveDraft({ leaveType: "annual", startDate: "", endDate: "", hours: "", notes: "", startTime: "", endTime: "" })} style={styles.addBtn}>
                    <Text style={styles.addText}>+ Add</Text>
                  </TouchableOpacity>
                )}
              </View>
              {leaveDraft ? (
                <View style={styles.leaveForm}>
                  <View style={styles.leaveChips}>
                    {LEAVE_TYPES.map((t) => (
                      <TouchableOpacity key={t} style={[styles.leaveChip, leaveDraft.leaveType === t && styles.leaveChipActive]} onPress={() => setLeaveDraft((d) => d && { ...d, leaveType: t })}>
                        <Text style={[styles.leaveChipText, leaveDraft.leaveType === t && styles.leaveChipTextActive]}>{leaveLabel(t)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={styles.twoCol}>
                    <View style={{ flex: 1 }}><Field label="Start (YYYY-MM-DD)" value={leaveDraft.startDate} onChange={(v) => setLeaveDraft((d) => d && { ...d, startDate: v })} /></View>
                    <View style={{ flex: 1 }}><Field label="End (YYYY-MM-DD)" value={leaveDraft.endDate} onChange={(v) => setLeaveDraft((d) => d && { ...d, endDate: v })} /></View>
                  </View>
                  <View style={styles.twoCol}>
                    <View style={{ flex: 1 }}><Field label="Hours" value={leaveDraft.hours} onChange={(v) => setLeaveDraft((d) => d && { ...d, hours: v })} num /></View>
                    <View style={{ flex: 1 }}><Field label="Notes (optional)" value={leaveDraft.notes} onChange={(v) => setLeaveDraft((d) => d && { ...d, notes: v })} /></View>
                  </View>
                  <View style={styles.twoCol}>
                    <View style={{ flex: 1 }}><Field label="From (part day, HH:MM)" value={leaveDraft.startTime} onChange={(v) => setLeaveDraft((d) => d && { ...d, startTime: v })} placeholder="e.g. 07:00" /></View>
                    <View style={{ flex: 1 }}><Field label="To (part day, HH:MM)" value={leaveDraft.endTime} onChange={(v) => setLeaveDraft((d) => d && { ...d, endTime: v })} placeholder="e.g. 11:30" /></View>
                  </View>
                  <Text style={styles.leaveHint}>Leave From/To empty for whole days. Shown on the schedule: office and admin see the type; others see “Unavailable”.</Text>
                  <View style={styles.leaveActions}>
                    <TouchableOpacity style={styles.leaveCancel} onPress={() => setLeaveDraft(null)} disabled={leaveSaving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity style={styles.leaveSave} onPress={saveLeave} disabled={leaveSaving}><Text style={styles.saveText}>{leaveSaving ? "…" : "Add leave"}</Text></TouchableOpacity>
                  </View>
                </View>
              ) : leave.length === 0 ? (
                <Text style={styles.leaveEmpty}>No leave logged.</Text>
              ) : (
                leave.map((l) => (
                  <TouchableOpacity key={l.id} style={styles.leaveRow} onLongPress={() => confirmRemoveLeave(l)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.leaveRowTitle}>{leaveLabel(l.leave_type)} · {l.hours}h</Text>
                      <Text style={styles.leaveRowMeta}>
                        {l.start_date} → {l.end_date}
                        {l.start_time && l.end_time ? ` · ${hhmm(l.start_time)}–${hhmm(l.end_time)}` : ""}
                        {l.notes ? ` · ${l.notes}` : ""}
                      </Text>
                    </View>
                    <Ionicons name="trash-outline" size={15} color={colors.slate400} />
                  </TouchableOpacity>
                ))
              )}
              {leave.length > 0 && !leaveDraft && <Text style={styles.leaveHint}>Long-press a leave entry to remove it.</Text>}
            </ScrollView>
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Save"}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <KeyboardSheet
        visible={!!invite}
        onRequestClose={() => !inviting && setInvite(null)}
        title="Invite staff member"
        testID="staff-invite-sheet"
        footer={
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancel} onPress={() => setInvite(null)} disabled={inviting}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={styles.saveBtn} onPress={sendInvite} disabled={inviting}><Text style={styles.saveText}>{inviting ? "Sending…" : "Send invite"}</Text></TouchableOpacity>
          </View>
        }
      >
        <Text style={styles.switchHint}>They get an email to set a password, then sign in with this email on the phone or the web.</Text>
        <InviteField label="Full name" value={invite?.full_name ?? ""} onChange={(v) => setInvite((i) => i && { ...i, full_name: v })} />
        <InviteField label="Email (their login)" value={invite?.email ?? ""} onChange={(v) => setInvite((i) => i && { ...i, email: v })} email />
        <InviteField label="Phone (optional)" value={invite?.phone ?? ""} onChange={(v) => setInvite((i) => i && { ...i, phone: v })} phone />
        <Text style={styles.fieldLabel}>Role</Text>
        <View style={styles.segment}>
          {ROLES.map((r) => (
            <TouchableOpacity key={r} style={[styles.segItem, invite?.role === r && styles.segItemActive]} onPress={() => setInvite((i) => i && { ...i, role: r })}>
              <Text style={[styles.segText, invite?.role === r && styles.segTextActive]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </KeyboardSheet>
    </View>
  );
}

// 16pt inputs inside the KeyboardSheet (iOS zooms anything smaller).
function InviteField({ label, value, onChange, email, phone }: { label: string; value: string; onChange: (v: string) => void; email?: boolean; phone?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, { fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE }]}
        value={value}
        onChangeText={onChange}
        keyboardType={email ? "email-address" : phone ? "phone-pad" : "default"}
        autoCapitalize={email ? "none" : "words"}
        autoCorrect={false}
        placeholderTextColor={colors.slate400}
      />
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  num,
  email,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  num?: boolean;
  email?: boolean;
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={num ? "decimal-pad" : email ? "email-address" : "default"}
        autoCapitalize={email ? "none" : "sentences"}
        autoCorrect={!email}
        placeholder={placeholder}
        placeholderTextColor={colors.slate400}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  body: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  inactive: { color: colors.slate400 },
  inactiveTag: { fontSize: 10, color: colors.slate400, fontStyle: "italic" },
  roleBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  roleText: { fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  email: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  rateCol: { alignItems: "flex-end" },
  rate: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  rateUnit: { fontSize: 11, color: colors.slate400 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, maxHeight: "88%" },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  section: { fontSize: 13, fontWeight: "700", color: colors.slate700, marginTop: 8, marginBottom: 6 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  segment: { flexDirection: "row", gap: 8, marginBottom: 12 },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", backgroundColor: colors.bg },
  segItemActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  segText: { fontSize: 12, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  segTextActive: { color: "#fff" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, marginBottom: 6 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  switchHint: { fontSize: 11, color: colors.slate400, marginTop: 2, marginBottom: 6 },
  headerBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  resetBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, marginBottom: 12 },
  resetBtnText: { fontSize: 13, fontWeight: "600", color: colors.blue600 },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  leaveHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  addBtn: { paddingVertical: 4 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "700" },
  leaveForm: { backgroundColor: colors.bg, borderRadius: 10, padding: 10, gap: 4, marginTop: 4 },
  leaveChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  leaveChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  leaveChipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  leaveChipText: { fontSize: 12, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  leaveChipTextActive: { color: "#fff" },
  leaveActions: { flexDirection: "row", gap: 10, marginTop: 6 },
  leaveCancel: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.card, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  leaveSave: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  leaveEmpty: { fontSize: 13, color: colors.slate400, paddingVertical: 6 },
  leaveRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.slate100 },
  leaveRowTitle: { fontSize: 14, fontWeight: "600", color: colors.slate900, textTransform: "capitalize" },
  leaveRowMeta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  leaveHint: { fontSize: 11, color: colors.slate400, marginTop: 6 },
});
