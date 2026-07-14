import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

// Shared building block for the "Card with divide-y rows" shape used by
// pretty much every list page in the app (jobs, invoices, customers, quotes,
// inventory, pricing, ...). Kept separate so DashboardHomeSkeleton can reuse
// it below its stat cards without duplicating the row markup.
function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-6 py-4">
          <div className="space-y-2 flex-1 min-w-0">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full ml-4 flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

// Generic list-page placeholder: title/subtitle + an action button, then a
// card of skeleton rows. Used as a route loading.tsx for server-rendered
// list pages, and reused directly by client-rendered list pages (jobs,
// approvals, staff, fleet, my-jobs) in place of their old plain "Loading..."
// text, so a slow first fetch doesn't just look like a stalled/broken page.
export function ListPageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
      <Card>
        <CardContent className="p-0">
          <SkeletonRows rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}

// Generic detail-page placeholder: back/title header + a couple of info
// cards + a content block. Rough approximation of job/invoice/quote/customer
// detail pages -- doesn't need to be pixel-perfect, just enough shape that
// it reads as "this page is loading" rather than "this page is blank".
export function DetailPageSkeleton() {
  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-16 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// Dashboard home: greeting + 4 stat cards + a "recent items" list, matching
// app/dashboard/page.tsx's actual layout.
export function DashboardHomeSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex items-center gap-4 p-6">
              <Skeleton className="w-12 h-12 rounded-xl flex-shrink-0" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-12" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-0">
          <SkeletonRows rows={5} />
        </CardContent>
      </Card>
    </div>
  );
}

// Form-page placeholder for the client-rendered "edit" pages (invoices,
// quotes, customers, inventory, pricing), which fetch the record to edit in
// a useEffect and previously just showed a bare "Loading..." string while
// that was in flight.
export function FormSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-16 rounded-md" />
        <Skeleton className="h-6 w-40" />
      </div>
      <Card>
        <CardContent className="p-6 space-y-4">
          {Array.from({ length: fields }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
