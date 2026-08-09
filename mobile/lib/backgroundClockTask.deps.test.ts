
// THE UNTESTED SEAM.
//
// C3 said the background auto-clock "can never record a travel leg", for two
// structural reasons. Both are fixed, and both fixes are well covered — but the
// coverage stops one layer short.
//
//   backgroundClockPlan.test.ts   proves the PLAN emits fromJobId + fromAt
//   this file                     proves the DEPS turn that into a real row
//
// The gap matters because C3's second cause lived precisely here: insertTravelLeg
// used to re-derive the departure instant by querying the previous entry's
// clock_out, which in the only case that populated fromJobId equalled the
// arrival time — so the duration was zero and plausibleAutoClockHours discarded
// it. A plan that emits a perfect action still writes nothing if the writer
// throws the duration away, and until now nothing asserted otherwise.

const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockMaybeSingleResult = { data: null as unknown, error: null as unknown };

jest.mock("expo-location", () => ({}));
jest.mock("expo-task-manager", () => ({ defineTask: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  multiRemove: jest.fn(),
}));

jest.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      insert: (payload: unknown) => {
        mockInsert(payload);
        return Promise.resolve({ error: null });
      },
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: () => Promise.resolve(mockMaybeSingleResult),
              }),
            }),
          }),
        }),
      }),
      update: (payload: unknown) => {
        mockUpdate(payload);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  },
}));

// Imported after the mocks above, since the module reaches native code at load.
import { supabaseClockDeps } from "./backgroundClockTask";

const T0 = Date.parse("2026-08-10T08:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MIN = 60_000;

beforeEach(() => {
  jest.clearAllMocks();
  mockMaybeSingleResult.data = null;
  mockMaybeSingleResult.error = null;
});

describe("supabaseClockDeps.onArrive — the travel leg actually reaches the database", () => {
  it("writes a travel row with NON-ZERO hours timed from the departure", async () => {
    // 25 minutes of driving. The bug this pins produced 0 and discarded the row.
    await supabaseClockDeps.onArrive("job-b", iso(25 * MIN), "job-a", iso(0), "staff-1");

    const travel = mockInsert.mock.calls.map((c) => c[0]).find((p) => p.entry_type === "travel");
    // jest's expect takes one argument — no message parameter, unlike vitest.
    expect(travel).toBeDefined();
    expect(travel.hours).toBeGreaterThan(0);
    expect(travel.hours).toBeCloseTo(0.42, 2);
  });

  it("times the leg from the DEPARTURE, not from the arrival", async () => {
    await supabaseClockDeps.onArrive("job-b", iso(25 * MIN), "job-a", iso(0), "staff-1");

    const travel = mockInsert.mock.calls.map((c) => c[0]).find((p) => p.entry_type === "travel");
    expect(travel.clock_in).toBe(iso(0));
    expect(travel.clock_out).toBe(iso(25 * MIN));
  });

  it("attributes the drive to the job it started from", async () => {
    await supabaseClockDeps.onArrive("job-b", iso(25 * MIN), "job-a", iso(0), "staff-1");

    const travel = mockInsert.mock.calls.map((c) => c[0]).find((p) => p.entry_type === "travel");
    expect(travel.travel_from_job_id).toBe("job-a");
    expect(travel.job_id).toBe("job-b");
    expect(travel.auto_clocked).toBe(true);
  });

  it("always clocks in at the new site, travel leg or not", async () => {
    await supabaseClockDeps.onArrive("job-b", iso(25 * MIN), null, null, "staff-1");

    const work = mockInsert.mock.calls.map((c) => c[0]).find((p) => p.entry_type === "work");
    expect(work).toBeDefined();
    expect(work.job_id).toBe("job-b");
    expect(work.auto_clocked).toBe(true);
  });

  it("writes NO travel row when there is no pending departure", async () => {
    // First site of the day: nothing was driven from, so inventing a leg would
    // put fabricated time on a payslip.
    await supabaseClockDeps.onArrive("job-b", iso(25 * MIN), null, null, "staff-1");

    expect(mockInsert.mock.calls.map((c) => c[0]).find((p) => p.entry_type === "travel")).toBeUndefined();
  });

  it("writes NO travel row for an implausible duration, and still clocks in", async () => {
    // Nine hours "driving" means the phone was off or the departure never
    // fired. The arrival is still real, so it must still be recorded — losing
    // the leg is a gap the office can correct; a nine-hour drive is a lie.
    await supabaseClockDeps.onArrive("job-b", iso(9 * 60 * MIN), "job-a", iso(0), "staff-1");

    const payloads = mockInsert.mock.calls.map((c) => c[0]);
    expect(payloads.find((p) => p.entry_type === "travel")).toBeUndefined();
    expect(payloads.find((p) => p.entry_type === "work")).toBeDefined();
  });

  it("writes NO travel row for a NEGATIVE duration", async () => {
    // Cross-device clock skew. This is the defect that reached payroll on the
    // manual path; it must not reach it here.
    await supabaseClockDeps.onArrive("job-b", iso(0), "job-a", iso(25 * MIN), "staff-1");

    expect(mockInsert.mock.calls.map((c) => c[0]).find((p) => p.entry_type === "travel")).toBeUndefined();
  });
});

describe("supabaseClockDeps.onDepart", () => {
  it("closes the open work entry with computed hours", async () => {
    mockMaybeSingleResult.data = { id: "entry-1", clock_in: iso(0) };

    await supabaseClockDeps.onDepart("job-a", iso(2 * 60 * MIN), "staff-1");

    expect(mockUpdate).toHaveBeenCalled();
    const payload = mockUpdate.mock.calls[0][0];
    expect(payload.clock_out).toBe(iso(2 * 60 * MIN));
    expect(payload.hours).toBeCloseTo(2, 2);
  });

  it("still CLOSES the entry when the duration is implausible, withholding only hours", async () => {
    // Leaving it open is its own problem — the office then sees an entry
    // running for days rather than a gap to correct.
    mockMaybeSingleResult.data = { id: "entry-1", clock_in: iso(0) };

    await supabaseClockDeps.onDepart("job-a", iso(40 * 60 * MIN), "staff-1");

    const payload = mockUpdate.mock.calls[0][0];
    expect(payload.clock_out).toBe(iso(40 * 60 * MIN));
    expect("hours" in payload).toBe(false);
  });

  it("does nothing when there is no open entry", async () => {
    mockMaybeSingleResult.data = null;

    await supabaseClockDeps.onDepart("job-a", iso(MIN), "staff-1");

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
