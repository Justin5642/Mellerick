// Mobile-side mirror of ../../lib/backflow.ts (the web app's shared
// constants + due-date logic). Kept in sync by hand since the mobile app
// and the web app are separate bundles with no shared package — if you
// change one, change the other.

export interface WaterAuthority {
  value: "yarra_valley_water" | "south_east_water" | "greater_western_water";
  label: string;
  email: string;
}

export const WATER_AUTHORITIES: WaterAuthority[] = [
  { value: "yarra_valley_water", label: "Yarra Valley Water", email: "backflow@yvw.com.au" },
  { value: "south_east_water", label: "South East Water", email: "backflow@sew.com.au" },
  { value: "greater_western_water", label: "Greater Western Water", email: "backflow@gww.com.au" },
];

export function getWaterAuthorityLabel(value: string): string {
  return WATER_AUTHORITIES.find((w) => w.value === value)?.label ?? value;
}

export interface DeviceType {
  value: string;
  label: string;
  code: string;
}

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

const DUE_SOON_WINDOW_DAYS = 30;

export function computeNextDueDate(lastPassDate: string | null | undefined, testFrequencyMonths: number): Date | null {
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

export const DUE_STATUS_COLORS: Record<DueStatus, { bg: string; text: string }> = {
  overdue: { bg: "#fee2e2", text: "#dc2626" },
  due_soon: { bg: "#fef9c3", text: "#a16207" },
  ok: { bg: "#dcfce7", text: "#16a34a" },
  no_test: { bg: "#f1f5f9", text: "#64748b" },
};
