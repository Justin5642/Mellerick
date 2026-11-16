// The site picker on the job forms (web New Job and job Overview, phone New
// Job). Justin, Nov 2026: a builder can have dozens of lots, so the picker
// lists them A–Z and filters as you type instead of making the office scroll
// every address; "+ Add new site" sits at the top, above the list.
//
// Search: every word typed must appear somewhere in the site's name, street,
// suburb or postcode ("12 smith epp" finds "Lot 12, 4 Smith St, Epping").
// A–Z is by name, numbers in order ("Lot 2" before "Lot 10"), then suburb.
// Pure — no I/O. A copy of lib/site-picker.ts on the website, kept
// identical (comments aside) by tests/unit/site-picker.test.ts.

export interface PickerSite {
  name: string;
  suburb?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postcode?: string | null;
}

// Case-blind, numbers by value. Hand-rolled rather than Intl.Collator's
// `numeric` option, which the phone's JavaScript engine does not promise.
function naturalCompare(a: string, b: string): number {
  const split = (s: string) => s.toLowerCase().trim().match(/\d+|\D+/g) ?? [];
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    const pn = /^\d/.test(p);
    const qn = /^\d/.test(q);
    if (pn && qn) return Number(p) - Number(q) || p.length - q.length;
    return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

export function compareSites(a: PickerSite, b: PickerSite): number {
  return naturalCompare(a.name ?? "", b.name ?? "") || naturalCompare(a.suburb ?? "", b.suburb ?? "");
}

/** What the search looks through, lower-cased. */
function haystack(s: PickerSite): string {
  return [s.name, s.address_line1, s.address_line2, s.suburb, s.postcode]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .join(" ")
    .toLowerCase();
}

export function siteMatches(site: PickerSite, query: string): boolean {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack(site);
  return words.every((w) => text.includes(w));
}

/** The sites to show for `query`: matching ones, A–Z. Never mutates `sites`. */
export function filterSites<T extends PickerSite>(sites: readonly T[], query = ""): T[] {
  return sites.filter((s) => siteMatches(s, query)).sort(compareSites);
}

/** The line under a site's name: its street and suburb, whichever it has. */
export function siteDetail(site: PickerSite): string {
  return [site.address_line1, site.suburb].filter((p) => typeof p === "string" && p.trim() !== "").join(", ");
}
