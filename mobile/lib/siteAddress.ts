// Rules for a new job site typed in while creating a job on the phone: what
// counts as a usable address, and when it is the same place as a site the
// customer already has. Mirror of the web's lib/site-address.ts, pinned
// identical below this header by tests/unit/site-address.test.ts.
// Pure: no imports, so both platforms can share the same text.
//
export interface SiteAddressInput {
  name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
}

export interface SiteAddressClean {
  name: string;
  address_line1: string;
  address_line2: string | null;
  suburb: string;
  state: string;
  postcode: string;
}

export type SiteAddressField = "name" | "address_line1" | "suburb" | "state" | "postcode";

export type SiteAddressCheck =
  | { ok: true; value: SiteAddressClean }
  | { ok: false; errors: Partial<Record<SiteAddressField, string>>; message: string };

const STATES: Record<string, string> = {
  vic: "VIC", victoria: "VIC",
  nsw: "NSW", newsouthwales: "NSW",
  qld: "QLD", queensland: "QLD",
  sa: "SA", southaustralia: "SA",
  wa: "WA", westernaustralia: "WA",
  tas: "TAS", tasmania: "TAS",
  act: "ACT", australiancapitalterritory: "ACT",
  nt: "NT", northernterritory: "NT",
};

/** "vic", "Victoria", " VIC " → "VIC"; anything else → null. */
export function normaliseState(state: string | null | undefined): string | null {
  const k = (state ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return STATES[k] ?? null;
}

const squash = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ");

/**
 * Street (with a street name, not just a number), suburb, an Australian state
 * and a 4-digit postcode are required. The site name is optional: it defaults
 * to the street address, which is what the office types as a name anyway.
 */
export function validateSiteAddress(input: SiteAddressInput): SiteAddressCheck {
  const street = squash(input.address_line1);
  const suburb = squash(input.suburb);
  const state = normaliseState(input.state);
  const postcode = squash(input.postcode).replace(/\s/g, "");
  const errors: Partial<Record<SiteAddressField, string>> = {};
  if (!street) errors.address_line1 = "Enter the street address.";
  else if (!/[a-z]{2}/i.test(street)) errors.address_line1 = "Include the street name, not just the number.";
  if (!suburb) errors.suburb = "Enter the suburb.";
  else if (!/[a-z]/i.test(suburb)) errors.suburb = "Check the suburb.";
  if (!squash(input.state)) errors.state = "Enter the state.";
  else if (!state) errors.state = "Use an Australian state, e.g. VIC.";
  if (!postcode) errors.postcode = "Enter the postcode.";
  else if (!/^\d{4}$/.test(postcode)) errors.postcode = "Postcodes are 4 digits.";
  const fields = Object.keys(errors) as SiteAddressField[];
  if (fields.length > 0) {
    return { ok: false, errors, message: Object.values(errors)[0] as string };
  }
  return {
    ok: true,
    value: {
      name: squash(input.name) || street,
      address_line1: street,
      address_line2: squash(input.address_line2) || null,
      suburb,
      state: state as string,
      postcode,
    },
  };
}

// Street-type words written either way ("St" / "Street") compare equal.
const STREET_WORDS: Record<string, string> = {
  street: "st", st: "st",
  road: "rd", rd: "rd",
  avenue: "ave", ave: "ave", av: "ave",
  drive: "dr", dr: "dr", drv: "dr",
  court: "ct", ct: "ct", crt: "ct",
  crescent: "cres", cres: "cres", cr: "cres",
  place: "pl", pl: "pl",
  circuit: "cct", cct: "cct",
  highway: "hwy", hwy: "hwy",
  parade: "pde", pde: "pde",
  terrace: "tce", tce: "tce",
  boulevard: "bvd", boulevarde: "bvd", bvd: "bvd", blvd: "bvd",
  lane: "ln", ln: "ln",
  close: "cl", cl: "cl",
  grove: "gr", gr: "gr", gve: "gr",
  way: "wy", wy: "wy",
  square: "sq", sq: "sq",
  promenade: "prom", prom: "prom",
  esplanade: "esp", esp: "esp",
};

function words(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "" && w !== "unit");
}

/** Comparable form of the street lines: case, spacing, punctuation and street-type spelling ignored. */
export function streetKey(site: SiteAddressInput): string {
  return [...words(site.address_line1), ...words(site.address_line2)].map((w) => STREET_WORDS[w] ?? w).join(" ");
}

export interface ExistingSite extends SiteAddressInput {
  id: string;
  is_active?: boolean | null;
}

/**
 * The customer's ACTIVE site at the same address, if any: same street lines
 * and suburb, and the same postcode when both have one. Archived sites are
 * ignored — they are hidden from pickers, so "use the existing one" could not
 * select them.
 */
export function findDuplicateSite<T extends ExistingSite>(input: SiteAddressInput, sites: readonly T[]): T | null {
  const street = streetKey(input);
  const suburb = words(input.suburb).join(" ");
  const postcode = squash(input.postcode);
  if (!street || !suburb) return null;
  for (const s of sites) {
    if (s.is_active === false) continue;
    if (streetKey(s) !== street) continue;
    if (words(s.suburb).join(" ") !== suburb) continue;
    const theirs = squash(s.postcode);
    if (postcode && theirs && theirs !== postcode) continue;
    return s;
  }
  return null;
}

/**
 * Sites have one free-text `notes` column. The site contact and access notes
 * asked for while adding a site are kept there, labelled, so the crew reads
 * them wherever site notes are shown.
 */
export function composeSiteNotes(parts: { contact?: string | null; access?: string | null }): string | null {
  const lines: string[] = [];
  const contact = (parts.contact ?? "").trim();
  const access = (parts.access ?? "").trim();
  if (contact) lines.push(`Site contact: ${contact}`);
  if (access) lines.push(`Access: ${access}`);
  return lines.length ? lines.join("\n") : null;
}
