import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, TextInput, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { useIsAdmin } from "../../design/guards/useRole";
import { useApprovals } from "../../lib/data/hooks/useApprovals";
import { approveJobOnServer, approvalMessage } from "../../lib/approveJob";
import { ScreenError } from "../../design/components/ScreenError";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { unwrapRows } from "../../lib/data/reads/unwrap";
import { loadApprovalHours, type ApprovalHoursSummary } from "../../lib/approvalHours";
import {
  UNBILLED_VARIATIONS_SELECT,
  approvedAgo,
  groupUnbilledVariations,
  variationQtyText,
  type UnbilledVariation,
} from "../../lib/unbilledVariations";
import { ApplyHourlyRateSheet } from "../../components/approvals/apply-hourly-rate-sheet";

interface ApprovalJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  updated_at: string | null;
  completion_notes: string | null;
  overtime_category: string | null;
  overtime_reason: string | null;
  customers: { name: string } | null;
  sites: { suburb: string } | null;
}
interface PendingVariation {
  id: string;
  variation_types: { name: string } | null;
  jobs: { id: string; job_number: number; title: string; customers: { name: string } | null } | null;
}

const OVERTIME_LABELS: Record<string, string> = {
  unexpected_issue: "Unexpected issue",
  difficult_site: "Difficult site",
  training_needed: "Training needed",
  other: "Other",
};

