import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.from("google_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  return NextResponse.redirect(new URL("/dashboard/settings?google=disconnected", request.url));
}
