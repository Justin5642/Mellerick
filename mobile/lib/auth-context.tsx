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
  /**
   * Set when the profile read FAILED, as distinct from "this account has no
   * role". Without it the two are indistinguishable downstream, and
   * app/_layout.tsx renders the fail-closed "No role assigned — contact your
   * administrator" screen for a broken request. That tells a technician
   * something false about their account and sends them to ring the office
   * about permissions instead of retrying.
   */
  profileError: unknown;
  /** Re-attempt the profile read after a failure. */
  reloadProfile: () => void;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<unknown>(null);
  // Mirrors `profile` for use inside the auth listener, which closes over the
  // first render's state and would otherwise always see null.
  const profileRef = useRef<Profile | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(
      ({ data: { session } }) => {
        setSession(session);
        if (session) void loadProfile(session.user.id);
        else setLoading(false);
      },
      (e: unknown) => {
        // getSession() reports most failures in `error`, but it still REJECTS
        // when the stored session can't be read at all (storage or lock fault).
        // Unhandled, that rejection left `loading` raised forever, and
        // app/_layout.tsx holds a full-screen spinner while it is — no text, no
        // button, nothing to retry. Lowering it is what puts something on
        // screen: with no session the router lands on /login, which at least
        // offers an action. Fail closed, never fail silent.
        console.warn("[auth] getSession failed:", e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    );

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
        void loadProfile(session.user.id, { quiet });
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
    try {
      if (!opts.quiet) setLoading(true);

      const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();

      // A failed read must not blank an already-loaded profile. Doing so drops the
      // technician onto the fail-closed "no role" screen because of one bad
      // request, mid-job. Keep what we have and let the next refresh correct it.
      if (error && profileRef.current) {
        console.warn("[auth] profile refresh failed; keeping the loaded profile:", error.message);
      } else if (error) {
        // A failure with NOTHING already loaded. Falling through to
        // setProfile(null) here is what produced "No role assigned" for a read
        // that simply broke.
        setProfileError(error);
      } else {
        setProfileError(null);
        setProfile(data);
        profileRef.current = data;
      }
    } catch (e) {
      // Same rule as the `error` branch, for the case where the read THROWS
      // instead of reporting. What is new is the `finally`: a throw here used to
      // skip the lowering of `loading` entirely, and app/_layout.tsx renders a
      // bare full-screen spinner for as long as that is true — the app simply
      // never started. Coming down puts the sign-in screen or the "No role
      // assigned" screen in front of the user instead; both say something and
      // both have a button.
      console.warn("[auth] profile read threw:", e instanceof Error ? e.message : String(e));
      // The console line is for whoever has a debugger attached; this is for
      // the person holding the phone. Without it the throw reaches the user as
      // "No role assigned", which is a statement about their account rather
      // than about the request that failed.
      if (!profileRef.current) setProfileError(e);
    } finally {
      if (!opts.quiet) setLoading(false);
    }
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        loading,
        profileError,
        reloadProfile: () => {
          // `session` is read from render scope rather than a ref: this closure
          // is rebuilt on every render, so it always sees the current one.
          // loadProfile catches everything and reports through profileError, so
          // voiding it here is honest.
          const id = session?.user?.id;
          if (id) void loadProfile(id);
        },
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
