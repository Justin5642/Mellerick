"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { customerSearchFilters } from "@/lib/customer-search";

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
// an alphabetical list of every customer. Searches in the database as the
// user types (debounced, every word must match one of name/company/phone/
// email, at most RESULT_LIMIT rows). It used to load every active customer on
// mount -- one unbounded browser→Supabase fetch per form, silently capped at
// 1000 rows by PostgREST, all rendered into the dropdown.
//
// Favourite customers (toggled via the star on each row, persisted to
// customers.is_favorite) are always pinned to the top of both the
// empty-query list and any search results -- a handful of repeat customers
// account for most jobs/quotes/invoices entered day to day, so this saves
// hunting through the full list for them every time.
const COLUMNS = "id, name, company, phone, email, is_favorite";
const SEARCH_COLUMNS = ["name", "company", "phone", "email"] as const;
const RESULT_LIMIT = 20;

export function CustomerPicker({ value, onChange, placeholder, error, disabled }: CustomerPickerProps) {
  const supabase = createClient();
  const [results, setResults] = useState<CustomerOption[]>([]);
  // Held separately from `results`: the selected customer is often not in the
  // current page of search results (e.g. a job opened for editing, or a
  // ?customer_id= query param), so it's resolved by id on its own.
  const [selected, setSelected] = useState<CustomerOption | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [searching, setSearching] = useState(true);
  // Only the latest search may write results, so a slow response for "smi"
  // can't land on top of the one for "smith".
  const requestSeq = useRef(0);

  // Text that's just the selected customer's name (field focused without
  // typing) shows the default favourites-first list, not a search for it.
  const trimmed = query.trim();
  const term = trimmed.toLowerCase() === (selected?.name ?? "").toLowerCase() ? "" : trimmed;

  useEffect(() => {
    const seq = ++requestSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      let builder = supabase.from("customers").select(COLUMNS).eq("is_active", true);
      for (const filter of customerSearchFilters(term, SEARCH_COLUMNS)) builder = builder.or(filter);
      const { data } = await builder
        .order("is_favorite", { ascending: false })
        .order("name")
        .limit(RESULT_LIMIT);
      if (seq !== requestSeq.current) return;
      setResults(data ?? []);
      setSearching(false);
    }, term ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  // Resolve the selected customer whenever `value` changes from outside.
  // Same active-only rule as the search, so an inactive customer's id shows
  // as an empty field exactly as it did when the picker held the full list.
  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    if (selected?.id === value) return;
    const hit = results.find((c) => c.id === value);
    if (hit) {
      setSelected(hit);
      return;
    }
    let cancelled = false;
    supabase
      .from("customers")
      .select(COLUMNS)
      .eq("id", value)
      .eq("is_active", true)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setSelected(data ?? null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Keep the visible text synced to the selected customer whenever it
  // changes from outside (e.g. arriving via a ?customer_id= query param, or
  // the selected customer finishing its fetch after mount) as long as the
  // user isn't actively typing a search themselves.
  useEffect(() => {
    if (!editing) setQuery(selected?.name ?? "");
  }, [selected?.id, editing]);

  // Server order already puts favourites first; re-sorted here so starring a
  // row moves it straight away without another round trip.
  const matches = useMemo(
    () =>
      [...results].sort(
        (a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.name.localeCompare(b.name)
      ),
    [results]
  );

  async function toggleFavorite(e: React.MouseEvent, customer: CustomerOption) {
    e.stopPropagation();
    e.preventDefault();
    const next = !customer.is_favorite;
    const apply = (fav: boolean) => {
      setResults((prev) => prev.map((c) => (c.id === customer.id ? { ...c, is_favorite: fav } : c)));
      setSelected((prev) => (prev?.id === customer.id ? { ...prev, is_favorite: fav } : prev));
    };
    apply(next);
    const { error: updateError } = await supabase.from("customers").update({ is_favorite: next }).eq("id", customer.id);
    if (updateError) apply(!next);
  }

  function select(customer: CustomerOption) {
    setSelected(customer);
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
            <p className="px-3 py-2 text-xs text-slate-400">
              {searching ? "Searching..." : <>No customers match &ldquo;{query}&rdquo;</>}
            </p>
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
          {matches.length === RESULT_LIMIT && (
            <p className="px-3 py-2 text-xs text-slate-400">Showing the first {RESULT_LIMIT} — keep typing to narrow the list</p>
          )}
        </div>
      )}
    </div>
  );
}
