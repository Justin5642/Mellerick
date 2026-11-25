/**
 * A booking block's colours on the schedule board, by job status — the
 * phone's own (mobile/lib/theme.ts statusColors), as hex so the web board's
 * blocks match the phone's exactly (25 Nov 2026). `text` is also the block's
 * border. Pinned equal by tests/unit/schedule-grid-mirror.test.ts.
 *
 * Its own file, not lib/badge-colors.ts: that module is a set of Tailwind
 * class maps the phone's token parity test reads as strings.
 */
export const scheduleBlockTones: Record<string, { bg: string; text: string }> = {
  pending: { bg: "#fef9c3", text: "#a16207" },
  scheduled: { bg: "#dbeafe", text: "#2563eb" },
  in_progress: { bg: "#f3e8ff", text: "#7e22ce" },
  completed: { bg: "#dcfce7", text: "#16a34a" },
  cancelled: { bg: "#fee2e2", text: "#dc2626" },
  on_hold: { bg: "#f1f5f9", text: "#64748b" },
};
