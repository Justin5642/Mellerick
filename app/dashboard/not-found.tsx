import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

// Scoped 404 for anything under /dashboard (e.g. an invoice/job/customer id
// that doesn't exist -- several detail pages already call notFound() for
// this). Having our own copy here, rather than falling through to the root
// app/not-found.tsx, keeps the sidebar (rendered by dashboard/layout.tsx)
// visible so the user can navigate elsewhere instead of landing on a page
// with no nav at all.
export default function DashboardNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 mb-4">
        <SearchX className="w-6 h-6 text-slate-500" />
      </div>
      <h1 className="text-lg font-semibold text-slate-900 mb-1">Not found</h1>
      <p className="text-sm text-slate-500 mb-4 max-w-sm">
        This item doesn't exist, or may have been deleted.
      </p>
      <Link href="/dashboard">
        <Button variant="outline">Back to dashboard</Button>
      </Link>
    </div>
  );
}
