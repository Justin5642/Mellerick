"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Users, Plus, Phone, Mail, Search, X } from "lucide-react";
import Link from "next/link";
import { CustomerFavoriteButton } from "@/components/customer-favorite-button";
import { ListPageSkeleton } from "@/components/ui/loading-skeletons";

export default function CustomersPage() {
  const supabase = createClient();
  const [customers, setCustomers] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function load() {
      // Paginate explicitly — Supabase caps an unranged .select() at 1000
      // rows, which would silently hide older customers (and results of the
      // search box below) once the table grows past that. Same pattern as
      // app/dashboard/jobs/page.tsx.
      const pageSize = 1000;
      let from = 0;
      const all: any[] = [];
      for (;;) {
        const { data, error } = await supabase
          .from("customers")
          .select("*, sites(count)")
          // Favourites first so the handful of repeat customers that matter
          // most day to day don't get lost scrolling a long alphabetical list.
          .order("is_favorite", { ascending: false })
          .order("name")
          .range(from, from + pageSize - 1);
        if (error) {
          setError(error.message);
          return;
        }
        all.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      setCustomers(all);
    }
    load();
  }, []);

  const filteredCustomers = useMemo(() => {
    if (!customers) return customers;
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((customer: any) => {
      const haystack = [customer.name, customer.company, customer.phone, customer.mobile, customer.email]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [customers, search]);

  if (customers === null && !error) {
    return <ListPageSkeleton />;
  }

  if (error) {
    return <div className="p-6 text-red-500 text-sm">Error: {error}</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="text-slate-500 text-sm mt-1">
            {filteredCustomers?.length ?? 0} of {customers?.length ?? 0} customers
          </p>
        </div>
        <Link href="/dashboard/customers/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            Add Customer
          </Button>
        </Link>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customers by name, company, phone, or email..."
          className="pl-8 pr-8"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {!filteredCustomers || filteredCustomers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Users className="w-12 h-12 mb-3 opacity-40" />
              {customers && customers.length > 0 && search ? (
                <p className="text-sm font-medium">No customers match &ldquo;{search}&rdquo;</p>
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
              {filteredCustomers.map((customer: any) => (
                <Link
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
    </div>
  );
}
