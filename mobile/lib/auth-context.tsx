import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import {
  clearCachedProfile,
  decideProfileResult,
  readCachedProfile,
  writeCachedProfile,
  type CachedProfile,
} from "./profileCache";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

type Profile = CachedProfile;

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
  // The user whose profile we are currently resolving. A read that comes back
  // for anyone else (a sign-out and a different sign-in raced it) is dropped,
  // so one user's profile can never be shown — or cached — under another's
  // session.
  const activeUserRef = useRef<string | null>(null);

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
        const previous = activeUserRef.current;
        activeUserRef.current = null;
        setProfile(null);
        profileRef.current = null;
        setProfileError(null);
        setLoading(false);
        // Signed out: the cached profile must not outlive the session. Cleared
        // for the user who just left (or every cached profile, if we never
        // learned who that was). Only on a real SIGNED_OUT — a null
        // INITIAL_SESSION is "no session yet", not a reason to forget anyone,
        // and the cache is keyed per user so it can never answer for another.
        if (event === "SIGNED_OUT") void clearCachedProfile(previous ?? undefined);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function loadProfile(userId: string, opts: { quiet?: boolean } = {}) {
    // A different user from the one on screen: drop the old profile first, so
    // nothing about the previous person survives into this session.
    if (profileRef.current && profileRef.current.id !== userId) {
      profileRef.current = null;
      setProfile(null);
    }
    activeUserRef.current = userId;
    let quiet = opts.quiet === true || profileRef.current?.id === userId;

    // OPTIMISTIC START FROM THE DEVICE CACHE. Before this, a cold start held
    // the full-screen spinner until a NETWORK read of `profiles` returned — and
    // offline, with nothing loaded, that read failed into the profile-error
    // screen instead of the technician's jobs. A profile cached for THIS user
    // (lib/profileCache: keyed and checked by id) paints the right role's
    // screens immediately; the server read below then revalidates it, and the
    // server's answer always wins once it arrives.
    if (!quiet) {
      const cached = await readCachedProfile(userId);
      if (cached && activeUserRef.current === userId && !profileRef.current) {
        profileRef.current = cached;
        setProfile(cached);
        setProfileError(null);
        setLoading(false);
        quiet = true;
      }
    }

    // Raise loading for the whole fetch so the root layout shows the splash — not
    // the fail-closed "no role" screen — during the post-login profile round-trip
    // (onAuthStateChange(SIGNED_IN) doesn't otherwise re-enter the loading state).
    //
    // QUIET skips that, and is used for a token refresh and for a revalidation
    // behind a cached profile: the person has not changed, and raising
    // `loading` would unmount every screen mid-shift.
    try {
      if (!quiet) setLoading(true);

      const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
      if (activeUserRef.current !== userId) return; // superseded by a sign-out / other user

      // decideProfileResult (lib/profileCache) is the whole policy, pure and
      // unit-tested:
      //  • the server answered → apply it and cache it. A changed role or
      //    is_active=false REPLACES the cached one at once; app/_layout.tsx
      //    re-gates the routes and PowerSyncProvider wipes a mirror synced for
      //    the old role.
      //  • the server said "no such profile" (PGRST116) → clear, fail closed.
      //  • a transient failure with a profile already shown → keep it. Blanking
      //    it would drop a technician onto the "no role" screen mid-job for one
      //    bad request.
      //  • a failure with NOTHING shown → profileError. Falling through to
      //    setProfile(null) is what used to produce "No role assigned" for a
      //    read that simply broke.
      const decision = decideProfileResult({ shown: profileRef.current, data, error });
      switch (decision.kind) {
        case "apply":
          setProfileError(null);
          setProfile(decision.profile);
          profileRef.current = decision.profile;
          void writeCachedProfile(decision.profile);
          break;
        case "clear":
          setProfileError(null);
          setProfile(null);
          profileRef.current = null;
          void clearCachedProfile(userId);
          break;
        case "keep":
          console.warn(
            "[auth] profile refresh failed; keeping the loaded profile:",
            (error as { message?: string } | null)?.message ?? String(error)
          );
          break;
        case "error":
          setProfileError(decision.error);
          break;
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
      if (!profileRef.current && activeUserRef.current === userId) setProfileError(e);
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  async function signIn(email: string, password: string) {
    // Routed through the web app's /api/auth/login when configured, so the
    // 6-attempts/10-minute lockout policy (migration 0056) applies here too
    // -- mobile and web share the one enforcement point rather than each
    // needing its own copy of the policy. Falls back to signing in directly
    // when EXPO_PUBLIC_API_BASE_URL isn't set, same "degrade gracefully when
    // the web API isn't configured" rule as the other API_BASE_URL call
    // sites in this app -- a build without it should still let staff sign in,
    // just without the app-level lockout.
    if (!API_BASE_URL) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message ?? null };
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { error: data.error ?? "Sign in failed" };
      }
      const { access_token, refresh_token } = data.session ?? {};
      if (!access_token || !refresh_token) {
        return { error: "Sign in failed" };
      }
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      return { error: error?.message ?? null };
    } catch {
      // Network failure talking to the web API -- fall back to signing in
      // directly rather than stranding a technician who can't reach the
      // office server but does have signal to Supabase itself.
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message ?? null };
    }
  }

  async function signOut() {
    // Cleared here as well as in the SIGNED_OUT handler: a sign-out that fails
    // half-way (offline revoke) must still not leave this person's role on the
    // device for whoever opens the app next.
    await clearCachedProfile(activeUserRef.current ?? undefined);
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