export default function ApprovalsScreen() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const approvals = useApprovals();
  const [jobs, setJobs] = useState<ApprovalJob[]>([]);
  const [variations, setVariations] = useState<PendingVariation[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The hours each job will carry onto its invoice (GET /api/approvals/hours).
  // Its own failure state: "no hours" and "couldn't check" must look different.
  const [hoursByJob, setHoursByJob] = useState<Record<string, ApprovalHoursSummary>>({});
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [unbilled, setUnbilled] = useState<UnbilledVariation[]>([]);
  const [unbilledError, setUnbilledError] = useState<string | null>(null);
  // The invoice "Apply hourly rate" is open for (after an approval left hours unpriced).
  const [rateInvoiceId, setRateInvoiceId] = useState<string | null>(null);

  // Both results are unwrapped rather than defaulted to []. This screen's empty
  // state reads "Nothing awaiting approval." — a sentence an admin acts on by
  // closing the app. A failed queue read that renders it leaves finished jobs
  // unapproved and uninvoiced, and nobody learns why.
  const load = useCallback(async () => {
    // Mirrors the web Approvals queue exactly: completed jobs awaiting admin
    // review, plus variations pending approval. (Distinct from the Invoices
    // "ready to invoice" queue keyed off ready_to_invoice.)
    try {
      setError(null);
      const [jobsRes, varsRes] = await Promise.all([
        supabase
          .from("jobs")
          .select("id, job_number, title, status, updated_at, completion_notes, overtime_category, overtime_reason, customers(name), sites(suburb)")
          .eq("status", "completed")
          .eq("admin_status", "pending")
          .order("updated_at", { ascending: false }),
        supabase
          .from("job_variations")
          .select("id, variation_types(name), jobs(id, job_number, title, customers(name))")
          .eq("status", "pending_approval")
          .order("created_at", { ascending: false }),
      ]);
      const pendingJobs = unwrapRows(jobsRes as never, "ApprovalsScreen.jobs") as unknown as ApprovalJob[];
      setJobs(pendingJobs);
      setVariations(unwrapRows(varsRes as never, "ApprovalsScreen.variations") as unknown as PendingVariation[]);

      // Extras (web parity): neither takes the queue down if it fails.
      const [hoursResult, unbilledResult] = await Promise.allSettled([
        loadApprovalHours(pendingJobs.map((j) => j.id)),
        supabase
          .from("job_variations")
          .select(UNBILLED_VARIATIONS_SELECT)
          .in("status", ["approved", "auto_approved"])
          .is("invoice_id", null)
          .order("approved_at", { ascending: true, nullsFirst: true }),
      ]);
      if (hoursResult.status === "fulfilled") {
        setHoursByJob(hoursResult.value);
        setHoursError(null);
      } else {
        setHoursByJob({});
        setHoursError(hoursResult.reason instanceof Error ? hoursResult.reason.message : "Couldn't load the hours.");
      }
      if (unbilledResult.status === "fulfilled" && !unbilledResult.value.error) {
        setUnbilled((unbilledResult.value.data ?? []) as unknown as UnbilledVariation[]);
        setUnbilledError(null);
      } else {
        setUnbilled([]);
        setUnbilledError("Couldn't load the variations waiting to be invoiced.");
      }
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function onApprove(jobId: string) {
    if (savingId) return;
    setSavingId(jobId);
    try {
      // The server builds the invoice — hours, variations and line items — the
      // same way the web does (lib/approveJob.ts says why).
      const result = await approveJobOnServer(jobId, notes[jobId]?.trim() || null);
      setJobs((j) => j.filter((x) => x.id !== jobId));
      const invoiceId = result.invoiceId;
      if (invoiceId && result.unpricedHours > 0) {
        // Hours were carried but not priced: price them here, now.
        Alert.alert("Job approved", approvalMessage(result), [
          { text: "Later", style: "cancel" },
          { text: "Apply hourly rate", onPress: () => setRateInvoiceId(invoiceId) },
        ]);
      } else {
        Alert.alert("Job approved", approvalMessage(result));
      }
    } catch (e) {
      Alert.alert("Couldn't approve", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSavingId(null);
    }
  }

  async function onSendBack(jobId: string) {
    const note = notes[jobId]?.trim();
    if (!note) {
      Alert.alert("Note required", "Add a note explaining what needs to be done before this can be approved.");
      return;
    }
    if (!approvals.ready || savingId) return;
    setSavingId(jobId);
    try {
      await approvals.sendBackJob({ jobId, note });
      setJobs((j) => j.filter((x) => x.id !== jobId));
      Alert.alert("Sent back", "The job was reopened for the technician.");
    } catch (e) {
      Alert.alert("Couldn't send back", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSavingId(null);
    }
  }

  // Checked BEFORE `nothing`, so a failed read can never be reported as an empty
  // queue. The two look identical on screen and mean opposite things.
  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenError error={error} onRetry={() => { void load(); }} />
      </SafeAreaView>
    );
  }

  const nothing = jobs.length === 0 && variations.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Approvals</Text>
        <Text style={styles.sub}>
          {jobs.length} job{jobs.length !== 1 ? "s" : ""} awaiting review
        </Text>
      </View>
      <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
      >
        {!isAdmin && (
          <View style={styles.banner}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.orange700} />
            <Text style={styles.bannerText}>View-only — only admins can approve jobs or send them back (approving creates a draft invoice).</Text>
          </View>
        )}

        <UnbilledVariationsSection
          variations={unbilled}
          loadError={unbilledError}
          onOpenJob={(id) => router.push(`/job/${id}`)}
          onCreateInvoice={(jobId) => router.push(`/invoices/new?jobId=${jobId}`)}
          onOpenInvoice={(id) => router.push(`/invoices/${id}`)}
        />

        {nothing ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-outline" size={34} color={colors.slate400} />
            <Text style={styles.emptyText}>Nothing awaiting approval.</Text>
          </View>
        ) : (
          <>
            {jobs.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Jobs awaiting approval ({jobs.length})</Text>
                {jobs.map((job) => {
                  const isOpen = expanded === job.id;
                  const busy = savingId === job.id;
                  return (
                    <View key={job.id} style={styles.card}>
                      <TouchableOpacity style={styles.jobHead} onPress={() => setExpanded(isOpen ? null : job.id)}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.jobTitle} numberOfLines={1}>#{job.job_number} — {job.title}</Text>
                          <View style={styles.metaRow}>
                            <Text style={styles.meta} numberOfLines={1}>
                              {job.customers?.name ?? "—"}
                              {job.sites?.suburb ? ` · ${job.sites.suburb}` : ""}
                              {job.updated_at ? ` · ${new Date(job.updated_at).toLocaleDateString("en-AU")}` : ""}
                            </Text>
                          </View>
                          {(hoursByJob[job.id]?.total ?? 0) > 0 && (
                            <View style={styles.hoursBadge}>
                              <Ionicons name="timer-outline" size={11} color={colors.blue600} />
                              <Text style={styles.hoursBadgeText}>{hoursByJob[job.id].total.toFixed(2)}h to invoice</Text>
                            </View>
                          )}
                          {job.overtime_category && (
                            <View style={styles.otBadge}>
                              <Ionicons name="warning-outline" size={11} color={colors.orange700} />
                              <Text style={styles.otBadgeText}>Exceeded hours</Text>
                            </View>
                          )}
                        </View>
                        <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={18} color={colors.slate400} />
                      </TouchableOpacity>

                      {isOpen && (
                        <View style={styles.expand}>
                          <TouchableOpacity onPress={() => router.push(`/job/${job.id}`)}>
                            <Text style={styles.link}>View full job details →</Text>
                          </TouchableOpacity>

                          {job.completion_notes ? <Text style={styles.completion}>“{job.completion_notes}”</Text> : null}
                          {job.overtime_category ? (
                            <View style={styles.otDetail}>
                              <Text style={styles.otDetailTitle}>Exceeded allocated hours</Text>
                              <Text style={styles.otDetailBody}>
                                {OVERTIME_LABELS[job.overtime_category] ?? job.overtime_category}
                                {job.overtime_reason ? ` — ${job.overtime_reason}` : ""}
                              </Text>
                            </View>
                          ) : null}

                          <JobHoursPanel summary={hoursByJob[job.id]} loadError={hoursError} />

                          <Text style={styles.notesLabel}>Notes (required to send back)</Text>
                          <TextInput
                            style={styles.notesInput}
                            value={notes[job.id] ?? ""}
                            onChangeText={(v) => setNotes((n) => ({ ...n, [job.id]: v }))}
                            placeholder="e.g. Photos missing — add before/after shots…"
                            placeholderTextColor={colors.slate400}
                            multiline
                            editable={isAdmin && !busy}
                          />

                          {isAdmin ? (
                            <View style={styles.actions}>
                              <TouchableOpacity testID="approve-job" style={[styles.approveBtn, busy && styles.btnDisabled]} onPress={() => onApprove(job.id)} disabled={busy}>
                                {busy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark-circle" size={16} color="#fff" />}
                                <Text style={styles.approveText}>Approve &amp; Queue Invoice</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={[styles.sendBackBtn, busy && styles.btnDisabled]} onPress={() => onSendBack(job.id)} disabled={busy}>
                                <Ionicons name="arrow-undo" size={16} color={colors.red600} />
                                <Text style={styles.sendBackText}>Send Back</Text>
                              </TouchableOpacity>
                            </View>
                          ) : (
                            <Text style={styles.viewOnly}>Only admins can approve or send back jobs.</Text>
                          )}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            {variations.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Variations awaiting pricing ({variations.length})</Text>
                <View style={styles.card}>
                  {variations.map((v, i) => (
                    <TouchableOpacity
                      key={v.id}
                      style={[styles.varRow, i > 0 && styles.varBorder]}
                      onPress={() => v.jobs?.id && router.push(`/job/${v.jobs.id}`)}
                      disabled={!v.jobs?.id}
                    >
                      <Ionicons name="git-pull-request-outline" size={18} color={colors.slate500} />
                      <View style={styles.varBody}>
                        <Text style={styles.varName} numberOfLines={1}>{v.variation_types?.name ?? "Variation"}</Text>
                        <Text style={styles.varJob} numberOfLines={1}>
                          {v.jobs ? `#${v.jobs.job_number} — ${v.jobs.title}` : "—"}
                          {v.jobs?.customers?.name ? ` · ${v.jobs.customers.name}` : ""}
                        </Text>
                      </View>
                      <Text style={styles.reviewLink}>Price &amp; review →</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>
      <ApplyHourlyRateSheet invoiceId={rateInvoiceId} visible={!!rateInvoiceId} onClose={() => setRateInvoiceId(null)} />
    </SafeAreaView>
  );
}

// What approving will carry onto the invoice, by cost centre and technician
// (web JobHoursPanel). Hours only.
function JobHoursPanel({ summary, loadError }: { summary: ApprovalHoursSummary | undefined; loadError: string | null }) {
  if (loadError || summary?.error) {
    return (
      <View style={styles.hoursError}>
        <Text style={styles.hoursErrorText}>
          Couldn&apos;t load this job&apos;s hours ({loadError ?? summary?.error}). Approving will stop rather than leave them off the invoice.
        </Text>
      </View>
    );
  }
  if (!summary) return <Text style={styles.hoursMuted}>Loading the job&apos;s hours…</Text>;
  if (summary.groups.length === 0) return <Text style={styles.hoursMuted}>No clocked hours to invoice on this job.</Text>;
  return (
    <View style={styles.hoursCard}>
      <View style={styles.hoursHead}>
        <Text style={styles.hoursTitle}>Hours to invoice</Text>
        <Text style={styles.hoursTotal}>{summary.total.toFixed(2)}h</Text>
      </View>
      {summary.groups.map((g) => (
        <View key={g.key} style={styles.hoursRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hoursCc} numberOfLines={1}>{g.costCentreName ?? "No cost centre"}</Text>
            <Text style={styles.hoursWho} numberOfLines={1}>{g.staffName}</Text>
          </View>
          <Text style={styles.hoursNum}>{g.hours.toFixed(2)}</Text>
        </View>
      ))}
      <Text style={styles.hoursFoot}>
        These go onto the job&apos;s draft invoice. Price them with Apply hourly rate (offered after approving); the invoice isn&apos;t pushed to Xero until they are.
      </Text>
    </View>
  );
}

// "Variations to invoice" (web UnbilledVariations): approved variations not on
// an invoice yet, by job. Office/admin — the amounts render through MoneyText
// inside a RoleGate.
function UnbilledVariationsSection({
  variations,
  loadError,
  onOpenJob,
  onCreateInvoice,
  onOpenInvoice,
}: {
  variations: UnbilledVariation[];
  loadError: string | null;
  onOpenJob: (jobId: string) => void;
  onCreateInvoice: (jobId: string) => void;
  onOpenInvoice: (invoiceId: string) => void;
}) {
  if (loadError) return <Text style={styles.hoursErrorText}>{loadError} Pull down to retry.</Text>;
  const { groups, count, total } = groupUnbilledVariations(variations);
  if (count === 0) return null;
  return (
    <RoleGate roles={["admin", "office"]}>
      <View style={styles.section}>
        <View style={styles.unbilledHead}>
          <Text style={styles.sectionTitle}>Variations to invoice ({count}) · </Text>
          <MoneyText amount={total} style={styles.sectionTitle} />
        </View>
        {groups.map((g) => (
          <View key={g.job.id} style={styles.card}>
            <View style={styles.unbilledJob}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => onOpenJob(g.job.id)}>
                <Text style={styles.varName} numberOfLines={1}>#{g.job.job_number} — {g.job.title}</Text>
                <Text style={styles.varJob} numberOfLines={1}>{g.job.customers?.name ?? "—"}</Text>
              </TouchableOpacity>
              <MoneyText amount={g.total} style={styles.unbilledTotal} />
            </View>
            {g.variations.map((v) => {
              const qty = variationQtyText(v);
              const ago = approvedAgo(v);
              return (
                <View key={v.id} style={styles.unbilledLine}>
                  <Text style={styles.unbilledLineText} numberOfLines={1}>
                    {v.variation_types?.name ?? v.custom_name ?? "Variation"}
                    {qty ? ` — ${qty}` : ""}
                    {ago ? ` · ${ago}` : ""}
                  </Text>
                  <MoneyText amount={Number(v.total_amount ?? 0)} style={styles.unbilledLineText} />
                </View>
              );
            })}
            {g.existingInvoice ? (
              <>
                <Text style={styles.unbilledWarn}>
                  This job already has invoice #{g.existingInvoice.invoice_number} ({g.existingInvoice.status}). Add these to it if it hasn&apos;t been sent, or make a separate invoice from the job.
                </Text>
                <TouchableOpacity style={styles.unbilledBtnOutline} onPress={() => onOpenInvoice(g.existingInvoice!.id)}>
                  <Text style={styles.unbilledBtnOutlineText}>Open invoice #{g.existingInvoice.invoice_number} →</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity style={styles.unbilledBtn} onPress={() => onCreateInvoice(g.job.id)}>
                <Text style={styles.unbilledBtnText}>Create invoice →</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </View>
    </RoleGate>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  sub: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  content: { padding: 12, gap: 18, paddingBottom: 40 },
  banner: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: colors.orange100, borderRadius: 10, padding: 10 },
  bannerText: { flex: 1, fontSize: 12, color: colors.orange700, lineHeight: 16 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginLeft: 4 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden", marginBottom: 10 },
  jobHead: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 13 },
  jobTitle: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  metaRow: { marginTop: 3 },
  meta: { fontSize: 12, color: colors.slate500 },
  otBadge: { flexDirection: "row", alignSelf: "flex-start", alignItems: "center", gap: 3, marginTop: 6, backgroundColor: colors.orange100, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  otBadgeText: { fontSize: 10, fontWeight: "700", color: colors.orange700 },
  expand: { borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 14, paddingVertical: 12, gap: 10, backgroundColor: colors.bg },
  link: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  completion: { fontSize: 13, color: colors.slate700, fontStyle: "italic" },
  otDetail: { backgroundColor: colors.orange100, borderRadius: 8, padding: 10 },
  otDetailTitle: { fontSize: 11, fontWeight: "700", color: colors.orange700, textTransform: "uppercase" },
  otDetailBody: { fontSize: 13, color: colors.slate700, marginTop: 2 },
  notesLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500 },
  notesInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.slate900, backgroundColor: colors.card, minHeight: 56, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: 10, marginTop: 2 },
  approveBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: colors.green600, borderRadius: 10, paddingVertical: 12 },
  approveText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  sendBackBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1, borderColor: colors.red600, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 },
  sendBackText: { color: colors.red600, fontWeight: "700", fontSize: 13 },
  btnDisabled: { opacity: 0.6 },
  viewOnly: { fontSize: 12, color: colors.slate400, fontStyle: "italic" },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: 10 },
  emptyText: { fontSize: 13, color: colors.slate400 },
  varRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  varBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  varBody: { flex: 1, minWidth: 0 },
  varName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  varJob: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  reviewLink: { fontSize: 12, fontWeight: "700", color: colors.blue600 },
  hoursBadge: { flexDirection: "row", alignSelf: "flex-start", alignItems: "center", gap: 3, marginTop: 6, backgroundColor: colors.blue100, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  hoursBadgeText: { fontSize: 10, fontWeight: "700", color: colors.blue600 },
  hoursCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: "hidden" },
  hoursHead: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  hoursTitle: { fontSize: 11, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  hoursTotal: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  hoursRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.slate100 },
  hoursCc: { fontSize: 13, color: colors.slate700, fontWeight: "600" },
  hoursWho: { fontSize: 12, color: colors.slate500 },
  hoursNum: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  hoursFoot: { fontSize: 11, color: colors.slate500, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  hoursMuted: { fontSize: 12, color: colors.slate400 },
  hoursError: { backgroundColor: colors.red100, borderRadius: 8, padding: 10 },
  hoursErrorText: { fontSize: 12, color: colors.red600 },
  unbilledHead: { flexDirection: "row", alignItems: "center" },
  unbilledJob: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  unbilledTotal: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  unbilledLine: { flexDirection: "row", justifyContent: "space-between", gap: 10, paddingHorizontal: 14, paddingVertical: 3 },
  unbilledLineText: { fontSize: 12, color: colors.slate500, flexShrink: 1 },
  unbilledWarn: { fontSize: 12, color: colors.orange700, paddingHorizontal: 14, paddingTop: 6 },
  unbilledBtn: { margin: 12, marginTop: 8, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  unbilledBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  unbilledBtnOutline: { margin: 12, marginTop: 8, borderWidth: 1, borderColor: colors.blue600, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  unbilledBtnOutlineText: { color: colors.blue600, fontWeight: "700", fontSize: 13 },
});
