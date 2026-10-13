import type { ReactNode } from "react";

// Shared shell for the public legal pages (/privacy, /delete-account). Both are
// linked from the Google Play and App Store listings, so they must render for
// anyone, signed in or not — they live outside /dashboard, which is the only
// path the middleware gates.
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <article className="mx-auto max-w-2xl rounded-xl bg-white p-6 shadow-sm sm:p-10 space-y-5 text-slate-700 leading-relaxed [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_a]:text-blue-700 [&_a]:underline">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          <p className="text-sm text-slate-500">Mellerick Field · Last updated {updated}</p>
        </header>
        {children}
      </article>
    </main>
  );
}

export const CONTACT_EMAIL = "admin@mellerick.com";
export const BUSINESS = "Mellerick Pty Ltd";
export const BUSINESS_ADDRESS = "405 Doctors Gully Road, Nutfield VIC 3099, Australia";
