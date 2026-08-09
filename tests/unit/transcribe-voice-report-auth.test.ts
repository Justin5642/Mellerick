import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// transcribe-voice-report runs under the SERVICE-ROLE key, which bypasses RLS
// entirely. It authenticated the caller but then never checked whether that
// caller had anything to do with the job — and it wrote `voice_report_recorded_by`
// straight from the request body.
//
// Two separate holes, both exploitable by any signed-in user including a
// technician:
//
//   1. OVERWRITE ANY JOB. `.eq("id", id)` with no membership check means any
//      authenticated caller could replace any job's transcript and audio path.
//      The storagePath IS pinned to the job (so no cross-job file read), which
//      makes this easy to miss: the route looks guarded because one thing is.
//
//   2. FORGE ATTRIBUTION. `voice_report_recorded_by: recordedBy ?? null` takes
//      the value from the caller. A voice report is a record of who said what on
//      a job; letting the sender choose the author makes it worthless as
//      evidence and lets one technician attribute a report to another.
//
// The assertion that matters is NOT the status code. A route can return 403
// having already done the privileged work, so each rejection test also asserts
// the update never happened.

const getCallerId = vi.fn();
const canManageJobBilling = vi.fn();
const updateSpy = vi.fn();
const downloadSpy = vi.fn();

vi.mock("@/lib/api/guards", () => ({
  getCallerId: (...a: unknown[]) => getCallerId(...a),
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  requireOfficeOrAdmin: vi.fn(),
}));

vi.mock("@/lib/api/job-authz", () => ({
  canManageJobBilling: (...a: unknown[]) => canManageJobBilling(...a),
  isOfficeOrAdmin: vi.fn(async () => false),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "caller-1" } }, error: null })) },
    storage: {
      from: () => ({
        download: (...a: unknown[]) => {
          downloadSpy(...a);
          return Promise.resolve({ data: new Blob(["audio"]), error: null });
        },
      }),
    },
    from: () => ({
      update: (payload: unknown) => {
        updateSpy(payload);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  }),
}));

function post(body: unknown) {
  return new NextRequest("http://localhost/api/jobs/job-1/transcribe-voice-report", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ id: "job-1" });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = "test-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  getCallerId.mockResolvedValue("caller-1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ text: "transcribed" }) }))
  );
});

describe("transcribe-voice-report — membership", () => {
  it("REFUSES a caller with no claim on the job, and does not write", async () => {
    canManageJobBilling.mockResolvedValue(false);
    const { POST } = await import("@/app/api/jobs/[id]/transcribe-voice-report/route");

    const res = await POST(post({ storagePath: "job-1/a.m4a" }), { params });

    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("allows the assigned technician or office/admin", async () => {
    canManageJobBilling.mockResolvedValue(true);
    const { POST } = await import("@/app/api/jobs/[id]/transcribe-voice-report/route");

    const res = await POST(post({ storagePath: "job-1/a.m4a" }), { params });

    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalled();
  });
});

describe("transcribe-voice-report — attribution", () => {
  it("records the AUTHENTICATED caller, ignoring recordedBy from the body", async () => {
    canManageJobBilling.mockResolvedValue(true);
    const { POST } = await import("@/app/api/jobs/[id]/transcribe-voice-report/route");

    await POST(post({ storagePath: "job-1/a.m4a", recordedBy: "someone-else" }), { params });

    expect(updateSpy).toHaveBeenCalled();
    const payload = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.voice_report_recorded_by).toBe("caller-1");
    expect(payload.voice_report_recorded_by).not.toBe("someone-else");
  });

  it("still attributes correctly when the body omits recordedBy entirely", async () => {
    canManageJobBilling.mockResolvedValue(true);
    const { POST } = await import("@/app/api/jobs/[id]/transcribe-voice-report/route");

    await POST(post({ storagePath: "job-1/a.m4a" }), { params });

    const payload = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.voice_report_recorded_by).toBe("caller-1");
  });
});

describe("transcribe-voice-report — the guard that already worked", () => {
  it("still rejects a storagePath belonging to another job, before downloading", async () => {
    canManageJobBilling.mockResolvedValue(true);
    const { POST } = await import("@/app/api/jobs/[id]/transcribe-voice-report/route");

    const res = await POST(post({ storagePath: "other-job/a.m4a" }), { params });

    expect(res.status).toBe(403);
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
