"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";

// Search box for the Customers list page (a server component). Typing updates
// ?q= after a short pause and the server re-runs the search in the database,
// instead of the browser downloading every customer to filter locally. Any
// new search goes back to page 1, so the ?page= param is dropped.
export function CustomerSearchBox({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState(initialQuery);
  const [, startTransition] = useTransition();
  // The query currently in the URL, so the debounce below doesn't navigate
  // on mount or re-run a search that's already showing.
  const applied = useRef(initialQuery);

  useEffect(() => {
    const q = search.trim();
    if (q === applied.current) return;
    const t = setTimeout(() => {
      applied.current = q;
      const href = q ? `${pathname}?${new URLSearchParams({ q })}` : pathname;
      startTransition(() => router.replace(href, { scroll: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [search, pathname, router]);

  return (
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
  );
}
