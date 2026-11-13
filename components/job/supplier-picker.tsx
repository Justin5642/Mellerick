"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Pin, Clock, Search, X } from "lucide-react";
import { groupSuppliers, type PickerSupplier, type SupplierGroupKey } from "@/lib/supplier-picker";

// The supplier picker on the web PO forms: Pinned, Recent, then A–Z, with a
// search across all of it (lib/supplier-picker.ts). Replaces a plain <select>
// of the whole Xero contact list.
//
// On a phone-sized screen it opens as a full-screen sheet with the search box
// at the top, so the on-screen keyboard can never cover it; the list scrolls
// underneath. The search box is 16px there — iOS Safari zooms the page into
// any smaller input. On a wider screen it is an ordinary drop-down.

export const OTHER_SUPPLIER = "__other";

interface Props<T extends PickerSupplier & { id: string }> {
  suppliers: T[];
  recentIds: string[];
  /** A supplier id, OTHER_SUPPLIER, or "" for nothing picked yet. */
  value: string;
  /** For OTHER_SUPPLIER, `typed` is whatever was in the search box. */
  onChange: (value: string, typed: string) => void;
  className?: string;
}

const GROUP_ICON: Record<SupplierGroupKey, typeof Pin | null> = { pinned: Pin, recent: Clock, all: null };

export function SupplierPicker<T extends PickerSupplier & { id: string }>({ suppliers, recentIds, value, onChange, className }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const groups = useMemo(() => groupSuppliers(suppliers, { recentIds, query }), [suppliers, recentIds, query]);
  // Every choice in screen order, for the arrow keys; "Other" is always last.
  const flat = useMemo(() => [...groups.flatMap((g) => g.suppliers.map((s) => s.id)), OTHER_SUPPLIER], [groups]);

  const picked = value && value !== OTHER_SUPPLIER ? suppliers.find((s) => s.id === value) ?? null : null;
  const label = picked ? picked.name : value === OTHER_SUPPLIER ? "Other supplier (not in the list)" : "Choose a supplier *";

  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(id: string) {
    onChange(id, id === OTHER_SUPPLIER ? query.trim() : "");
    close();
  }

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    // Click outside closes the drop-down (the full-screen sheet covers everything).
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    // A phone-sized sheet: stop the page behind it scrolling.
    const small = window.matchMedia("(max-width: 639px)").matches;
    const before = document.body.style.overflow;
    if (small) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("mousedown", onDown);
      if (small) document.body.style.overflow = before;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[active]) choose(flat[active]);
    }
  }

  // Where each group's options start in `flat`.
  const starts = groups.map((_, n) => groups.slice(0, n).reduce((sum, g) => sum + g.suppliers.length, 0));
  const otherIndex = flat.length - 1;
  const optionClass = (i: number, selected: boolean, colour = selected ? "text-slate-900" : "text-slate-700") =>
    `flex w-full items-center px-3 py-2.5 sm:py-1.5 text-left text-base sm:text-xs ${i === active ? "bg-slate-100" : ""} ${
      selected ? "font-semibold" : ""
    } ${colour}`;

  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        aria-label="Supplier"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex h-7 w-full items-center justify-between rounded-md border border-input bg-white px-2 text-left text-xs ${
          value ? "text-slate-800" : "text-slate-400"
        }`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="ml-1 h-3 w-3 shrink-0 text-slate-400" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-white sm:absolute sm:inset-auto sm:left-0 sm:right-0 sm:top-full sm:mt-1 sm:h-auto sm:max-h-80 sm:min-w-64 sm:rounded-md sm:border sm:border-slate-200 sm:shadow-lg"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2 border-b border-slate-100 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:pt-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 sm:h-3 sm:w-3" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search suppliers"
                aria-label="Search suppliers"
                aria-controls={listId}
                aria-activedescendant={`${listId}-${active}`}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                className="h-10 w-full rounded-md border border-input bg-white pl-8 pr-2 text-base outline-none focus-visible:border-ring sm:h-7 sm:pl-7 sm:text-xs"
              />
            </div>
            <button type="button" onClick={close} className="p-2 text-slate-500 sm:hidden" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div ref={listRef} id={listId} role="listbox" className="flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            {groups.map((g, n) => {
              const Icon = GROUP_ICON[g.key];
              return (
                <div key={g.key} role="group" aria-label={g.label}>
                  <div className="sticky top-0 flex items-center gap-1 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {Icon && <Icon className="h-3 w-3" />}
                    {g.label}
                  </div>
                  {g.suppliers.map((s, k) => {
                    const i = starts[n] + k;
                    return (
                      <button
                        type="button"
                        key={s.id}
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={s.id === value}
                        data-index={i}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(s.id)}
                        className={optionClass(i, s.id === value)}
                      >
                        <span className="truncate">{s.name}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {groups.length === 0 && <p className="px-3 py-3 text-sm text-slate-400 sm:text-xs">No supplier on the list matches.</p>}
            <button
              type="button"
              id={`${listId}-${otherIndex}`}
              role="option"
              aria-selected={value === OTHER_SUPPLIER}
              data-index={otherIndex}
              onMouseEnter={() => setActive(otherIndex)}
              onClick={() => choose(OTHER_SUPPLIER)}
              className={`${optionClass(otherIndex, value === OTHER_SUPPLIER, "text-blue-600")} border-t border-slate-100`}
            >
              {query.trim() ? `Other supplier: “${query.trim()}”` : "Other supplier (not in the list)…"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
