"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, Search, X } from "lucide-react";
import { filterSites, siteDetail, type PickerSite } from "@/lib/site-picker";

// The Site picker on the New Job form and the job Overview. Justin, Nov 2026:
// "+ Add new site" at the top, and a search instead of scrolling every
// address. Sites are A–Z and filtered as you type (lib/site-picker.ts, shared
// with the phone). Same shape as the PO supplier picker
// (components/job/supplier-picker.tsx): a button that opens a drop-down with
// the search box on top — a full-screen sheet on a phone-sized screen, so the
// keyboard never covers it, with a 16px search box so iOS doesn't zoom.

/** The "No site" choice (job Overview: a job can exist without a site). */
export const NO_SITE = "__no_site__";

type Site = PickerSite & { id: string };

interface Props {
  sites: Site[];
  /** A site id, or "" for none. */
  value: string;
  onChange: (siteId: string) => void;
  /** "+ Add new site" — always the first row. */
  onAddNew: () => void;
  /** Offer "No site" (second row) to clear the site. */
  allowNone?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function SitePicker({ sites, value, onChange, onAddNew, allowNone = false, disabled, placeholder = "Select site" }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = useMemo(() => filterSites(sites, query), [sites, query]);
  const ADD = "__add__";
  // Every choice in screen order, for the arrow keys: Add first, then No site.
  const flat = useMemo(() => [ADD, ...(allowNone ? [NO_SITE] : []), ...shown.map((s) => s.id)], [shown, allowNone]);

  const picked = value ? sites.find((s) => s.id === value) ?? null : null;
  const label = picked ? `${picked.name}${picked.suburb ? ` — ${picked.suburb}` : ""}` : allowNone && !disabled ? "No site" : placeholder;

  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(id: string) {
    close();
    if (id === ADD) onAddNew();
    else onChange(id === NO_SITE ? "" : id);
  }

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
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

  const rowClass = (i: number, selected: boolean) =>
    `flex w-full flex-col items-start px-3 py-2.5 sm:py-1.5 text-left text-base sm:text-sm ${i === active ? "bg-slate-100" : ""} ${
      selected ? "font-semibold text-slate-900" : "text-slate-700"
    }`;

  const noneIndex = allowNone ? 1 : -1;
  const firstSite = allowNone ? 2 : 1;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label="Site"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex h-8 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
          picked ? "text-slate-900" : "text-muted-foreground"
        }`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="ml-1 size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-white sm:absolute sm:inset-auto sm:left-0 sm:right-0 sm:top-full sm:mt-1 sm:h-auto sm:max-h-80 sm:min-w-64 sm:rounded-md sm:border sm:border-slate-200 sm:shadow-lg"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2 border-b border-slate-100 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:pt-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 sm:h-3.5 sm:w-3.5" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, street or suburb"
                aria-label="Search sites"
                aria-controls={listId}
                aria-activedescendant={`${listId}-${active}`}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                className="h-10 w-full rounded-md border border-input bg-white pl-8 pr-2 text-base outline-none focus-visible:border-ring sm:h-8 sm:text-sm"
              />
            </div>
            <button type="button" onClick={close} className="p-2 text-slate-500 sm:hidden" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div ref={listRef} id={listId} role="listbox" className="flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            <button
              type="button"
              id={`${listId}-0`}
              role="option"
              aria-selected={false}
              data-index={0}
              onMouseEnter={() => setActive(0)}
              onClick={() => choose(ADD)}
              className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2.5 text-left text-base font-medium text-blue-700 sm:py-1.5 sm:text-sm ${
                active === 0 ? "bg-blue-50" : ""
              }`}
            >
              <Plus className="size-4 shrink-0" /> Add new site
            </button>
            {allowNone && (
              <button
                type="button"
                id={`${listId}-${noneIndex}`}
                role="option"
                aria-selected={!value}
                data-index={noneIndex}
                onMouseEnter={() => setActive(noneIndex)}
                onClick={() => choose(NO_SITE)}
                className={rowClass(noneIndex, !value)}
              >
                No site
              </button>
            )}
            {shown.map((s, k) => {
              const i = firstSite + k;
              const detail = siteDetail(s);
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
                  className={rowClass(i, s.id === value)}
                >
                  <span className="w-full truncate">{s.name}</span>
                  {detail && detail !== s.name && <span className="w-full truncate text-xs font-normal text-slate-500">{detail}</span>}
                </button>
              );
            })}
            {shown.length === 0 && (
              <p className="px-3 py-3 text-sm text-slate-400">
                {sites.length === 0 ? "This customer has no sites yet." : <>No site matches &ldquo;{query.trim()}&rdquo;.</>}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
