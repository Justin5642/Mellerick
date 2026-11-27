import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { cryptoIdGen } from "../../lib/data/ids";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";
import { prepareImage } from "../../lib/imageUpload";
import { pickPhoto } from "../../lib/pickPhoto";
import { documentPickerAvailable, pickUploadFile, kindExtension, type ReadyUpload } from "../../lib/documentPicker";
import { localDateKey } from "../../lib/date";
import { openExternalUrl } from "../../lib/open-external-url";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { isBlankLine, lineInputFromSaved, planBuilderPo, planBuilderPoEdit, remainingToSplit, type BuilderPoLineInput } from "../../lib/builderPo";
import {
  PO_TAB_OFFLINE,
  addJobPo,
  deleteJobPo,
  deleteSupplierOrder,
  editJobPo,
  gstOf,
  isOfflineError,
  loadJobPurchaseOrders,
  ordersByLine,
  poSplitState,
  saveSupplierInvoice,
  sendSupplierInvoiceToXero,
  supplierInvoiceProblem,
  supplierInvoiceUrl,
  updateSupplierOrder,
  type JobPo,
  type JobPurchaseOrdersState,
  type OrderStatus,
  type PoFormInput,
  type PoSupplierOrder,
} from "../../lib/jobPurchaseOrders";

// The job's Purchase Orders tab on the phone — office/admin only (Nov 2026),
// the web PO tab (components/job/job-po.tsx) brought across: the builder's
// POs (number defaulting to <job>-n, client, site, value) split across the
// company cost centres with hours; "not split yet" / "over"; Edit (a line with
// supplier orders, time or expenses can't be removed — set it to $0); "Add
// cost centre to this PO"; "Invoice this PO" (the phone's New Invoice,
// prefilled from lib/poInvoice.ts); and under each line the supplier orders:
// the amount ex GST, the supplier's invoice (number, date, amount, photo),
// Send to Xero, status and remove.
//
// Online only — lib/jobPurchaseOrders.ts says why. Every figure is rendered
// through MoneyText, and the whole tab sits in a RoleGate, on top of the
// routes' requireOfficeOrAdmin and RLS.

type Status =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "error"; message: string }
  | { kind: "ok"; view: JobPurchaseOrdersState };

interface PoDraft {
  /** null = a new PO. */
  poId: string | null;
  form: PoFormInput;
}

interface InvoiceDraft {
  order: PoSupplierOrder;
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
  photoUri: string | null;
  /** A PDF / photo chosen from the phone's files (builds with expo-document-picker). */
  picked: ReadyUpload | null;
}

const STATUS_LABEL: Record<OrderStatus, string> = { ordered: "Ordered", received: "Received", cancelled: "Cancelled" };
const STATUS_STYLE: Record<OrderStatus, { bg: string; text: string }> = {
  ordered: { bg: colors.yellow100, text: colors.yellow700 },
  received: { bg: colors.green100, text: colors.green600 },
  cancelled: { bg: colors.slate100, text: colors.slate500 },
};

const blankLine = (): BuilderPoLineInput => ({ costCentreId: "", stage: "", amount: "", hours: "" });

export function JobPurchaseOrdersTab({ jobId }: { jobId: string }) {
  return (
    <RoleGate roles={["office", "admin"]}>
      <PurchaseOrders jobId={jobId} />
    </RoleGate>
  );
}

