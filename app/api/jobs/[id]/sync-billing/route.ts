import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { syncJobBilling } from "@/lib/labour-billing-sync";

// Job-level reconcile of the auto-generated billing items (Labour per work
// entry + one Call Out Fee) -- see lib/labour-billing-sync.ts. Used to
// self-heal a job whose per-entry sync was dropped (e.g. viewing Line Items,
// or opening the invoice builder for the job) so what you bill from is always
// current. Same auth-then-service-role pattern as the per-entry route.
function getAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getAuthenticatedUserId(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (token) {
    const anonClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anonClient.auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  }
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;

  const callerId = await getAuthenticatedUserId(request);
  if (!callerId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = getAdminClient();
  const summary = await syncJobBilling(admin, jobId);
  return NextResponse.json({ ok: true, ...summary });
}
