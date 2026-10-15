"use client";

// NOTE: a route-segment `export const dynamic = "force-dynamic"` used to sit
// here. Next ignores route-segment config exported from a "use client" module,
// so it never had any effect — this page is still prerendered at build time
// (confirmed in the build output, which lists it as Static). It has been
// removed rather than made to work. This page no longer creates a Supabase
// client at all — the reset email is sent by /api/auth/forgot-password — so the
// missing-env build failure now comes only from next.config.ts's
// assertRequiredEnv().

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // Through the server so the link works in any browser or device — see
    // app/api/auth/forgot-password/route.ts for why the browser client can't.
    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setLoading(false);
    if (!res || !res.ok) {
      toast.error(data.error ?? "Couldn't send the reset email — check your connection and try again.");
    } else {
      setSent(true);
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
            <CardTitle className="text-xl">Reset your password</CardTitle>
            <CardDescription>
              {sent
                ? "Check your email for a reset link."
                : "Enter your email and we'll send you a reset link."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  If an account exists for <strong>{email}</strong>, a password reset link is on its
                  way. The link opens a page where you can set a new password.
                </p>
                <Link
                  href="/login"
                  className={buttonVariants({ variant: "outline", className: "w-full" })}
                >
                  Back to sign in
                </Link>
              </div>
            ) : (
              <form onSubmit={handleReset} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Sending..." : "Send reset link"}
                </Button>
                <div className="text-center">
                  <Link href="/login" className="text-sm text-blue-600 hover:underline">
                    Back to sign in
                  </Link>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
