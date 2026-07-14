import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

// Root 404 -- catches any URL that doesn't match a route at all (typos,
// stale bookmarks, etc), for both signed-out visitors and anything above
// the dashboard layout. app/dashboard/not-found.tsx handles the same thing
// *inside* the dashboard so the sidebar stays visible there; this one is
// the fallback for everywhere else.
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-sm w-full text-center space-y-4">
        <div className="mx-auto flex items-center justify-center w-12 h-12 rounded-full bg-slate-100">
          <SearchX className="w-6 h-6 text-slate-500" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
          <p className="text-sm text-slate-500">The page you're looking for doesn't exist or may have moved.</p>
        </div>
        <Link href="/dashboard">
          <Button>Go to dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
