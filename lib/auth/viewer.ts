import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

// The signed-in user and their profile, fetched ONCE per request.
//
// The dashboard layout and the page under it each used to call
// auth.getUser() (a network round trip to Supabase Auth) and then read
// profiles for the role — in sequence, before any page data loaded. React's
// cache() dedupes within a single server render, so the layout and page now
// share one lookup.
//
// getClaims(), not getUser(): the project signs access tokens with an
// asymmetric ES256 key, so getClaims() verifies the JWT signature locally
// against the cached JWKS instead of asking the auth server on every request.
// It is still a real verification — unlike getSession(), a forged or tampered
// cookie fails here. The trade-off: a session revoked server-side stays valid
// until its access token expires (default 1 hour). Every query is still
// authorized by RLS under the same token.
export const getViewer = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  const user = { id: claims.sub, email: claims.email as string | undefined };
  const { data: profile } = await supabase.from("profiles").select("full_name, role").eq("id", user.id).single();
  return { user, profile: profile as { full_name: string | null; role: string | null } | null };
});
