import { escapeHtml } from "@/lib/html";
import type { MonthCoverage, UnallocatedSummary } from "@/lib/unallocated-bills";

// The Monday email to the office. The email is the NUDGE; the worklist lives in
// the app (Reports → Unallocated bills), so it carries a few numbers and the
// oldest items, then a link — not the whole list.

export interface DigestDebtor {
  customer: string;
  invoiceNumber: number | string;
  dueDate: string | null;
  balance: number;
}

export interface DigestAwaitingInvoice {
  poNumber: string;
  supplier: string;
  orderedOn: string | null;
}

export interface DigestInput {
  appUrl: string;
  unallocated: UnallocatedSummary;
  /** Latest months first or last — only the final `recentMonths` are used. */
  coverage: MonthCoverage[];
  overdue: { total: number; count: number; top: DigestDebtor[] };
  awaitingInvoice: { count: number; oldest: DigestAwaitingInvoice[] };
  /** Komtrax fault codes in the last 7 days (0113); null/undefined = Komtrax not set up, section left out. */
  machineFaults?: DigestMachineFault[] | null;
}

/** One machine + fault code seen in the last week (lib/komtrax-data.ts groupFaults). */
export interface DigestMachineFault {
  machine: string;
  code: string;
  severity: string | null;
  description: string | null;
  /** ISO instant */
  lastSeen: string;
  times: number;
}

const FAULT_LIMIT = 12;
const faultDay = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "Australia/Melbourne" });
const faultLine = (f: DigestMachineFault) =>
  `${f.machine}  ${f.code}${f.severity ? ` (${f.severity})` : ""}  ${f.description ?? ""}  last ${faultDay(f.lastSeen)}${f.times > 1 ? `, ${f.times} times` : ""}`;

const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const RECENT_MONTHS = 3;
const LIST_LIMIT = 8;

export function buildDigest(i: DigestInput): { subject: string; html: string; text: string } {
  const link = `${i.appUrl}/dashboard/reports/unallocated-bills`;
  const recent = i.coverage.slice(-RECENT_MONTHS);
  const oldest = i.unallocated.bills.slice(0, LIST_LIMIT);
  const faults = i.machineFaults ?? null;
  const shownFaults = (faults ?? []).slice(0, FAULT_LIMIT);
  const faultsHeading = faults ? `ACTIVE MACHINE FAULTS (LAST 7 DAYS): ${faults.length === 0 ? "none" : faults.length}` : null;

  const subject =
    i.unallocated.count === 0
      ? "Weekly office summary — every bill is allocated"
      : `Weekly office summary — ${i.unallocated.count} bill${i.unallocated.count === 1 ? "" : "s"} (${money(i.unallocated.total)}) need a job`;

  const covLine = (m: MonthCoverage) =>
    `${m.month}: ${m.tracedPct === null ? "no job spend" : `${m.tracedPct}% of job spend traced to a job`} (${money(m.total)} billed)`;

  const text = [
    "WEEKLY OFFICE SUMMARY",
    "",
    `BILLS WITH NO JOB: ${i.unallocated.count} bills, ${money(i.unallocated.total)} ex GST`,
    ...oldest.map((b) => `  - ${b.invoice_date ?? "no date"}  ${b.contact_name ?? "Unknown supplier"}  ${b.invoice_number ?? ""}  ${money(b.sub_total)}`),
    i.unallocated.count > oldest.length ? `  …and ${i.unallocated.count - oldest.length} more` : "",
    `Assign them here: ${link}`,
    "",
    "HOW MUCH OF OUR SPEND IS TRACED TO A JOB",
    ...recent.map((m) => `  ${covLine(m)}`),
    "",
    `OVERDUE DEBTORS: ${i.overdue.count} invoices, ${money(i.overdue.total)}`,
    ...i.overdue.top.map((d) => `  - ${d.customer}  #${d.invoiceNumber}  due ${d.dueDate ?? "?"}  ${money(d.balance)}`),
    "",
    `SUPPLIER POs STILL WAITING FOR THEIR INVOICE: ${i.awaitingInvoice.count}`,
    ...i.awaitingInvoice.oldest.map((p) => `  - ${p.poNumber}  ${p.supplier}  ordered ${p.orderedOn ?? "?"}`),
    ...(faultsHeading
      ? [
          "",
          faultsHeading,
          ...shownFaults.map((f) => `  - ${faultLine(f)}`),
          faults!.length > shownFaults.length ? `  …and ${faults!.length - shownFaults.length} more` : "",
          faults!.length > 0 ? `Details on each machine in Fleet: ${i.appUrl}/dashboard/fleet` : "",
        ]
      : []),
  ]
    .filter((l, idx, a) => !(l === "" && a[idx - 1] === ""))
    .join("\n");

  const row = (cells: string[]) =>
    `<tr>${cells.map((c) => `<td style="padding:5px 8px;border-bottom:1px solid #e2e8f0;">${c}</td>`).join("")}</tr>`;
  const table = (rows: string[]) => (rows.length ? `<table style="border-collapse:collapse;font-size:14px;">${rows.join("")}</table>` : "");
  const h = (t: string) => `<h3 style="margin:20px 0 6px;font-size:15px;color:#0f172a;">${t}</h3>`;

  const html = `<div style="font-family:Arial,sans-serif;color:#1e293b;max-width:640px;">
<h2 style="margin:0 0 4px;">Weekly office summary</h2>
${h(`Bills with no job: ${i.unallocated.count} (${money(i.unallocated.total)} ex GST)`)}
${table(oldest.map((b) => row([escapeHtml(b.invoice_date ?? ""), escapeHtml(b.contact_name ?? "Unknown supplier"), escapeHtml(b.invoice_number ?? ""), money(b.sub_total)])))}
${i.unallocated.count > oldest.length ? `<p style="font-size:13px;color:#64748b;">…and ${i.unallocated.count - oldest.length} more</p>` : ""}
<p><a href="${escapeHtml(link)}" style="background:#2563eb;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:14px;">Assign them in the app</a></p>
${h("How much of our spend is traced to a job")}
${table(recent.map((m) => row([escapeHtml(m.month), m.tracedPct === null ? "no job spend" : `${m.tracedPct}%`, `${money(m.total)} billed`])))}
${h(`Overdue debtors: ${i.overdue.count} invoices, ${money(i.overdue.total)}`)}
${table(i.overdue.top.map((d) => row([escapeHtml(d.customer), `#${escapeHtml(String(d.invoiceNumber))}`, `due ${escapeHtml(d.dueDate ?? "?")}`, money(d.balance)])))}
${h(`Supplier POs still waiting for their invoice: ${i.awaitingInvoice.count}`)}
${table(i.awaitingInvoice.oldest.map((p) => row([escapeHtml(p.poNumber), escapeHtml(p.supplier), `ordered ${escapeHtml(p.orderedOn ?? "?")}`])))}
${
  faults
    ? `${h(`Active machine faults (last 7 days): ${faults.length === 0 ? "none" : faults.length}`)}
${table(shownFaults.map((f) => row([escapeHtml(f.machine), `<code>${escapeHtml(f.code)}</code>${f.severity ? ` (${escapeHtml(f.severity)})` : ""}`, escapeHtml(f.description ?? ""), `last ${escapeHtml(faultDay(f.lastSeen))}${f.times > 1 ? `, ${f.times}×` : ""}`])))}
${faults.length > shownFaults.length ? `<p style="font-size:13px;color:#64748b;">…and ${faults.length - shownFaults.length} more</p>` : ""}`
    : ""
}
</div>`;

  return { subject, html, text };
}
