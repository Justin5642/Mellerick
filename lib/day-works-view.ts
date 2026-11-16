// What the job's Day Works / Hire tab is sent (GET /api/jobs/[id]/hire-entries).
//
// THE MONEY RULE (HANDOVER §2): the route reads the office-only rate tables
// through the service role, so THIS is the place a dollar figure could leak to
// a technician. Everything is copied field by field; rates and amounts are
// added only when `isOffice`. tests/unit/day-works-view.test.ts pins that the
// technician payload carries no money-named key at any depth.

import {
  attachmentClashes,
  hireOptionLabel,
  priceEntry,
  totalsByCostCentre,
  type HireAttachmentRate,
  type HireOption,
  type HireStatus,
  type HireType,
  type HireUnit,
} from "@/lib/hire-pricing";

export interface MachineRow {
  id: string;
  name: string;
  is_active: boolean;
  /** vehicle / machinery / tool / other (0016). Tools ("Plant & equipment", 0100) are never hired out. */
  category?: string | null;
  options: (HireOption & { whole_days_only?: boolean | null; fuel_included?: boolean | null; is_active?: boolean | null })[];
}

export interface EntryRow {
  id: string;
  job_id: string;
  equipment_id: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  work_date: string;
  hours: number | string | null;
  days: number | string | null;
  meter_open: number | string | null;
  meter_close: number | string | null;
  km: number | string | null;
  pickup: string | null;
  dropoff: string | null;
  description: string | null;
  cost_centre_id: string | null;
  status: HireStatus;
  signer_name: string | null;
  signature_path: string | null;
  signed_at: string | null;
  invoice_id: string | null;
  void_reason: string | null;
  created_by: string | null;
  attachment_ids: string[];
  created_by_name?: string | null;
}

/** Another entry (any job) ticking one of this job's attachments on the same day. */
export interface OtherAttachmentUse {
  entry_id: string;
  attachment_id: string;
  equipment_id: string;
  work_date: string;
  status: string;
  job_number: number | null;
}

export interface DayWorksMachine {
  id: string;
  name: string;
  /** Empty = the office hasn't set a hire rate for this machine yet: shown greyed, can't be picked. */
  options: { hire_type: HireType; hire_unit: HireUnit; label: string; whole_days_only: boolean; fuel_included: boolean }[];
}

export interface DayWorksEntry {
  id: string;
  equipment_id: string;
  equipment: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  hire_label: string;
  work_date: string;
  hours: number | null;
  days: number | null;
  meter_open: number | null;
  meter_close: number | null;
  km: number | null;
  pickup: string | null;
  dropoff: string | null;
  description: string | null;
  cost_centre: string | null;
  status: HireStatus;
  signer_name: string | null;
  signed_at: string | null;
  signature_url: string | null;
  invoice_id: string | null;
  void_reason: string | null;
  attachment_ids: string[];
  created_by: string | null;
  created_by_name: string | null;
}

export interface DayWorksClash {
  attachment: string;
  work_date: string;
  /** "Bobcat (this job)", "PC18 (job #812)". */
  machines: string[];
  entry_ids: string[];
}

export interface DayWorksOfficePricing {
  /** Amounts by entry id, ex GST. total null = the machine has no hire rate set up. */
  entries: Record<string, { machine: number | null; attachments: number; total: number | null; quantity: number | null; unitPrice: number | null }>;
  byCostCentre: { name: string; amount: number; entries: number; unpriced: number }[];
  /** Signed and not yet invoiced, priced. */
  uninvoicedSigned: number;
}

export interface DayWorksView {
  machines: DayWorksMachine[];
  attachments: { id: string; name: string }[];
  entries: DayWorksEntry[];
  clashes: DayWorksClash[];
  pricing?: DayWorksOfficePricing;
}

/** Active and not a tool: the machines Day Works lists (and Fleet → Hire rates covers). */
export function isHireableMachine(m: { is_active: boolean | null; category?: string | null }): boolean {
  return m.is_active === true && m.category !== "tool";
}

/** The picker's two groups: machines that can be picked, then those still waiting for a hire rate. */
export function splitMachinesByHire<M extends { options: unknown[] }>(machines: M[]): { ready: M[]; noRate: M[] } {
  return { ready: machines.filter((m) => m.options.length > 0), noRate: machines.filter((m) => m.options.length === 0) };
}

const n = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));

