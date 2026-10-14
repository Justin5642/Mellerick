export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Plus, Phone, Mail, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CustomerFavoriteButton } from "@/components/customer-favorite-button";
import { CustomerSearchBox } from "@/components/customer-search-box";
import { customerSearchFilters } from "@/lib/customer-search";

const PAGE_SIZE = 50;
// Only what the rows render. This page used to be a client component that
// paged through EVERY customer (select("*, sites(count)"), 1000 at a time,
// each page a ~100 ms browser→Singapore round trip) and filtered in the
// browser; now the search and paging run in the database, next to it.
const LIST_COLUMNS = "id, name, company, phone, email, is_active, is_favorite";
// Same fields the old client-side filter matched against.
const SEARCH_COLUMNS = ["name", "company", "phone", "mobile", "email"] as const;

function pageHref(q: string, page: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/dashboard/customers?${qs}` : "/dashboard/customers";
}

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const page = Math.max(1, Math.floor(Number(params.page)) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();
  let listQuery = supabase.from("customers").select(LIST_COLUMNS, { count: "exact" });
  for (const filter of customerSearchFilters(q, SEARCH_COLUMNS)) listQuery = listQuery.or(filter);

  const [list, all] = await Promise.all([
    listQuery
      // Favourites first so the handful of repeat customers that matter
      // most day to day don't get lost scrolling a long alphabetical list.
      // id last so paging is stable between customers with the same name.
      .order("is_favorite", { ascending: false })
      .order("name")
      .order("id")
      .range(from, from + PAGE_SIZE - 1),
    // The header's "N of M customers" needs the unfiltered total too; without
    // a search the list's own count already is that total.
    q ? supabase.from("customers").select("id", { count: "exact", head: true }) : null,
  ]);

  const error = list.error ?? all?.error;
  if (error) {
    return <div className="p-6 text-red-500 text-sm">Error: {error.message}</div>;
  }

  const customers = list.data ?? [];
  const matchCount = list.count ?? customers.length;
  const totalCount = all ? (all.count ?? 0) : matchCount;
  const pageCount = Math.max(1, Math.ceil(matchCount / PAGE_SIZE));
  // A stale ?page= (e.g. bookmarked, or the list shrank) would show an empty
  // card; send it to the last page that has rows instead.
  if (page > pageCount) redirect(pageHref(q, pageCount));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="text-slate-500 text-sm mt-1">
            {matchCount} of {totalCount} customers
          </p>
        </div>
        <Link href="/dashboard/customers/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            Add Customer
          </Button>
        </Link>
      </div>

      <CustomerSearchBox initialQuery={q} />

      <Card>
        <CardContent className="p-0">
          {customers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Users className="w-12 h-12 mb-3 opacity-40" />
              {totalCount > 0 && q ? (
                <p className="text-sm font-medium">No customers match &ldquo;{q}&rdquo;</p>
              ) : (
                <>
                  <p className="text-sm font-medium">No customers yet</p>
                  <Link href="/dashboard/customers/new" className="mt-2 text-sm text-blue-600 hover:underline">
                    Add your first customer
                  </Link>
                </>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {customers.map((customer) => (
                <Link prefetch={false}
                  key={customer.id}
                  href={`/dashboard/customers/${customer.id}`}
                  className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <CustomerFavoriteButton customerId={customer.id} initialFavorite={!!customer.is_favorite} />
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-violet-100 text-violet-700 text-xs font-bold flex-shrink-0">
                        {customer.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-sm text-slate-900 group-hover:text-blue-600 transition-colors">
                          {customer.name}
                        </p>
                        {customer.company && (
                          <p className="text-xs text-slate-500">{customer.company}</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 ml-4">
                    {customer.phone && (
                      <span className="hidden sm:flex items-center gap-1 text-xs text-slate-500">
                        <Phone className="w-3 h-3" />
                        {customer.phone}
                      </span>
                    )}
                    {customer.email && (
                      <span className="hidden md:flex items-center gap-1 text-xs text-slate-500">
                        <Mail className="w-3 h-3" />
                        {customer.email}
                      </span>
                    )}
                    <Badge variant={customer.is_active ? "default" : "secondary"} className="text-xs">
                      {customer.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>
            {from + 1}–{from + customers.length} of {matchCount}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link prefetch={false} href={pageHref(q, page - 1)}>
                <Button variant="outline" size="sm" className="gap-1">
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </Button>
              </Link>
            ) : (
              <Button variant="outline" size="sm" className="gap-1" disabled>
                <ChevronLeft className="w-4 h-4" />
                Previous
              </Button>
            )}
            <span>
              Page {page} of {pageCount}
            </span>
            {page < pageCount ? (
              <Link prefetch={false} href={pageHref(q, page + 1)}>
                <Button variant="outline" size="sm" className="gap-1">
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </Link>
            ) : (
              <Button variant="outline" size="sm" className="gap-1" disabled>
                Next
                <ChevronRight className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
