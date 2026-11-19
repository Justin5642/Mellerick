// MIRROR of the web's lib/booking-cost-centre.ts — bookings always ask for a
// cost centre (19 Nov 2026). The phone's Schedule Job sheet, the Schedule
// tab's to-do placing and New Job use exactly these rules, so the phone and
// the website default and check a booking's cost centre the same way.
//
// Everything from the first export on is pinned byte-identical to the web
// file by tests/unit/booking-cost-centre-mirror.test.ts. Change the web file
// first, then copy its body here. NO MONEY: names and ids only.
export const PICK_COST_CENTRE = "Pick a cost centre";
export const ADD_COST_CENTRE_OFFLINE = "Adding a cost centre needs signal.";

/** One of the job's PO lines, as the picker shows it. */
export interface BookingLineOption {
  id: string;
  name: string;
  /** The company cost centre the line is tagged with (0087); null for an untagged Simpro line. */
  cost_centre_id?: string | null;
  po_number?: string | null;
}

/** A company cost centre (cost_centres). */
export interface CompanyCostCentreOption {
  id: string;
  name: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The company cost centres the job has no line for yet — the "Add to this
 * job" part of the picker. A line counts when it is tagged with the cost
 * centre, or (an untagged line) carries its name.
 */
export function addableCostCentres(
  lines: readonly BookingLineOption[],
  company: readonly CompanyCostCentreOption[],
): CompanyCostCentreOption[] {
  const tagged = new Set(lines.map((l) => l.cost_centre_id).filter((id): id is string => !!id));
  const names = new Set(lines.map((l) => norm(l.name)));
  return company.filter((c) => !tagged.has(c.id) && !names.has(norm(c.name)));
}

/**
 * What a new booking's cost centre starts at, so the office only has to
 * check it: the booking above's (the second technician on the same stage),
 * else the job's own scheduled one, else the job's only line. Never a line
 * the job doesn't have. Null = the office must pick.
 */
export function defaultBookingCostCentre(args: {
  previous?: string | null;
  scheduled?: string | null;
  lines: readonly Pick<BookingLineOption, "id">[];
}): string | null {
  const has = (id: string | null | undefined): id is string => !!id && args.lines.some((l) => l.id === id);
  if (has(args.previous)) return args.previous;
  if (has(args.scheduled)) return args.scheduled;
  return args.lines.length === 1 ? args.lines[0].id : null;
}

/** "Pick a cost centre" when a booking has none; null when it's fine. */
export function bookingCostCentreProblem(costCenterId: string | null | undefined): string | null {
  return costCenterId ? null : PICK_COST_CENTRE;
}

/** A picker value: one of the job's lines, or a company cost centre to add. */
export type CostCentreChoice = { kind: "line"; id: string } | { kind: "add"; costCentreId: string };

export function costCentreChoiceValue(choice: CostCentreChoice): string {
  return choice.kind === "line" ? `line:${choice.id}` : `add:${choice.costCentreId}`;
}

export function parseCostCentreChoice(value: string | null | undefined): CostCentreChoice | null {
  if (!value) return null;
  if (value.startsWith("line:") && value.length > 5) return { kind: "line", id: value.slice(5) };
  if (value.startsWith("add:") && value.length > 4) return { kind: "add", costCentreId: value.slice(4) };
  return null;
}

/** "Below Ground Drainage (PO 4321-1)" — never a dollar figure. */
export function lineLabel(line: Pick<BookingLineOption, "name" | "po_number">): string {
  return line.po_number ? `${line.name} (PO ${line.po_number})` : line.name;
}

/** A job's PO as the line planner needs it: lines with their tags, no money. */
export interface PoForBookingLine {
  id: string;
  po_number: string;
  lines: readonly { id: string; name: string; cost_centre_id: string | null; sort_order: number | null }[];
}

/** The new $0 line: the cost centre's name, nothing allocated. */
export interface NewBookingLine {
  cost_centre_id: string;
  name: string;
  allocated_amount: 0;
  allocated_hours: 0;
  sort_order: number;
}

export type BookingLinePlan =
  /** The job already has a line for it — use that one. */
  | { kind: "existing"; lineId: string }
  /** Add a $0 line to the job's first PO. */
  | { kind: "add-line"; poId: string; line: NewBookingLine }
  /** The job has no PO: make `newPoNumber` at $0, then the line. */
  | { kind: "new-po"; poNumber: string; line: NewBookingLine };

/**
 * Where a booking's company cost centre comes from on the job. `pos` in the
 * order they were made (the first is the job's main PO); `newPoNumber` is the
 * number a new PO would get (lib/job-po-number.ts nextJobPoNumber — `<job>-1`
 * on a job with none). A line already tagged with the cost centre is reused,
 * so a retry never adds a second one.
 */
export function planBookingLine(args: {
  pos: readonly PoForBookingLine[];
  centre: CompanyCostCentreOption;
  newPoNumber: string;
}): BookingLinePlan {
  const { pos, centre, newPoNumber } = args;
  for (const po of pos) {
    const tagged = po.lines.find((l) => l.cost_centre_id === centre.id);
    if (tagged) return { kind: "existing", lineId: tagged.id };
  }
  const first = pos[0];
  const line: NewBookingLine = {
    cost_centre_id: centre.id,
    name: centre.name,
    allocated_amount: 0,
    allocated_hours: 0,
    sort_order: first ? first.lines.reduce((m, l) => Math.max(m, (l.sort_order ?? -1) + 1), 0) : 0,
  };
  if (first) return { kind: "add-line", poId: first.id, line };
  return { kind: "new-po", poNumber: newPoNumber, line };
}
