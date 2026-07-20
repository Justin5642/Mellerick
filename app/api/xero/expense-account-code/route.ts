import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";

// Saves the office-configured Xero account code that job expense Bills get
// coded to (see Settings). Kept separate from the OAuth callback routes
// since it's plain business config, not a token exchange.
export async function POST(request: NextRequest) {
  // Xero billing config is office/admin-only — technicians must not read or
  // rewrite it (previously this route had no auth check at all).
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const { accountCode } = await request.json();
  const supabase = await createClient();

  const { data: tokenRow } = await supabase.from("xero_tokens").select("id").single();
  if (!tokenRow) return NextResponse.json({ error: "Connect Xero first" }, { status: 400 });

  const { error } = await supabase
    .from("xero_tokens")
    .update({ default_expense_account_code: accountCode || null })
    .eq("id", tokenRow.id);

  if (error) return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  return NextResponse.json({ success: true });
}
