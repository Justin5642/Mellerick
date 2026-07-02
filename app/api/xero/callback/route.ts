import { NextRequest, NextResponse } from "next/server";
import { getXeroClient } from "@/lib/xero";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const xero = getXeroClient();

  try {
    const tokenSet = await xero.apiCallback(request.url);

    // Fetch tenants directly from connections API — no extra scopes needed
    const connectionsRes = await fetch("https://api.xero.com/connections", {
      headers: {
        Authorization: `Bearer ${tokenSet.access_token}`,
        "Content-Type": "application/json",
      },
    });
    const connections = await connectionsRes.json();
    const tenant = connections[0];

    const supabase = await createClient();
    await supabase.from("xero_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await supabase.from("xero_tokens").insert({
      access_token: tokenSet.access_token!,
      refresh_token: tokenSet.refresh_token!,
      token_expiry: new Date(Date.now() + (tokenSet.expires_in as number) * 1000).toISOString(),
      tenant_id: tenant?.tenantId,
      tenant_name: tenant?.tenantName,
    });

    return NextResponse.redirect(new URL("/dashboard/settings?xero=connected", request.url));
  } catch (err) {
    console.error("Xero callback error:", err);
    return NextResponse.redirect(new URL("/dashboard/settings?xero=error", request.url));
  }
}
