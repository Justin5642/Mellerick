import { join } from "node:path";

// Where global-setup leaves what the tests need.
//
// Under test-results/ on purpose: the directory is already gitignored and
// already wiped between runs, so a session file cannot be committed by accident
// and cannot outlive the stack it belongs to.
const OUT = join(process.cwd(), "test-results", "e2e-auth");

/** Playwright storageState for an office user — a session, not a credential. */
export const OFFICE_STATE = join(OUT, "office.json");
export const TECH_STATE = join(OUT, "technician.json");

/** Ids of the rows global-setup seeded, so specs can address them directly. */
export const SEED_FILE = join(OUT, "seed.json");