export function buildDayWorksView(input: {
  isOffice: boolean;
  jobId: string;
  machines: MachineRow[];
  attachments: (HireAttachmentRate & { is_active?: boolean | null })[];
  entries: EntryRow[];
  others: OtherAttachmentUse[];
  costCentreNames: Map<string, string>;
  signatureUrls: Map<string, string>;
}): DayWorksView {
  const { isOffice, machines, attachments, entries, others, costCentreNames, signatureUrls } = input;
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  const attachmentName = new Map(attachments.map((a) => [a.id, a.name]));

  // The register for the picker: the WHOLE active fleet except tools (the same
  // rule 0108's seed used), so a machine the office hasn't priced yet is still
  // seen — with no options, greyed out — instead of silently missing. Names,
  // hire types and flags only — never a rate.
  const shownMachines: DayWorksMachine[] = machines
    .filter(isHireableMachine)
    .map((m) => ({
      id: m.id,
      name: m.name,
      options: m.options
        .filter((o) => o.is_active !== false)
        .map((o) => ({
          hire_type: o.hire_type,
          hire_unit: o.hire_unit,
          label: hireOptionLabel(o),
          whole_days_only: !!o.whole_days_only,
          fuel_included: !!o.fuel_included,
        })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const shownEntries: DayWorksEntry[] = entries.map((e) => ({
    id: e.id,
    equipment_id: e.equipment_id,
    equipment: machineName.get(e.equipment_id) ?? "Machine",
    hire_type: e.hire_type,
    hire_unit: e.hire_unit,
    hire_label: hireOptionLabel(e),
    work_date: e.work_date,
    hours: n(e.hours),
    days: n(e.days),
    meter_open: n(e.meter_open),
    meter_close: n(e.meter_close),
    km: n(e.km),
    pickup: e.pickup,
    dropoff: e.dropoff,
    description: e.description,
    cost_centre: e.cost_centre_id ? costCentreNames.get(e.cost_centre_id) ?? null : null,
    status: e.status,
    signer_name: e.signer_name,
    signed_at: e.signed_at,
    signature_url: e.signature_path ? signatureUrls.get(e.signature_path) ?? null : null,
    invoice_id: e.invoice_id,
    void_reason: e.void_reason,
    attachment_ids: e.attachment_ids,
    created_by: e.created_by,
    created_by_name: e.created_by_name ?? null,
  }));

  // Clashes: this job's entries plus other jobs' entries using the same
  // attachments on the same days.
  const ownIds = new Set(entries.map((e) => e.id));
  const otherByEntry = new Map<string, { equipment_id: string; work_date: string; status: string; attachment_ids: string[]; job_number: number | null }>();
  for (const o of others) {
    if (ownIds.has(o.entry_id)) continue;
    const r = otherByEntry.get(o.entry_id) ?? { equipment_id: o.equipment_id, work_date: o.work_date, status: o.status, attachment_ids: [], job_number: o.job_number };
    r.attachment_ids.push(o.attachment_id);
    otherByEntry.set(o.entry_id, r);
  }
  const all = [
    ...entries.map((e) => ({ id: e.id, equipment_id: e.equipment_id, work_date: e.work_date, status: e.status, attachment_ids: e.attachment_ids })),
    ...[...otherByEntry.entries()].map(([id, r]) => ({ id, ...r })),
  ];
  const clashes: DayWorksClash[] = attachmentClashes(all)
    .filter((c) => c.entryIds.some((id) => ownIds.has(id)))
    .map((c) => ({
      attachment: attachmentName.get(c.attachmentId) ?? "Attachment",
      work_date: c.workDate,
      entry_ids: c.entryIds.filter((id) => ownIds.has(id)),
      machines: c.entryIds.map((id) => {
        const own = entries.find((e) => e.id === id);
        if (own) return `${machineName.get(own.equipment_id) ?? "Machine"} (this job)`;
        const o = otherByEntry.get(id)!;
        return `${machineName.get(o.equipment_id) ?? "Machine"}${o.job_number ? ` (job #${o.job_number})` : " (another job)"}`;
      }),
    }));

  const view: DayWorksView = {
    machines: shownMachines,
    attachments: attachments.filter((a) => a.is_active !== false).map((a) => ({ id: a.id, name: a.name })),
    entries: shownEntries,
    clashes,
  };
  if (!isOffice) return view;

  // Office only from here: rates → amounts.
  const options: HireOption[] = machines.flatMap((m) => m.options.map((o) => ({ ...o, equipment_id: m.id })));
  const priced = entries.map((e) => ({ e, p: priceEntry(e, options, e.attachment_ids, attachments) }));
  const live = priced.filter(({ e }) => e.status !== "void");
  view.pricing = {
    entries: Object.fromEntries(
      priced.map(({ e, p }) => [
        e.id,
        {
          machine: p.machine?.amount ?? null,
          attachments: p.attachments.reduce((s, a) => s + a.amount, 0),
          total: p.total,
          quantity: p.machine?.quantity ?? null,
          unitPrice: p.machine?.unitPrice ?? null,
        },
      ])
    ),
    byCostCentre: totalsByCostCentre(live.map(({ p }) => p)).map((t) => ({
      name: t.cost_centre_id ? costCentreNames.get(t.cost_centre_id) ?? "Cost centre" : "Not tagged",
      amount: t.amount,
      entries: t.entries,
      unpriced: t.unpriced,
    })),
    uninvoicedSigned: Math.round(live.filter(({ e }) => e.status === "signed").reduce((s, { p }) => s + (p.total ?? 0), 0) * 100) / 100,
  };
  return view;
}
