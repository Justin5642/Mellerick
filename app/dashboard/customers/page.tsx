export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Plus, Phone, Mail } from "lucide-react";
import Link from "next/link";
import { CustomerFavoriteButton } from "@/components/customer-favorite-button";

export default async function CustomersPage() {
  const supabase = await createClient();
  const { data: customers } = await supabase
    .from("customers")
    .select("*, sites(count)")
    // Favourites first so the handful of repeat customers that matter most
    // day to day don't get lost scrolling a long alphabetical list.
    .order("is_favorite", { ascending: false })
    .order("name");

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="text-slate-500 text-sm mt-1">{customers?.length ?? 0} total customers</p>
        </div>
        <Link href="/dashboard/customers/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            Add Customer
          </Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          {!customers || customers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Users className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">No customers yet</p>
              <Link href="/dashboard/customers/new" className="mt-2 text-sm text-blue-600 hover:underline">
                Add your first customer
              </Link>
            </div>
          ) : (
            <div className="divide-y">
              {customers.map((customer: any) => (
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
