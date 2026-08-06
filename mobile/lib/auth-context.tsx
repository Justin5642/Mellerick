import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
}

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  // Mirrors `profile` for use inside the auth listener, which closes over the
  // first render's state and would otherwise always see null.
  const profileRef = useRef<Profile | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) loadProfile(session.user.id);
      else setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (session) {
        // THE EVENT MATTERS. It used to be discarded, so TOKEN_REFRESHED — which
        // Supabase emits roughly hourly, on its own schedule — was handled
        // identically to a fresh sign-in: loadProfile() raised `loading`, and
        // app/_layout.tsx replaces the ENTIRE <Stack> with a spinner while that
        // is true. Every screen unmounted and remounted mid-shift, losing
        // in-progress form state, and each remount also re-ran the PowerSync
        // connect transition, which is what made the lost-seam bug routine
        // rather than exotic.
        //
        // A token refresh changes the credential, not the person. The profile is
        // already loaded and cannot have changed, so refresh it QUIETLY: no
        // loading state, no unmount. If the read fails, the existing profile is
        // kept rather than blanked — a transient failure must not fail-closed
        // into the "no role" screen mid-job.
        const quiet = event === "TOKEN_REFRESHED" && profileRef.current !== null;
        loadProfile(session.user.id, { quiet });
      } else {
        setProfile(null);
        profileRef.current = null;
        setLoading(false);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function loadProfile(userId: string, opts: { quiet?: boolean } = {}) {
    // Raise loading for the whole fetch so the root layout shows the splash — not
    // the fail-closed "no role" screen — during the post-login profile round-trip
    // (onAuthStateChange(SIGNED_IN) doesn't otherwise re-enter the loading state).
    //
    // QUIET skips that, and is used for a token refresh: the profile is already
    // loaded, the person has not changed, and raising `loading` would unmount
    // every screen mid-shift.
    if (!opts.quiet) setLoading(true);

    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();

    // A failed read must not blank an already-loaded profile. Doing so drops the
    // technician onto the fail-closed "no role" screen because of one bad
    // request, mid-job. Keep what we have and let the next refresh correct it.
    if (error && profileRef.current) {
      console.warn("[auth] profile refresh failed; keeping the loaded profile:", error.message);
    } else {
      setProfile(data);
      profileRef.current = data;
    }

    if (!opts.quiet) setLoading(false);
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
