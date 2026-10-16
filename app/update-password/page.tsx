"use client";

// NOTE: a route-segment `export const dynamic = "force-dynamic"` used to sit
// here. Next ignores route-segment config exported from a "use client" module,
// so it never had any effect — this page is still prerendered at build time
// (confirmed in the build output, which lists it as Static). It has been removed
// rather than made to work: because createClient() runs during that prerender,
// the build fails loudly when NEXT_PUBLIC_SUPABASE_* is missing, and that is
// worth keeping. Those values are inlined into the client bundle at build time,
// so a build that succeeded without them would ship a broken sign-in page.

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// What the emailed link carried, read once before the Supabase client can touch
// the URL. Three shapes reach this page:
//
//   #access_token=…&refresh_token=…&type=invite|recovery
//       "implicit" links: every staff INVITE (admin-generated links are always
//       implicit), the mobile app's "Forgot password?", and /forgot-password
//       (which now requests through /api/auth/forgot-password for exactly this
//       reason). The browser client here is PKCE-only and REJECTS these
//       ("Not a valid PKCE flow url"), so they are applied by hand.
//   ?token_hash=…&type=…
//       Supabase's token-hash email templates, if the dashboard is ever
//       switched to them — verified here with verifyOtp.
//   ?code=…
//       a PKCE link opened in the same browser that asked for it — the client
//       exchanges it itself; the poll below picks the session up.
//
// Before 16 Oct 2026 only the last worked, and it only works in the SAME
// browser that requested it. Invites and phone resets therefore always showed
// "invalid or expired" → "Request a new link" → the same failure: the loop new
// technicians reported.
function readLinkParams() {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  return {
    accessToken: hash.get("access_token"),
    refreshToken: hash.get("refresh_token"),
    tokenHash: query.get("token_hash"),
    type: hash.get("type") ?? query.get("type"),
    errorDescription: hash.get("error_description") ?? query.get("error_description"),
  };
}

export default function UpdatePasswordPage() {
  // Read in the effect, not during render: this page is prerendered, so
  // reading window.location while rendering made the first client render
  // differ from the static HTML (React hydration error #418).
  const [isInvite, setIsInvite] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    // Supabase fires PASSWORD_RECOVERY when the recovery link is opened and
    // the session is established from the URL. We also check for an existing
    // session in case it was already exchanged.
    let cancelled = false;
    const link = readLinkParams();
    setIsInvite(link?.type === "invite");

    // A link Supabase already refused (expired, or used up — e.g. by an email
    // scanner opening it first) arrives as an error, not tokens.
    if (link?.errorDescription && !link.accessToken) {
      setLinkError(link.errorDescription.replace(/\+/g, " "));
      setInvalid(true);
      return;
    }

    // Implicit or token-hash link: establish the session ourselves, then strip
    // the tokens from the address bar so they aren't left in history.
    const manual = link?.accessToken && link.refreshToken
      ? supabase.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken })
      : link?.tokenHash && link.type
        ? supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type as "invite" | "recovery" | "magiclink" | "email" })
        : null;
    if (manual) {
      window.history.replaceState(null, "", window.location.pathname);
      manual
        .then(({ data, error }) => {
          if (cancelled) return;
          cancelled = true;
          if (error || !data.session) {
            setLinkError(error?.message ?? null);
            setInvalid(true);
          } else {
            setReady(true);
          }
        })
        // A mangled token makes setSession THROW (it decodes the JWT) rather
        // than return an error — without this the page sat on "Verifying link…".
        .catch(() => {
          if (cancelled) return;
          cancelled = true;
          setInvalid(true);
        });
      return () => {
        cancelled = true;
      };
    }

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        cancelled = true;
        setReady(true);
      }
    });

    // Establishing a session from the URL's access_token/refresh_token is
    // async and NOT instant -- a single fixed ~1.5s wait was reported to mark
    // a perfectly valid, freshly-clicked recovery link as "invalid or
    // expired" on weak mobile signal, because the exchange simply hadn't
    // finished yet. Poll instead of one fixed-length wait: up to 10 tries,
    // 700ms apart (~7s total), stopping the moment a session shows up (via
    // this poll or the event listener above, whichever wins) rather than
    // racing a single arbitrary timeout against real network conditions.
    let attempts = 0;
    const maxAttempts = 10;
    const intervalMs = 700;

    const poll = () => {
      if (cancelled) return;
      supabase.auth.getSession().then(({ data }) => {
        if (cancelled) return;
        if (data.session) {
          cancelled = true;
          setReady(true);
          return;
        }
        attempts += 1;
        if (attempts >= maxAttempts) {
          setInvalid(true);
        } else {
          setTimeout(poll, intervalMs);
        }
      });
    };
    poll();

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setLoading(false);
      toast.error(error.message);
    } else {
      // Proving control of the inbox is the point of a reset, so it also ends
      // any lockout from the failed attempts that usually precede one —
      // otherwise the new password was refused for up to 10 more minutes
      // (the "timeout" people hit when logging back in). Best effort.
      await fetch("/api/auth/clear-lockout", { method: "POST" }).catch(() => {});
      setLoading(false);
      toast.success(
        isInvite
          ? "Password set. You can now sign in to the Mellerick Field app."
          : "Password updated. You can now sign in, including on the Mellerick Field app."
      );
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-2xl bg-white px-6 py-4 shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Mellerick Plumbing and Drainage" className="h-20 w-auto" />
          </div>
        </div>

        <Card className="shadow-2xl border-0">
          <CardHeader className="space-y-1">
            <CardTitle className="text-xl">{isInvite ? "Welcome — set your password" : "Set a new password"}</CardTitle>
            <CardDescription>
              {isInvite
                ? "Choose a password for your Mellerick account. You'll use it to sign in on the app and the website."
                : "Choose a new password for your account."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invalid ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  This link is invalid or has expired{linkError ? ` (${linkError})` : ""}. Links work once —
                  request a new one below and open the newest email.
                </p>
                <Link
                  href="/forgot-password"
                  className={buttonVariants({ variant: "outline", className: "w-full" })}
                >
                  Request a new link
                </Link>
              </div>
            ) : (
              <form onSubmit={handleUpdate} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    disabled={!ready}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    placeholder="••••••••"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                    disabled={!ready}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading || !ready}>
                  {!ready ? "Verifying link..." : loading ? "Updating..." : "Update password"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
