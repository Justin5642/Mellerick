// Risk-register #7: an empty local table read as "no rows" is the most
// dangerous failure mode of this migration. These four modules are
// DELIBERATELY Supabase-only (design §3.3/§3.4/§3.7/§3.8):
//
//   jobCosting — staff_cost_profiles/billing_rate_config unpublished; the
//                min-margin verdict must not default offline
//   approvals  — pre-write duplicate-invoice consistency read
//   staff      — payroll tables unpublished
//   settings   — variation_types is rate-stripped for every role and
//                cost_center_templates is unpublished
//
// So: with a READY, allow-listed (office-role) fake LocalReads registered,
// calling a representative function from each module must NEVER touch the
// fake — every query must go to the (mocked) supabase client.
jest.mock("../../supabase", () => {
  const builder: any = {};
  Object.assign(builder, {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    order: jest.fn(() => builder),
    single: jest.fn(() => builder),
    maybeSingle: jest.fn(() => builder),
    // Awaitable at any point in the chain; "empty shapes" — no rows anywhere.
    then: (resolve: (v: unknown) => void) => resolve({ data: null }),
  });
  return { supabase: { from: jest.fn(() => builder) } };
});

import { supabase } from "../../supabase";
import {
  resetSourceForTests,
  setLocalReads,
  type LocalReads,
  type LocalRole,
} from "./source";
import { getJobProfitability } from "./jobCosting";
import { getApprovalPlan } from "./approvals";
import { listStaff } from "./staff";
import { listVariationTypes } from "./settings";

function readyOfficeFake(): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
  };
}

describe("deliberately Supabase-only reads never touch the local DB", () => {
  let fake: LocalReads;

  beforeEach(() => {
    fake = readyOfficeFake();
    setLocalReads(fake);
  });

  afterEach(() => {
    resetSourceForTests();
    jest.clearAllMocks();
  });

  function expectFakeUntouched() {
    expect(fake.getAll as jest.Mock).not.toHaveBeenCalled();
    expect(fake.getOptional as jest.Mock).not.toHaveBeenCalled();
  }

  it("jobCosting.getJobProfitability goes to Supabase only", async () => {
    const result = await getJobProfitability("job-1");

    expectFakeUntouched();
    const tables = (supabase.from as jest.Mock).mock.calls.map((c) => c[0]);
    // The unpublished tables are the reason this module has no local path.
    expect(tables).toContain("staff_cost_profiles");
    expect(tables).toContain("billing_rate_config");
    expect(result).toBeNull(); // empty shapes → no job row
  });

  it("approvals.getApprovalPlan goes to Supabase only", async () => {
    const result = await getApprovalPlan("job-1");

    expectFakeUntouched();
    const tables = (supabase.from as jest.Mock).mock.calls.map((c) => c[0]);
    // The dup-invoice guard is the consistency read that must stay server-live.
    expect(tables).toContain("invoices");
    expect(result).toBeNull();
  });

  it("staff.listStaff goes to Supabase only", async () => {
    const result = await listStaff();

    expectFakeUntouched();
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("profiles");
    expect(result).toEqual([]);
  });

  it("settings.listVariationTypes goes to Supabase only", async () => {
    const result = await listVariationTypes();

    expectFakeUntouched();
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("variation_types");
    expect(result).toEqual([]);
  });
});
