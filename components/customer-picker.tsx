"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface CustomerOption {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  is_favorite: boolean;
}

interface CustomerPickerProps {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  error?: boolean;
  disabled?: boolean;
}

// Reusable searchable customer picker for the "new job / quote / invoice"
// forms, replacing the old plain <Select> dropdown that required scrolling
// an alphabetical list of every customer. Loads the full active customer
// list once (same no-pagination assumption those forms already made) so
// typing filters instantly, client-side, across name/company/phone/email.
//
// Favourite customers (toggled via the star on each row, persisted to
// customers.is_favorite) are always pinned to the top of both the
// empty-query list and any search results -- a handful of repeat customers
// account for most jobs/quotes/invoices entered day to day, so this saves
// hunting through the full list for them every time.
export function CustomerPicker({ value, onChange, placeholder, error, disabled }: CustomerPickerProps) {
  const supabase = createClient();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("customers")
        .select("id, name, company, phone, email, is_favorite")
        .eq("is_active", true)
        .order("name");
      setCustomers((data as any) ?? []);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = customers.find((c) => c.id === value) ?? null;

  // Keep the visible text synced to the selected customer whenever it
  // changes from outside (e.g. arriving via a ?customer_id= query param, or
  // the customer list finishing its fetch after mount) as long as the user
  // isn't actively typing a search themselves.
  useEffect(() => {
    if (!editing) setQuery(selected?.name ?? "");
  }, [selected?.id, editing]);

  const sorted = useMemo(
    () =>
      [...customers].sort(
        (a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.name.localeCompare(b.name)
      ),
    [customers]
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || q === (selected?.name ?? "").toLowerCase()) return sorted;
    const tokens = q.split(/\s+/);
    return sorted.filter((c) => {
      const haystack = `${c.name} ${c.company ?? ""} ${c.phone ?? ""} ${c.email ?? ""}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [query, sorted, selected]);

  async function toggleFavorite(e: React.MouseEvent, customer: CustomerOption) {
    e.stopPropagation();
    e.preventDefault();
    const next = !customer.is_favorite;
    setCustomers((prev) => prev.map((c) => (c.id === customer.id ? { ...c, is_favorite: next } : c)));
    const { error: updateError } = await supabase.from("customers").update({ is_favorite: next }).eq("id", customer.id);
    if (updateError) {
      setCustomers((prev) => prev.map((c) => (c.id === customer.id ? { ...c, is_favorite: !next } : c)));
    }
  }

  function select(customer: CustomerOption) {
    onChange(customer.id);
    setQuery(customer.name);
    setEditing(false);
    setOpen(false);
  }

  return (
    <div className="relative">
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setEditing(true);
          setOpen(true);
          if (value) onChange("");
        }}
        onFocus={() => {
          setEditing(true);
          setOpen(true);
        }}
        onBlur={() =>
          setTimeout(() => {
            setOpen(false);
            setEditing(false);
            setQuery(selected?.name ?? "");
          }, 150)
        }
        placeholder={placeholder ?? "Search customers..."}
        disabled={disabled}
        className={error ? "border-red-500 focus-visible:ring-red-500" : ""}
        autoComplete="off"
      />
      {open && !disabled && (
        <div className="absolute z-20 mt-1 w-full bg-white border rounded-md shadow-lg max-h-72 overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">No customers match &ldquo;{query}&rdquo;</p>
          ) : (
            matches.map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") select(c);
                }}
                className={cn(
                  "w-full flex items-center justify-between gap-2 text-left px-3 py-2 hover:bg-slate-50 border-b last:border-0 cursor-pointer",
                  c.id === value && "bg-blue-50/60"
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{c.name}</p>
                  {(c.company || c.phone || c.email) && (
                    <p className="text-xs text-slate-500 truncate">
                      {[c.company, c.phone, c.email].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => toggleFavorite(e, c)}
                  className="shrink-0 p-1 rounded hover:bg-slate-200/70"
                  title={c.is_favorite ? "Remove from favourites" : "Mark as favourite"}
                >
                  <Star className={cn("w-4 h-4", c.is_favorite ? "fill-amber-400 text-amber-400" : "text-slate-300")} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
