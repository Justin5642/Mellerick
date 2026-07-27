// Status / badge color system — the mobile port of the web's single source of
// truth (lib/badge-colors.ts). Each value maps to NativeWind className strings
// (which are the same Tailwind classes the web uses), with an added dark-mode
// variant designed for mobile: translucent tint + light text so pills don't glow
// on the dark surfaces. A build-time parity test (status.parity.test.ts) asserts
// this module covers every domain+value key the web defines, failing on drift.
//
// The `chart` maps are literal hex for the native (Skia) charts, mirroring the
// web Recharts hex so the two render identically.

export type BadgeClassName = string;

// Shared dark-pill recipe: -400/15 translucent bg + -300 text.
const pill = (light: string, darkHue: string): BadgeClassName =>
  `${light} dark:bg-${darkHue}-400/15 dark:text-${darkHue}-300`;

export const jobStatusColors: Record<string, BadgeClassName> = {
  pending: pill("bg-yellow-100 text-yellow-800", "yellow"),
  scheduled: pill("bg-blue-100 text-blue-800", "blue"),
  in_progress: pill("bg-purple-100 text-purple-800", "purple"),
  completed: pill("bg-green-100 text-green-800", "green"),
  cancelled: pill("bg-red-100 text-red-800", "red"),
  on_hold: pill("bg-gray-100 text-gray-700", "gray"),
};

export const jobPriorityColors: Record<string, BadgeClassName> = {
  low: pill("bg-gray-100 text-gray-600", "gray"),
  normal: pill("bg-blue-100 text-blue-700", "blue"),
  high: pill("bg-orange-100 text-orange-700", "orange"),
  urgent: pill("bg-red-100 text-red-700", "red"),
};

export const invoiceStatusColors: Record<string, BadgeClassName> = {
  draft: pill("bg-gray-100 text-gray-700", "gray"),
  sent: pill("bg-blue-100 text-blue-700", "blue"),
  paid: pill("bg-green-100 text-green-700", "green"),
  overdue: pill("bg-red-100 text-red-700", "red"),
  cancelled: pill("bg-slate-100 text-slate-600", "slate"),
};

export const quoteStatusColors: Record<string, BadgeClassName> = {
  draft: pill("bg-gray-100 text-gray-700", "gray"),
  sent: pill("bg-blue-100 text-blue-700", "blue"),
  accepted: pill("bg-green-100 text-green-700", "green"),
  declined: pill("bg-red-100 text-red-700", "red"),
  expired: pill("bg-orange-100 text-orange-700", "orange"),
};

export const staffRoleColors: Record<string, BadgeClassName> = {
  admin: pill("bg-purple-100 text-purple-700", "purple"),
  office: pill("bg-blue-100 text-blue-700", "blue"),
  technician: pill("bg-green-100 text-green-700", "green"),
};

export const equipmentCategoryColors: Record<string, BadgeClassName> = {
  vehicle: pill("bg-blue-100 text-blue-700", "blue"),
  machinery: pill("bg-orange-100 text-orange-700", "orange"),
  tool: pill("bg-slate-100 text-slate-600", "slate"),
  other: pill("bg-purple-100 text-purple-700", "purple"),
};

export const pricingTypeColors: Record<string, BadgeClassName> = {
  flat_rate: pill("bg-blue-100 text-blue-700", "blue"),
  hourly: pill("bg-violet-100 text-violet-700", "violet"),
  material: pill("bg-orange-100 text-orange-700", "orange"),
};

export const photoTagColors: Record<string, BadgeClassName> = {
  before: pill("bg-orange-100 text-orange-700", "orange"),
  after: pill("bg-green-100 text-green-700", "green"),
  general: pill("bg-blue-100 text-blue-700", "blue"),
  signature: pill("bg-purple-100 text-purple-700", "purple"),
};

// Backflow due-status (mobile-only domain; mirrors mobile/lib/backflow.ts DUE_STATUS_COLORS).
export const backflowDueColors: Record<string, BadgeClassName> = {
  overdue: pill("bg-red-100 text-red-700", "red"),
  due_soon: pill("bg-amber-100 text-amber-700", "amber"),
  ok: pill("bg-green-100 text-green-700", "green"),
  no_test: pill("bg-slate-100 text-slate-600", "slate"),
};

// Literal hex for native charts (mirrors the web Recharts hex maps).
export const jobStatusChartColors: Record<string, string> = {
  pending: "#eab308",
  scheduled: "#3b82f6",
  in_progress: "#8b5cf6",
  completed: "#22c55e",
  cancelled: "#ef4444",
  on_hold: "#94a3b8",
};

export const quoteStatusChartColors: Record<string, string> = {
  draft: "#94a3b8",
  sent: "#3b82f6",
  accepted: "#22c55e",
  declined: "#ef4444",
  expired: "#f97316",
};

// Domain registry — used by <StatusPill domain=… value=…/> and the parity guard.
export const statusDomains = {
  jobStatus: jobStatusColors,
  jobPriority: jobPriorityColors,
  invoiceStatus: invoiceStatusColors,
  quoteStatus: quoteStatusColors,
  staffRole: staffRoleColors,
  equipmentCategory: equipmentCategoryColors,
  pricingType: pricingTypeColors,
  photoTag: photoTagColors,
  backflowDue: backflowDueColors,
} as const;

export type StatusDomain = keyof typeof statusDomains;

export function getStatusClassName(domain: StatusDomain, value: string): BadgeClassName {
  return statusDomains[domain][value] ?? "bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300";
}
