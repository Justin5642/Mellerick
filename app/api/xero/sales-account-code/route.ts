import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Saves the office-configured Xero account code that invoice line items post
// revenue to (see Settings). Sibling of expense-account-code; kept separate
// from the OAuth callback routes since it's plain business config.
export async function POST(request: NextRequest) {
  const { accountCode } = await request.json();
  const supabase = await createClient();

  const { data: tokenRow } = await supabase.from("xero_tokens").select("id").single();
  if (!tokenRow) return NextResponse.json({ error: "Connect Xero first" }, { status: 400 });

  const { error } = await supabase
    .from("xero_tokens")
    .update({ default_sales_account_code: accountCode || null })
    .eq("id", tokenRow.id);

  if (error) return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  return NextResponse.json({ success: true });
}
