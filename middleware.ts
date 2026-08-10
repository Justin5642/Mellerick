import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { mayOpen } from "@/lib/nav-items";

// This file does two jobs the app was missing, and they belong together because
// both need something only middleware has: the request itself.
//
// 1. IT PERSISTS REFRESHED SESSION COOKIES.
//    lib/supabase/server.ts:18-21 wraps its cookie `setAll` in a bare
//    `catch {}` — correct, because a Server Component is not allowed to write
//    cookies — and that is safe ONLY if something else persists the refreshed
//    session. The @supabase/ssr contract expects a middleware to do it. Nothing
//    did. So when an access token expired mid-session the refresh was computed,
//    discarded by that catch, and recomputed on every subsequent request.
//
// 2. IT REFUSES OFFICE ROUTES TO TECHNICIANS.
//    components/app-sidebar.tsx filters the sidebar by role, but hiding a link
//    only changes what is CLICKABLE. A typed or bookmarked /dashboard/staff
//    still rendered the full roster with colleague emails and phone numbers. A
//    layout cannot do this — it never sees the pathname — which is why the
//    gating lives here and imports the SAME list the sidebar renders, so the
//    two cannot drift apart.
//
// THIS IS NOT THE MONEY BOUNDARY. RLS is, and stays: migrations
// 0027/0028/0034/0035/0038/0042/0045 already refuse a technician every
// financial row, so /dashboard/invoices renders empty and /dashboard/reports
// renders zeros with this file deleted. What this closes is confidentiality on
// the tables still carrying the wide-open baseline policy — the staff roster,
// the customer book, and every job and schedule. Do not let a future change
// move a dollar decision into this file.

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Written to BOTH the request (so this same pass sees the refreshed
          // session) and the response (so the browser keeps it). Setting only
          // one is the documented way to get a session that appears to work and
          // then silently expires.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // getUser(), not getSession(): this revalidates against the auth server and is
  // what actually triggers the refresh whose cookies we persist above.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (user && path.startsWith("/dashboard")) {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();

    if (profile?.role === "technician") {
      if (!mayOpen("technician", path)) {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard/my-jobs";
        return NextResponse.redirect(url);
      }
    }
  }

  return response;
}

export const config = {
  // Everything except static assets and image optimisation. API routes are
  // deliberately INCLUDED for the cookie refresh, but the role gate above only
  // looks at /dashboard — every API handler already authorizes itself, and
  // duplicating that here would create a second place for the two to disagree.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
