import { officeApi } from "./officeApi";

// Clocked hours on the phone's Approvals screen, and "Apply hourly rate" on the
// job's invoice — the web's components/approvals/approvals-client.tsx hours
// panel and components/invoice/invoice-hours.tsx. Office/admin only (the
// routes check). Every figure is computed on the server (lib/approved-hours.ts,
// lib/invoice-hours.ts); the phone shows them and sends the rates typed.

/** One invoice line's worth of hours: a cost centre × technician (lib/approved-hours.ts HoursGroup). */
export interface HoursGroup {
  key: string;
  costCentreKey: string;
  costCentreName: string | null;
  staffId: string;
  staffName: string;
  hours: number;
  entryIds: string[];
}

export interface ApprovalHoursSummary {
  groups: HoursGroup[];
  total: number;
  error: string | null;
}

/** Map key the server uses for hours with no cost centre. */
export const NO_COST_CENTRE = "none";

export type RateMode = "all" | "technician" | "cost_centre";
export type RateSource = "quote" | "charge_out" | "company";

export interface RateDefaults {
  all: number;
  allSource: RateSource;
  byStaff: Record<string, { rate: number; source: RateSource }>;
  byCostCentre: Record<string, { rate: number; source: RateSource }>;
}

/** GET /api/invoices/[id]/hours (lib/invoice-hours.ts InvoiceHoursView). */
export interface InvoiceHoursView {
  invoiceId: string;
  jobId: string | null;
  groups: (HoursGroup & { billedHere: boolean })[];
  unbilledHours: number;
  billedHereHours: number;
  billedElsewhereHours: number;
  defaults: RateDefaults | null;
  locked: boolean;
  outside: "xero" | "sent" | null;
}

export interface ApplyHoursResult {
  ok: true;
  lines: number;
  entries: number;
  hours: number;
  subtotal: number;
  tax: number;
  total: number;
}

export const SOURCE_LABEL: Record<RateSource, string> = {
  quote: "from the job's quote",
  charge_out: "their charge-out rate",
  company: "company rate",
};

export const RATE_MODES: { value: RateMode; label: string }[] = [
  { value: "all", label: "One rate" },
  { value: "technician", label: "Per technician" },
  { value: "cost_centre", label: "Per cost centre" },
];

export async function loadApprovalHours(jobIds: string[]): Promise<Record<string, ApprovalHoursSummary>> {
  if (jobIds.length === 0) return {};
  const { hoursByJob } = await officeApi<{ hoursByJob: Record<string, ApprovalHoursSummary> }>(
    `/api/approvals/hours?jobIds=${encodeURIComponent(jobIds.join(","))}`
  );
  return hoursByJob ?? {};
}

export function loadInvoiceHours(invoiceId: string): Promise<InvoiceHoursView> {
  return officeApi<InvoiceHoursView>(`/api/invoices/${invoiceId}/hours`);
}

/** The rate form: one text per field, as typed. */
export interface RateForm {
  mode: RateMode;
  all: string;
  byStaff: Record<string, string>;
  byCostCentre: Record<string, string>;
}

/** The form as it opens: the server's defaults (quote rate, charge-out, company rate). */
export function initialRateForm(view: Pick<InvoiceHoursView, "defaults">): RateForm {
  const d = view.defaults;
  return {
    mode: "all",
    all: d ? String(d.all) : "",
    byStaff: d ? Object.fromEntries(Object.entries(d.byStaff).map(([k, v]) => [k, String(v.rate)])) : {},
    byCostCentre: d ? Object.fromEntries(Object.entries(d.byCostCentre).map(([k, v]) => [k, String(v.rate)])) : {},
  };
}

/** The distinct technicians / cost centres the form asks a rate for. */
export function rateTargets(groups: Pick<HoursGroup, "staffId" | "staffName" | "costCentreKey" | "costCentreName">[]) {
  const staff = [...new Map(groups.map((g) => [g.staffId, g.staffName])).entries()].map(([id, name]) => ({ id, name }));
  const costCentres = [...new Map(groups.map((g) => [g.costCentreKey, g.costCentreName])).entries()].map(([key, name]) => ({
    key,
    name: key === NO_COST_CENTRE ? "No cost centre" : name ?? "Cost centre",
  }));
  return { staff, costCentres };
}

const isRate = (s: string | undefined) => s != null && s.trim() !== "" && Number.isFinite(Number(s)) && Number(s) >= 0;

/** Why the form can't be sent yet, or null. The server checks again; this just saves a round trip. */
export function rateFormProblem(form: RateForm, groups: Pick<HoursGroup, "staffId" | "staffName" | "costCentreKey" | "costCentreName">[]): string | null {
  if (groups.length === 0) return "There are no hours to bill on this job.";
  const { staff, costCentres } = rateTargets(groups);
  if (form.mode === "all") return isRate(form.all) ? null : "Enter an hourly rate for all hours.";
  if (form.mode === "technician") {
    const missing = staff.find((s) => !isRate(form.byStaff[s.id]));
    return missing ? `Enter an hourly rate for ${missing.name}.` : null;
  }
  const missing = costCentres.find((c) => !isRate(form.byCostCentre[c.key]));
  return missing ? `Enter an hourly rate for ${missing.name}.` : null;
}

/** POST /api/invoices/[id]/hours body — the same shape the web form sends. */
export function rateBody(form: RateForm, confirmOutside: boolean) {
  return { mode: form.mode, all: form.all, byStaff: form.byStaff, byCostCentre: form.byCostCentre, confirmOutside };
}

export function applyHourlyRate(invoiceId: string, form: RateForm, confirmOutside = false): Promise<ApplyHoursResult> {
  return officeApi<ApplyHoursResult>(`/api/invoices/${invoiceId}/hours`, { method: "POST", body: rateBody(form, confirmOutside) });
}
