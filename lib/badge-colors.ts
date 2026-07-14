// Central source of truth for badge/chip colors used across the dashboard.
//
// Previously each page/component defined its own local `Record<string, string>`
// color map (statusColors, priorityColors, roleColors, etc.), which drifted
// slightly out of sync between copies (e.g. job status "on_hold" was
// text-gray-800 in one file and text-gray-700 in every other). Centralizing
// here means a color tweak only needs to happen once, and every screen that
// shows the same status stays visually consistent.
//
// Tailwind classes below are written out in full (no string concatenation)
// so the Tailwind compiler's static class scanner can still find them.

export const jobStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  scheduled: "bg-blue-100 text-blue-800",
  in_progress: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  on_hold: "bg-gray-100 text-gray-700",
};

export const jobPriorityColors: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  normal: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

export const invoiceStatusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-600",
};

export const quoteStatusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-orange-100 text-orange-700",
};

export const staffRoleColors: Record<string, string> = {
  admin: "bg-purple-100 text-purple-700",
  office: "bg-blue-100 text-blue-700",
  technician: "bg-green-100 text-green-700",
};

export const equipmentCategoryColors: Record<string, string> = {
  vehicle: "bg-blue-100 text-blue-700",
  machinery: "bg-orange-100 text-orange-700",
  tool: "bg-slate-100 text-slate-600",
  other: "bg-purple-100 text-purple-700",
};

export const pricingTypeColors: Record<string, string> = {
  flat_rate: "bg-blue-100 text-blue-700",
  hourly: "bg-violet-100 text-violet-700",
  material: "bg-orange-100 text-orange-700",
};

export const photoTagColors: Record<string, string> = {
  before: "bg-orange-100 text-orange-700",
  after: "bg-green-100 text-green-700",
  general: "bg-blue-100 text-blue-700",
  signature: "bg-purple-100 text-purple-700",
};

// Hex equivalents for the same statuses, for Recharts (bars/pies take a
// literal color, not a Tailwind class). Kept in the same file so the two
// palettes get updated together instead of drifting apart.
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
