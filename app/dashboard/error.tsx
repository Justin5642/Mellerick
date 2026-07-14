"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

// Scoped error boundary for anything under /dashboard. Rendered inside
// dashboard/layout.tsx, so the sidebar stays up and the user can navigate
// away even if the specific page they were on blew up (e.g. a bad Supabase
// query, a job/invoice with unexpected null relations, etc).
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Dashboard error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-4">
        <AlertTriangle className="w-6 h-6 text-red-600" />
      </div>
      <h1 className="text-lg font-semibold text-slate-900 mb-1">Something went wrong</h1>
      <p className="text-sm text-slate-500 mb-4 max-w-sm">
        This page hit an unexpected error. You can try again, or use the sidebar to go somewhere else.
      </p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
