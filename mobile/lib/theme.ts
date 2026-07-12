// Mirrors the Tailwind palette used across the Mellerick web app for visual consistency.
export const colors = {
  bg: "#f8fafc",
  card: "#ffffff",
  border: "#e2e8f0",
  slate900: "#0f172a",
  slate700: "#334155",
  slate500: "#64748b",
  slate400: "#94a3b8",
  slate100: "#f1f5f9",
  blue600: "#2563eb",
  blue500: "#3b82f6",
  blue100: "#dbeafe",
  green600: "#16a34a",
  green100: "#dcfce7",
  red600: "#dc2626",
  red100: "#fee2e2",
  yellow700: "#a16207",
  yellow100: "#fef9c3",
  purple700: "#7e22ce",
  purple100: "#f3e8ff",
  orange700: "#c2410c",
  orange100: "#ffedd5",
  white: "#ffffff",
  black: "#000000",
};

export const photoTagColors: Record<string, { bg: string; text: string }> = {
  before: { bg: colors.orange100, text: colors.orange700 },
  after: { bg: colors.green100, text: colors.green600 },
  general: { bg: colors.blue100, text: colors.blue600 },
  signature: { bg: colors.purple100, text: colors.purple700 },
};

export const statusColors: Record<string, { bg: string; text: string }> = {
  pending: { bg: colors.yellow100, text: colors.yellow700 },
  scheduled: { bg: colors.blue100, text: colors.blue600 },
  in_progress: { bg: colors.purple100, text: colors.purple700 },
  completed: { bg: colors.green100, text: colors.green600 },
  cancelled: { bg: colors.red100, text: colors.red600 },
  on_hold: { bg: colors.slate100, text: colors.slate500 },
};
