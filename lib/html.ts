// Escapes the five HTML-significant characters so untrusted values (customer
// names, addresses, etc.) can be safely interpolated into outbound email HTML
// without allowing tag/attribute injection.
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
