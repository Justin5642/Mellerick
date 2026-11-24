// A customer's billing address: a copy of the web rules (lib/customer-address.ts),
// byte for byte below this header, pinned by tests/unit/customer-address.test.ts.
// Change the web file first, then copy its body here.

/** The longest address the database accepts (0114's check, once that drafted migration is applied). */
export const BILLING_ADDRESS_MAX = 500;

/**
 * The address as typed, tidied for saving: each line trimmed, blank lines at
 * the ends dropped, runs of blank lines inside collapsed to one. Empty → null.
 * Too long → an error sentence instead.
 */
export function normaliseBillingAddress(input: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const lines = (input ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const value = kept.join("\n");
  if (value.length > BILLING_ADDRESS_MAX) {
    return { ok: false, error: `The billing address is too long (at most ${BILLING_ADDRESS_MAX} characters).` };
  }
  return { ok: true, value: value === "" ? null : value };
}

/** The address as printed: one entry per non-blank line. Blank → none. */
export function billingAddressLines(address: string | null | undefined): string[] {
  return (address ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** True when a read or write failed only because the billing_address column is missing. */
export function isMissingBillingAddressColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  return /\bbilling_address\b/.test(error.message ?? "");
}
