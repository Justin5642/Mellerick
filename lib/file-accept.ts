/**
 * Does a file match an HTML `accept` string (e.g. ".pdf,.png" or "application/pdf,image/*")?
 *
 * The browser enforces `accept` for the file picker but NOT for drag-and-drop, so
 * drop zones have to check it themselves. An empty/undefined `accept` allows anything.
 */
export function fileMatchesAccept(file: { name: string; type: string }, accept?: string): boolean {
  if (!accept || !accept.trim()) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith(".")) return name.endsWith(rule);
      if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
      return type === rule;
    });
}
