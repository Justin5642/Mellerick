import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingBillingAddressColumn } from "@/lib/customer-address";

/**
 * A customer's billing address for an invoice or quote (PDF, email, detail
 * page), read as the caller. Its own small query rather than a column in the
 * documents' big select, so a database without migration 0114 (drafted, not
 * applied until its header says so) only loses the address: a missing column
 * — or any other failure — answers null and the document prints without one.
 */
export async function loadBillingAddress(
  supabase: SupabaseClient,
  customerId: string | null | undefined
): Promise<string | null> {
  if (!customerId) return null;
  try {
    const { data, error } = await supabase.from("customers").select("billing_address").eq("id", customerId).maybeSingle();
    if (error) {
      if (!isMissingBillingAddressColumn(error)) console.error("billing address read failed:", error);
      return null;
    }
    const value = (data as { billing_address?: unknown } | null)?.billing_address;
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch (err) {
    console.error("billing address read failed:", err);
    return null;
  }
}
