// Shared constants + due-date logic for the backflow prevention device
// tracking feature. Kept in one place so the dashboard pages, the mobile
// app, and the submit-to-water-authority API route all agree on the same
// labels, codes, and "when is this due" math.

export interface WaterAuthority {
  value: "yarra_valley_water" | "south_east_water" | "greater_western_water";
  label: string;
  email: string;
}

// Submission addresses confirmed directly by Justin (2026-07):
// - Yarra Valley Water and South East Water: no separate form of their own,
//   Justin confirmed YVW's form (the one with the device codes below) is
//   accepted by all three, just addressed/emailed differently.
// - Greater Western Water: does have its own form (GWW0030), but accepts
//   the same underlying information — this app generates one PDF layout
//   and routes it to whichever address matches the selected authority.
export const WATER_AUTHORITIES: WaterAuthority[] = [
  { value: "yarra_valley_water", label: "Yarra Valley Water", email: "backflow@yvw.com.au" },
  { value: "south_east_water", label: "South East Water", email: "backflow@sew.com.au" },
  { value: "greater_western_water", label: "Greater Western Water", email: "backflow@gww.com.au" },
];

export function getWaterAuthorityEmail(value: string): string | null {
  return WATER_AUTHORITIES.find((w) => w.value === value)?.email ?? null;
}

export function getWaterAuthorityLabel(value: string): string {
  return WATER_AUTHORITIES.find((w) => w.value === value)?.label ?? value;
}

export interface DeviceType {
  value: string;
  label: string;
  code: string;
}

// Codes match the letters used on the source compliance form (RPZD(E),
// DCV(F), etc.) so the generated PDF/report reads the same way testers are
// used to seeing on the paper form.
export const DEVICE_TYPES: DeviceType[] = [
  { value: "rpzd", label: "Reduced Pressure Zone Device (RPZD)", code: "E" },
  { value: "dcv", label: "Double Check Valve (DCV)", code: "F" },
  { value: "scvt", label: "Single Check Valve Testable (SCVT)", code: "I" },
  { value: "rpda", label: "Reduced Pressure Detector Assembly (RPDA)", code: "G" },
  { value: "dcda", label: "Double Check Detector Assembly (DCDA)", code: "H" },
  { value: "scdat", label: "Single Check Detector Assembly Testable (SCDAT)", code: "J" },
  { value: "pvb", label: "Pressure Vacuum Breaker (PVB)", code: "C" },
  { value: "spvb", label: "Spill-Resistant Pressure Vacuum Breaker (SPVB)", code: "D" },
  { value: "avb", label: "Atmospheric Vacuum Breaker (AVB)", code: "K" },
];

export function getDeviceTypeLabel(value: string): string {
  return DEVICE_TYPES.find((d) => d.value === value)?.label ?? value;
}

export const PROTECTION_TYPES = [
  { value: "containment", label: "Containment protection" },
  { value: "zone", label: "Zone protection" },
  { value: "individual", label: "Individual protection" },
];

export const TEST_TYPES = [
  { value: "commissioning", label: "Commissioning of new device" },
  { value: "replacement", label: "Replacement" },
  { value: "annual", label: "Annual test" },
  { value: "repairs", label: "Repairs" },
  { value: "decommission", label: "Decommission" },
];

export const FAILURE_REASONS = [
  "Improper location",
  "Improper assembly",
  "Abnormal seat wear/damage",
  "Sticking/seizing parts",
  "Spring wear/damage",
  "Blocked/kinked sensing line",
  "Sand/grit/foreign material",
  "Other",
];

export type DueStatus = "overdue" | "due_soon" | "ok" | "no_test";

export interface DueInfo {
  status: DueStatus;
  nextDueDate: Date | null;
}

const DUE_SOON_WINDOW_DAYS = 30;

// Next due date is the most recent PASSING test's date, plus the device's
// test frequency (normally 12 months for annual Australian backflow
// testing). A failed test doesn't push the due date out — the device still
// needs a passing re-test, so it stays overdue/due-soon until one lands.
export function computeNextDueDate(
  lastPassDate: string | null | undefined,
  testFrequencyMonths: number
): Date | null {
  if (!lastPassDate) return null;
  const base = new Date(lastPassDate);
  if (Number.isNaN(base.getTime())) return null;
  const wholeMonths = Math.trunc(testFrequencyMonths);
  const dueDate = new Date(base);
  dueDate.setMonth(dueDate.getMonth() + wholeMonths);
  const fractionalDays = (testFrequencyMonths - wholeMonths) * 30;
  if (fractionalDays) dueDate.setDate(dueDate.getDate() + Math.round(fractionalDays));
  return dueDate;
}

export function getDueStatus(nextDueDate: Date | null): DueStatus {
  if (!nextDueDate) return "no_test";
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilDue = Math.floor((nextDueDate.getTime() - now.getTime()) / msPerDay);
  if (daysUntilDue < 0) return "overdue";
  if (daysUntilDue <= DUE_SOON_WINDOW_DAYS) return "due_soon";
  return "ok";
}

export const DUE_STATUS_LABELS: Record<DueStatus, string> = {
  overdue: "Overdue",
  due_soon: "Due soon",
  ok: "Up to date",
  no_test: "No test on record",
};
