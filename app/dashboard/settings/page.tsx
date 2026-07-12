import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, ExternalLink, CalendarDays, Wrench } from "lucide-react";
import Link from "next/link";
import { GoogleCalendarSyncButton } from "@/components/settings/google-calendar-sync-button";
import { XeroExpenseAccountCode } from "@/components/settings/xero-expense-account-code";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ xero?: string; google?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: xeroToken }, { data: googleToken }] = await Promise.all([
    supabase.from("xero_tokens").select("tenant_name, updated_at, default_expense_account_code").single(),
    supabase.from("google_tokens").select("google_email, updated_at, calendar_last_synced_at").single(),
  ]);

  const isConnected = !!xeroToken;
  const justConnected = params.xero === "connected";
  const hasError = params.xero === "error";

  const isGoogleConnected = !!googleToken;
  const googleJustConnected = params.google === "connected";
  const googleJustDisconnected = params.google === "disconnected";
  const googleHasError = params.google === "error";

  const emailConfigured = !!process.env.RESEND_API_KEY;
  const usingSharedDomain = !process.env.EMAIL_FROM;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-500 text-sm mt-1">Manage integrations and app configuration</p>
      </div>

      {justConnected && (
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          Xero connected successfully — you can now push invoices directly to Xero.
        </div>
      )}

      {hasError && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          Xero connection failed. Please try again.
        </div>
      )}

      {googleJustConnected && (
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          Google Calendar connected — scheduled jobs will now sync automatically.
        </div>
      )}

      {googleJustDisconnected && (
        <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 text-slate-700 rounded-lg px-4 py-3 text-sm">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          Google Calendar disconnected. Jobs will no longer sync.
        </div>
      )}

      {googleHasError && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          Google Calendar connection failed. Please try again.
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Email (Quotes &amp; Invoices)</CardTitle>
              <CardDescription className="mt-1">
                Sends quote/invoice PDFs directly to customers via email
              </CardDescription>
            </div>
            {emailConfigured ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" /> Configured
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
                <XCircle className="w-3.5 h-3.5" /> Not configured
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {emailConfigured ? (
            usingSharedDomain ? (
              <p className="text-sm text-orange-600">
                Using Resend's shared test domain — emails will only deliver to your own Resend account address. Set{" "}
                <code className="bg-slate-100 px-1 rounded">EMAIL_FROM</code> to an address on a verified domain to send to real customers.
              </p>
            ) : (
              <p className="text-sm text-slate-500">Sending live from a verified domain. Ready to email customers.</p>
            )
          ) : (
            <p className="text-sm text-slate-500">
              Add a <code className="bg-slate-100 px-1 rounded">RESEND_API_KEY</code> environment variable in Vercel to enable emailing quotes and invoices.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-blue-600" />
                Google Calendar
              </CardTitle>
              <CardDescription className="mt-1">
                Automatically syncs scheduled jobs to your Google Calendar
              </CardDescription>
            </div>
            {isGoogleConnected ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" /> Connected
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
                <XCircle className="w-3.5 h-3.5" /> Not connected
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isGoogleConnected ? (
            <div className="space-y-2 text-sm text-slate-600">
              <p>Connected as: <span className="font-medium text-slate-900">{googleToken.google_email}</span></p>
              <p className="text-xs text-slate-400">
                {googleToken.calendar_last_synced_at
                  ? `Last pulled changes from Calendar: ${new Date(googleToken.calendar_last_synced_at).toLocaleString("en-AU")}`
                  : "Changes made directly in Google Calendar haven't been pulled in yet."}
              </p>
              <div className="flex gap-3">
                <Link href="/api/google/auth">
                  <Button variant="outline" size="sm" className="gap-2">
                    <ExternalLink className="w-3.5 h-3.5" /> Reconnect
                  </Button>
                </Link>
                <GoogleCalendarSyncButton />
                <form action="/api/google/disconnect" method="POST">
                  <Button variant="outline" size="sm" type="submit" className="text-red-600 hover:text-red-700">
                    Disconnect
                  </Button>
                </form>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                Connect Google Calendar so scheduled jobs automatically appear as events — created, moved, and removed as jobs are scheduled, rescheduled, or completed. Drag or resize an event
                directly in Google Calendar and it'll sync back to the job too (via the periodic sync or the "Sync now" button).
              </p>
              <Link href="/api/google/auth">
                <Button className="gap-2">
                  <ExternalLink className="w-4 h-4" /> Connect Google Calendar
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Wrench className="w-4 h-4 text-blue-600" />
                Variation Types
              </CardTitle>
              <CardDescription className="mt-1">
                Preset rates for standard job variations (rock removal, spoil removal, etc) — controls what crew can
                auto-approve on site vs. what needs office pricing
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Link href="/dashboard/settings/variation-types">
            <Button variant="outline" className="gap-2">
              <ExternalLink className="w-4 h-4" /> Manage Variation Types
            </Button>
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <img src="https://www.xero.com/favicon.ico" alt="Xero" className="w-4 h-4" />
                Xero Accounting
              </CardTitle>
              <CardDescription className="mt-1">
                Push invoices directly to Xero for payment tracking and accounting
              </CardDescription>
            </div>
            {isConnected ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" /> Connected
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
                <XCircle className="w-3.5 h-3.5" /> Not connected
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isConnected ? (
            <div className="space-y-2 text-sm text-slate-600">
              <p>Connected to: <span className="font-medium text-slate-900">{xeroToken.tenant_name}</span></p>
              <div className="flex gap-3">
                <Link href="/api/xero/auth">
                  <Button variant="outline" size="sm" className="gap-2">
                    <ExternalLink className="w-3.5 h-3.5" /> Reconnect Xero
                  </Button>
                </Link>
              </div>
              <XeroExpenseAccountCode initialValue={xeroToken.default_expense_account_code} />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                Connect your Xero account to push invoices with one click. Customers will be automatically created as Xero contacts.
              </p>
              <Link href="/api/xero/auth">
                <Button className="gap-2">
                  <ExternalLink className="w-4 h-4" /> Connect Xero
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
