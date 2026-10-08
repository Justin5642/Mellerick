import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

// The signed-in user and their profile, fetched ONCE per request.
//
// The dashboard layout and the page under it each used to call
// auth.getUser() (a network round trip to Supabase Auth) and then read
// profiles for the role — in sequence, before any page data loaded. React's
// cache() dedupes within a single server render, so the layout and page now
// share one lookup. Still getUser(), not getSession(): this revalidates the
// token with the auth server rather than trusting the cookie.
export const getViewer = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("full_name, role").eq("id", user.id).single();
  return { user, profile: profile as { full_name: string | null; role: string | null } | null };
});
