// The REMOTE half of getJob reads the office's send-back (0122, a draft): admin_status
// plus the note stamped FOR the crew (sent_back_note) — never admin_notes,
// which also carries approval comments. Before 0122 the columns don't exist,
// so the read retries without them instead of failing the job screen.
const mockSelects: string[] = [];
let mockAnswers: unknown[] = [];

jest.mock("../../supabase", () => {
  function builder() {
    const b: Record<string, unknown> = {};
    b.select = (cols: string) => {
      mockSelects.push(cols);
      return b;
    };
    b.eq = () => b;
    b.single = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve(mockAnswers.shift() ?? { data: null, error: null });
    return b;
  }
  return { supabase: { from: () => builder() } };
});

import { resetSourceForTests } from "./source";
import { getJob, isMissingSentBackColumn } from "./jobs";

afterEach(() => {
  resetSourceForTests();
  mockSelects.length = 0;
  mockAnswers = [];
});

const row = { id: "j1", job_number: 7, admin_status: "rejected" };

describe("getJob (remote) and the send-back columns", () => {
  it("selects admin_status and the stamped note, never admin_notes", async () => {
    mockAnswers = [{ data: { ...row, sent_back_note: "Need CCTV", sent_back_at: "2026-11-27T03:15:00Z" }, error: null }];
    const job = await getJob("j1");
    expect(job).toMatchObject({ admin_status: "rejected", sent_back_note: "Need CCTV" });
    expect(mockSelects).toHaveLength(1);
    expect(mockSelects[0]).toContain("admin_status, sent_back_note, sent_back_at,");
    expect(mockSelects[0]).not.toContain("admin_notes");
  });

  it("retries without them on a database without 0122 and answers null", async () => {
    mockAnswers = [
      { data: null, error: { code: "42703", message: "column jobs.sent_back_note does not exist" } },
      { data: row, error: null },
    ];
    const job = await getJob("j1");
    expect(mockSelects).toHaveLength(2);
    expect(mockSelects[1]).not.toContain("sent_back");
    expect(mockSelects[1]).toContain("admin_status");
    expect(job).toMatchObject({ admin_status: "rejected", sent_back_note: null, sent_back_at: null });
  });

  it("only treats the sent_back columns going missing as 'before 0122'", () => {
    expect(isMissingSentBackColumn({ code: "42703", message: "column jobs.sent_back_at does not exist" })).toBe(true);
    expect(isMissingSentBackColumn({ code: "PGRST204", message: "Could not find the 'sent_back_note' column" })).toBe(true);
    expect(isMissingSentBackColumn({ code: "42703", message: "column jobs.priority does not exist" })).toBe(false);
    expect(isMissingSentBackColumn({ code: "42501", message: "sent_back_note" })).toBe(false);
    expect(isMissingSentBackColumn(null)).toBe(false);
  });
});