function PurchaseOrders({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [draft, setDraft] = useState<PoDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [amountFor, setAmountFor] = useState<{ order: PoSupplierOrder; amount: string } | null>(null);
  const [invoice, setInvoice] = useState<InvoiceDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A new PO's id, made before the first Save and kept across retries, so a
  // retry after a dropped answer can't add the PO twice.
  const newPoId = useRef(cryptoIdGen.newId());

  const load = useCallback(async () => {
    setStatus((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    if (!(await netInfoConnectivity.isOnline().catch(() => true))) {
      setStatus({ kind: "offline" });
      return;
    }
    try {
      setStatus({ kind: "ok", view: await loadJobPurchaseOrders(jobId) });
    } catch (e) {
      if (isOfflineError(e)) setStatus({ kind: "offline" });
      else setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load the purchase orders." });
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  function show(view: JobPurchaseOrdersState, done?: string) {
    setStatus({ kind: "ok", view });
    if (view.warning) Alert.alert(done ?? "Saved", view.warning);
  }

  async function run(id: string, action: () => Promise<JobPurchaseOrdersState>, failTitle: string, done?: string) {
    setBusyId(id);
    try {
      show(await action(), done);
    } catch (e) {
      Alert.alert(failTitle, e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (status.kind === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.blue600} />
      </View>
    );
  }
  if (status.kind === "offline" || status.kind === "error") {
    return (
      <View style={styles.container}>
        <View style={styles.notice}>
          <Ionicons name={status.kind === "offline" ? "cloud-offline-outline" : "alert-circle-outline"} size={20} color={colors.slate500} />
          <Text style={styles.noticeText}>{status.kind === "offline" ? PO_TAB_OFFLINE : status.message}</Text>
        </View>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => void load()}>
          <Text style={styles.secondaryBtnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const view = status.view;
  const byLine = ordersByLine(view.orders);
  const centreName = (id: string | null) => view.costCentres.find((c) => c.id === id)?.name ?? null;
  const totalValue = view.pos.reduce((s, p) => s + p.total_value, 0);
  const totalHours = view.pos.reduce((s, p) => s + p.total_hours, 0);

  function openNew() {
    setDraft({
      poId: null,
      form: {
        poNumber: view.defaults.poNumber,
        clientReference: view.defaults.clientReference,
        siteAddress: view.defaults.siteAddress,
        value: "",
        lines: [blankLine()],
      },
    });
  }

  function openEdit(po: JobPo, addLine = false) {
    const value = po.total_value.toFixed(2);
    const lines = po.lines.map((l) => lineInputFromSaved(l, view.costCentres));
    if (addLine || lines.length === 0) lines.push({ ...blankLine(), amount: addLine ? remainingToSplit(value, lines) : "" });
    setDraft({
      poId: po.id,
      form: { poNumber: po.po_number, clientReference: po.client_reference ?? "", siteAddress: po.site_address ?? "", value, lines },
    });
  }

  async function savePo() {
    if (!draft || saving) return;
    // The same check the server makes, so a slip is caught before sending.
    const po = draft.poId ? view.pos.find((p) => p.id === draft.poId) : null;
    const planned = po
      ? planBuilderPoEdit({ poNumber: draft.form.poNumber, value: draft.form.value, lines: draft.form.lines }, po.lines, view.costCentres, view.inUse)
      : draft.form.poNumber.trim()
        ? planBuilderPo({ value: draft.form.value, lines: draft.form.lines }, view.costCentres)
        : ({ ok: false, error: "Enter the PO number." } as const);
    if (!planned.ok) {
      Alert.alert("Check the PO", planned.error);
      return;
    }
    setSaving(true);
    try {
      const lines = draft.form.lines.filter((l) => l.id || !isBlankLine(l));
      const form = { ...draft.form, lines };
      const res = draft.poId ? await editJobPo(jobId, draft.poId, form) : await addJobPo(jobId, newPoId.current, form);
      if (!draft.poId) newPoId.current = cryptoIdGen.newId();
      setDraft(null);
      show(res, draft.poId ? "PO updated" : "Purchase order saved");
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirmDeletePo(po: JobPo) {
    const orders = po.lines.reduce((n, l) => n + (byLine[l.id]?.length ?? 0), 0);
    Alert.alert(
      `Remove PO ${po.po_number}?`,
      orders > 0
        ? `Its ${orders} supplier order${orders === 1 ? "" : "s"} will be removed with it. This can't be undone.`
        : "This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void run(po.id, () => deleteJobPo(jobId, po.id), "Not removed") },
      ]
    );
  }

  function invoicePo(po: JobPo) {
    const go = () => router.push({ pathname: "/invoices/new", params: { jobId, poId: po.id } });
    const existing = view.invoicedPos[po.po_number];
    if (existing) {
      Alert.alert(
        "Already invoiced?",
        `PO ${po.po_number} already has an invoice on this job${existing !== "yes" ? ` (${existing})` : ""}. Make another?`,
        [{ text: "Cancel", style: "cancel" }, { text: "New invoice", onPress: go }]
      );
    } else go();
  }

  function orderActions(o: PoSupplierOrder) {
    const statuses = (["ordered", "received", "cancelled"] as OrderStatus[]).filter((s) => s !== o.status);
    Alert.alert(`${o.po_number} · ${o.vendor_name}`, undefined, [
      ...statuses.map((s) => ({
        text: `Mark ${STATUS_LABEL[s].toLowerCase()}`,
        onPress: () => void run(o.id, () => updateSupplierOrder(jobId, o.id, { status: s }), "Not changed"),
      })),
      {
        text: "Remove order",
        style: "destructive" as const,
        onPress: () =>
          Alert.alert(`Remove ${o.po_number}?`, o.xero_bill_id ? "Its bill stays in Xero — remove it there too." : "This can't be undone.", [
            { text: "Cancel", style: "cancel" },
            { text: "Remove", style: "destructive", onPress: () => void run(o.id, () => deleteSupplierOrder(jobId, o.id), "Not removed") },
          ]),
      },
      { text: "Close", style: "cancel" as const },
    ]);
  }

  async function saveAmount() {
    if (!amountFor) return;
    const { order, amount } = amountFor;
    setAmountFor(null);
    await run(order.id, () => updateSupplierOrder(jobId, order.id, { amount: amount.trim() || "0" }), "Not saved");
  }

  function openInvoice(o: PoSupplierOrder) {
    setInvoice({
      order: o,
      invoiceNumber: o.invoice_number ?? "",
      invoiceDate: o.invoice_date ?? localDateKey(new Date()),
      amount: o.amount ? o.amount.toFixed(2) : "",
      photoUri: null,
      picked: null,
    });
  }

  async function saveInvoice() {
    if (!invoice || saving) return;
    const problem = supplierInvoiceProblem(invoice);
    if (problem) {
      Alert.alert("Check the invoice", problem);
      return;
    }
    setSaving(true);
    try {
      let file: string | null = null;
      let ext = "jpg";
      if (invoice.picked) {
        file = invoice.picked.base64;
        ext = kindExtension(invoice.picked.kind);
      } else if (invoice.photoUri) {
        const { base64 } = await prepareImage(invoice.photoUri, { base64: true });
        if (!base64) throw new Error("Couldn't prepare the photo — take it again.");
        file = base64;
      }
      const res = await saveSupplierInvoice(jobId, invoice.order.id, {
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate.trim() || null,
        amount: invoice.amount,
        file,
        fileName: `invoice-${invoice.invoiceNumber.trim()}.${ext}`,
      });
      setInvoice(null);
      show(res, `Invoice saved on ${invoice.order.po_number}`);
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirmXero(o: PoSupplierOrder) {
    Alert.alert("Send to Xero?", `${o.po_number}'s invoice ${o.invoice_number ?? ""} becomes an approved bill in Xero. The amount then locks here.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Send",
        onPress: async () => {
          setBusyId(o.id);
          try {
            await sendSupplierInvoiceToXero(o.id);
            show(await loadJobPurchaseOrders(jobId));
            Alert.alert("Sent", `${o.po_number} is now a bill in Xero.`);
          } catch (e) {
            Alert.alert("Not sent", e instanceof Error ? e.message : "Try again.");
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  }

  async function viewInvoiceFile(o: PoSupplierOrder) {
    if (!o.invoice_storage_path) return;
    try {
      void openExternalUrl(await supplierInvoiceUrl(o.invoice_storage_path), "the invoice");
    } catch (e) {
      Alert.alert("Couldn't open it", e instanceof Error ? e.message : "Try again.");
    }
  }

  function renderOrder(o: PoSupplierOrder) {
    const sc = STATUS_STYLE[o.status];
    const busy = busyId === o.id;
    return (
      <View key={o.id} style={styles.order}>
        <View style={styles.rowBetween}>
          <Text style={styles.orderTitle} numberOfLines={1}>
            {o.po_number} · {o.vendor_name}
          </Text>
          {busy ? (
            <ActivityIndicator size="small" color={colors.blue600} />
          ) : (
            <TouchableOpacity onPress={() => orderActions(o)} accessibilityLabel={`More for ${o.po_number}`} hitSlop={8}>
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.slate500} />
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.orderMeta}>
          <View style={[styles.pill, { backgroundColor: sc.bg }]}>
            <Text style={[styles.pillText, { color: sc.text }]}>{o.delivered_at && o.status === "received" ? "Delivered" : STATUS_LABEL[o.status]}</Text>
          </View>
          <TouchableOpacity
            disabled={!!o.xero_bill_id || busy}
            onPress={() => setAmountFor({ order: o, amount: o.amount ? o.amount.toFixed(2) : "" })}
            accessibilityLabel={o.xero_bill_id ? "Amount locked — in Xero" : "Set the amount ex GST"}
          >
            {o.amount ? (
              <Text style={styles.orderAmount}>
                <MoneyText amount={o.amount} /> ex GST{o.xero_bill_id ? "" : " ✎"}
              </Text>
            ) : (
              <Text style={styles.link}>Set amount</Text>
            )}
          </TouchableOpacity>
        </View>
        {o.items.length > 0 && <Text style={styles.small}>{o.items.map((i) => `${i.quantity} × ${i.description}`).join(", ")}</Text>}
        {o.invoice_number ? (
          <View style={styles.invoiceRow}>
            <Text style={styles.small}>
              Inv {o.invoice_number}
              {o.invoice_date ? ` · ${o.invoice_date}` : ""}
            </Text>
            {o.invoice_storage_path && (
              <TouchableOpacity onPress={() => void viewInvoiceFile(o)} hitSlop={6}>
                <Text style={styles.link}>View</Text>
              </TouchableOpacity>
            )}
            {o.xero_bill_id ? (
              <Text style={styles.inXero}>In Xero</Text>
            ) : (
              <>
                <TouchableOpacity onPress={() => openInvoice(o)} hitSlop={6}>
                  <Text style={styles.link}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => confirmXero(o)} disabled={busy} hitSlop={6}>
                  <Text style={[styles.link, styles.bold]}>Send to Xero</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : (
          o.status !== "cancelled" && (
            <TouchableOpacity onPress={() => openInvoice(o)} hitSlop={6}>
              <Text style={styles.link}>+ Enter supplier invoice</Text>
            </TouchableOpacity>
          )
        )}
      </View>
    );
  }

  function renderPo(po: JobPo) {
    const split = poSplitState(po);
    const busy = busyId === po.id;
    return (
      <View key={po.id} style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.poNumber}>PO {po.po_number}</Text>
          {busy && <ActivityIndicator size="small" color={colors.blue600} />}
        </View>
        {!!po.client_reference && <Text style={styles.small}>Client: {po.client_reference}</Text>}
        {!!po.site_address && <Text style={styles.small}>Site: {po.site_address}</Text>}
        <View style={styles.figures}>
          <Text style={styles.figure}>
            Value <MoneyText amount={po.total_value} style={styles.bold} />
          </Text>
          <Text style={styles.figure}>{po.total_hours} h allowed</Text>
        </View>
        {view.poInvoiced?.[po.id]?.status === "part" && (
          <Text style={styles.small}>
            Invoiced so far <MoneyText amount={view.poInvoiced[po.id].invoiced} /> (#{view.poInvoiced[po.id].numbers.join(", #")})
          </Text>
        )}
        {split.kind !== "split" && (
          <Text style={split.kind === "over" ? styles.over : styles.unsplit}>
            <MoneyText amount={split.amount} /> {split.kind === "over" ? "over the PO value" : "not split yet"}
          </Text>
        )}

        {po.lines.map((l) => (
          <View key={l.id} style={styles.line}>
            <View style={styles.rowBetween}>
              <Text style={styles.lineName} numberOfLines={2}>
                {l.name}
                {centreName(l.cost_centre_id) && centreName(l.cost_centre_id) !== l.name ? ` · ${centreName(l.cost_centre_id)}` : ""}
                {!l.cost_centre_id ? " · no cost centre" : ""}
              </Text>
              <MoneyText amount={l.allocated_amount} style={styles.lineAmount} />
            </View>
            <Text style={styles.small}>
              {Math.round((view.hoursByLine[l.id] ?? 0) * 10) / 10} of {l.allocated_hours} h logged
              {l.completed_at ? " · stage complete" : ""}
            </Text>
            {(byLine[l.id] ?? []).map(renderOrder)}
          </View>
        ))}

        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => openEdit(po)} disabled={busy}>
            <Ionicons name="create-outline" size={15} color={colors.blue600} />
            <Text style={styles.actionText}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => openEdit(po, true)} disabled={busy}>
            <Ionicons name="add" size={15} color={colors.blue600} />
            <Text style={styles.actionText}>Add cost centre</Text>
          </TouchableOpacity>
          {view.poInvoiced?.[po.id]?.status === "full" ? (
            <View style={styles.invoicedChip}>
              <Ionicons name="checkmark-circle" size={15} color={colors.green600} />
              <Text style={styles.invoicedText}>
                Invoiced{view.poInvoiced[po.id].numbers.length ? ` #${view.poInvoiced[po.id].numbers.join(", #")}` : ""}
              </Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.actionBtn} onPress={() => invoicePo(po)} disabled={busy}>
              <Ionicons name="document-text-outline" size={15} color={colors.blue600} />
              <Text style={styles.actionText}>{view.poInvoiced?.[po.id]?.status === "part" ? "Invoice next claim" : "Invoice this PO"}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.actionBtn} onPress={() => confirmDeletePo(po)} disabled={busy} accessibilityLabel={`Remove PO ${po.po_number}`}>
            <Ionicons name="trash-outline" size={15} color={colors.red600} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.rowBetween}>
        <Text style={styles.summary}>
          {view.pos.length} PO{view.pos.length === 1 ? "" : "s"} · <MoneyText amount={totalValue} /> · {totalHours} h
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={openNew}>
          <Ionicons name="add" size={16} color={colors.white} />
          <Text style={styles.primaryBtnText}>Add PO</Text>
        </TouchableOpacity>
      </View>
      {view.pos.length === 0 ? (
        <Text style={styles.empty}>No purchase orders on this job yet. Add the builder&apos;s PO (or the quote total) and split it across cost centres.</Text>
      ) : (
        view.pos.map(renderPo)
      )}

      {draft && (
        <PoSheet
          draft={draft}
          setDraft={setDraft}
          view={view}
          saving={saving}
          onSave={() => void savePo()}
          onCancel={() => setDraft(null)}
        />
      )}

      {amountFor && (
        <KeyboardSheet
          visible
          onRequestClose={() => setAmountFor(null)}
          title={`${amountFor.order.po_number} · amount ex GST`}
          footer={
            <SheetButtons onCancel={() => setAmountFor(null)} onSave={() => void saveAmount()} saving={false} />
          }
        >
          <Text style={styles.label}>From the supplier&apos;s invoice, ex GST</Text>
          <TextInput
            style={styles.input}
            value={amountFor.amount}
            onChangeText={(amount) => setAmountFor({ ...amountFor, amount })}
            keyboardType="decimal-pad"
            placeholder="0.00"
            autoFocus
          />
        </KeyboardSheet>
      )}

      {invoice && (
        <KeyboardSheet
          visible
          onRequestClose={() => !saving && setInvoice(null)}
          title={`Supplier invoice · ${invoice.order.po_number}`}
          footer={<SheetButtons onCancel={() => setInvoice(null)} onSave={() => void saveInvoice()} saving={saving} />}
        >
          <Text style={styles.label}>Invoice number</Text>
          <TextInput style={styles.input} value={invoice.invoiceNumber} onChangeText={(invoiceNumber) => setInvoice({ ...invoice, invoiceNumber })} autoCapitalize="characters" />
          <Text style={styles.label}>Invoice date (YYYY-MM-DD)</Text>
          <TextInput style={styles.input} value={invoice.invoiceDate} onChangeText={(invoiceDate) => setInvoice({ ...invoice, invoiceDate })} keyboardType="numbers-and-punctuation" />
          <Text style={styles.label}>Amount ex GST</Text>
          <TextInput
            style={styles.input}
            value={invoice.amount}
            onChangeText={(amount) => setInvoice({ ...invoice, amount })}
            keyboardType="decimal-pad"
            placeholder="0.00"
            editable={!invoice.order.xero_bill_id}
          />
          {gstOf(invoice.amount) != null && (
            <Text style={styles.small}>
              GST <MoneyText amount={gstOf(invoice.amount)} />
            </Text>
          )}
          <Text style={styles.label}>Invoice file</Text>
          <Text style={styles.small}>
            {invoice.picked
              ? `${invoice.picked.originalName} attached — kept from technicians (office only).`
              : invoice.photoUri
                ? "Photo attached — kept from technicians (office only)."
                : invoice.order.invoice_storage_path
                  ? "A file is already attached. Take a photo or choose a file to replace it."
                  : documentPickerAvailable()
                    ? "Photograph the invoice, or choose the PDF from your files."
                    : "Photograph the invoice. PDFs from email are attached on the website."}
          </Text>
          <View style={styles.photoRow}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={async () => { const uri = await pickPhoto("camera"); if (uri) setInvoice((d) => d && { ...d, photoUri: uri, picked: null }); }}>
              <Text style={styles.secondaryBtnText}>Take photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={async () => { const uri = await pickPhoto("library"); if (uri) setInvoice((d) => d && { ...d, photoUri: uri, picked: null }); }}>
              <Text style={styles.secondaryBtnText}>Choose photo</Text>
            </TouchableOpacity>
            {documentPickerAvailable() && (
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={async () => {
                  const res = await pickUploadFile();
                  if (!res) return;
                  if (!res.ok) {
                    Alert.alert("Can't attach that file", res.error);
                    return;
                  }
                  setInvoice((d) => d && { ...d, picked: res.upload, photoUri: null });
                }}
              >
                <Text style={styles.secondaryBtnText}>Choose file</Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardSheet>
      )}
    </View>
  );
}

function PoSheet({
  draft,
  setDraft,
  view,
  saving,
  onSave,
  onCancel,
}: {
  draft: PoDraft;
  setDraft: (d: PoDraft | null) => void;
  view: JobPurchaseOrdersState;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const f = draft.form;
  const set = (patch: Partial<PoFormInput>) => setDraft({ ...draft, form: { ...f, ...patch } });
  const setLine = (i: number, patch: Partial<BuilderPoLineInput>) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const split = poSplitState({
    total_value: Number(f.value.replace(/[$,\s]/g, "")) || 0,
    lines: f.lines.map((l) => ({ allocated_amount: Number(l.amount.replace(/[$,\s]/g, "")) || 0 })) as JobPo["lines"],
  });

  return (
    <KeyboardSheet
      visible
      onRequestClose={() => !saving && onCancel()}
      title={draft.poId ? `Edit PO ${f.poNumber}` : "Add purchase order"}
      footer={<SheetButtons onCancel={onCancel} onSave={onSave} saving={saving} />}
    >
      <Text style={styles.label}>PO number</Text>
      <TextInput style={styles.input} value={f.poNumber} onChangeText={(poNumber) => set({ poNumber })} autoCapitalize="characters" />
      <Text style={styles.label}>Client</Text>
      <TextInput style={styles.input} value={f.clientReference} onChangeText={(clientReference) => set({ clientReference })} />
      <Text style={styles.label}>Site</Text>
      <TextInput style={styles.input} value={f.siteAddress} onChangeText={(siteAddress) => set({ siteAddress })} />
      <Text style={styles.label}>PO value, ex GST</Text>
      <TextInput
        style={styles.input}
        value={f.value}
        onChangeText={(value) => set({ value })}
        keyboardType="decimal-pad"
        placeholder="Blank = the lines' total"
      />

      <Text style={[styles.label, styles.sectionLabel]}>Split across cost centres</Text>
      {view.costCentres.length === 0 && <Text style={styles.small}>The cost centre list couldn&apos;t load — add lines on the website.</Text>}
      {f.lines.map((l, i) => {
        const removable = !l.id || !view.inUse[l.id];
        return (
          <View key={l.id ?? `new-${i}`} style={styles.formLine}>
            <View style={styles.chips}>
              {view.costCentres.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.chip, l.costCentreId === c.id && styles.chipActive]}
                  onPress={() => setLine(i, { costCentreId: c.id })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: l.costCentreId === c.id }}
                >
                  <Text style={[styles.chipText, l.costCentreId === c.id && styles.chipTextActive]}>{c.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput style={styles.input} value={l.stage} onChangeText={(stage) => setLine(i, { stage })} placeholder="Stage (optional), e.g. Sewer" />
            <View style={styles.pair}>
              <TextInput style={[styles.input, styles.half]} value={l.amount} onChangeText={(amount) => setLine(i, { amount })} keyboardType="decimal-pad" placeholder="$ amount" />
              <TextInput style={[styles.input, styles.half]} value={l.hours} onChangeText={(hours) => setLine(i, { hours })} keyboardType="decimal-pad" placeholder="Hours" />
            </View>
            {removable ? (
              <TouchableOpacity onPress={() => set({ lines: f.lines.filter((_, j) => j !== i) })} hitSlop={6}>
                <Text style={styles.removeLine}>Remove line</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.small}>Can&apos;t be removed: {view.inUse[l.id!]} Set it to $0 instead.</Text>
            )}
          </View>
        );
      })}
      <TouchableOpacity
        onPress={() => set({ lines: [...f.lines, { ...blankLine(), amount: remainingToSplit(f.value, f.lines) }] })}
        hitSlop={6}
      >
        <Text style={styles.link}>+ Add cost centre</Text>
      </TouchableOpacity>
      {f.value.trim() !== "" && split.kind !== "split" && (
        <Text style={split.kind === "over" ? styles.over : styles.unsplit}>
          <MoneyText amount={split.amount} /> {split.kind === "over" ? "over the PO value" : "not split yet"}
        </Text>
      )}
    </KeyboardSheet>
  );
}

function SheetButtons({ onCancel, onSave, saving }: { onCancel: () => void; onSave: () => void; saving: boolean }) {
  return (
    <View style={styles.sheetButtons}>
      <TouchableOpacity style={[styles.secondaryBtn, styles.flex]} onPress={onCancel} disabled={saving}>
        <Text style={styles.secondaryBtnText}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.primaryBtn, styles.flex]} onPress={onSave} disabled={saving}>
        {saving ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryBtnText}>Save</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  center: { paddingVertical: 30, alignItems: "center" },
  notice: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: colors.slate100, borderRadius: 10, padding: 12 },
  noticeText: { flex: 1, fontSize: 13, color: colors.slate700 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  summary: { flex: 1, fontSize: 13, color: colors.slate500 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 16, fontSize: 13 },
  card: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 6 },
  poNumber: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  small: { fontSize: 12, color: colors.slate500 },
  figures: { flexDirection: "row", gap: 16 },
  figure: { fontSize: 13, color: colors.slate700 },
  bold: { fontWeight: "700" },
  unsplit: { fontSize: 12, color: colors.yellow700, fontWeight: "600" },
  over: { fontSize: 12, color: colors.red600, fontWeight: "600" },
  line: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 4, gap: 4 },
  lineName: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.slate900 },
  lineAmount: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  order: { backgroundColor: colors.bg, borderRadius: 8, borderWidth: 1, borderColor: colors.border, padding: 8, gap: 4, marginTop: 4 },
  orderTitle: { flex: 1, fontSize: 13, fontWeight: "600", color: colors.slate900 },
  orderMeta: { flexDirection: "row", alignItems: "center", gap: 10 },
  orderAmount: { fontSize: 13, color: colors.slate700 },
  invoiceRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 },
  inXero: { fontSize: 12, fontWeight: "700", color: colors.green600 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: "700" },
  link: { fontSize: 13, color: colors.blue600 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.blue100, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  actionText: { fontSize: 13, fontWeight: "600", color: colors.blue600 },
  invoicedChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.green100 },
  invoicedText: { fontSize: 13, fontWeight: "600", color: colors.green600 },
  primaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: colors.blue600, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  primaryBtnText: { color: colors.white, fontWeight: "700", fontSize: 14 },
  secondaryBtn: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.card },
  secondaryBtnText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  sheetButtons: { flexDirection: "row", gap: 10 },
  flex: { flex: 1 },
  label: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginTop: 10, marginBottom: 4 },
  sectionLabel: { marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    color: colors.slate900,
    backgroundColor: colors.card,
  },
  formLine: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 8, marginBottom: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.card },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 13, color: colors.slate700 },
  chipTextActive: { color: colors.white, fontWeight: "600" },
  pair: { flexDirection: "row", gap: 8 },
  half: { flex: 1 },
  removeLine: { fontSize: 13, color: colors.red600 },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
});
