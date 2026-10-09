// London-school tests for the job-photo reads: a fake LocalReads is injected via
// setLocalReads(); we assert (a) the exact SQL + params the fake receives, (b)
// that the local rows and the PostgREST rows come back in the SAME shape, (c)
// that a job missing from the mirror (a technician's unassigned job) is
// answered by Supabase rather than as an empty grid, and (d) that signed URLs
// are fetched in ONE batched Storage call.
const mockRemote: { result: { data: unknown; error: unknown } } = { result: { data: null, error: null } };
const mockSigned: { result: { data: unknown; error: unknown } } = { result: { data: [], error: null } };

jest.mock("../../supabase", () => {
  const builder: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => resolve(mockRemote.result),
  };
  for (const m of ["select", "eq", "order"]) {
    builder[m] = jest.fn(() => builder);
  }
  const bucket = { createSignedUrls: jest.fn(async () => mockSigned.result) };
  return { supabase: { from: jest.fn(() => builder), storage: { from: jest.fn(() => bucket) } } };
});

import { supabase } from "../../supabase";
import { resetSourceForTests, setLocalReads, type LocalReads } from "./source";
import {
  JOB_PHOTOS_BUCKET,
  listJobPhotos,
  signJobPhotoUrls,
  SQL_JOB_IS_LOCAL,
  SQL_LIST_JOB_PHOTOS,
  type JobPhoto,
} from "./jobPhotos";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type FakeReads = LocalReads & { getAll: jest.Mock; getOptional: jest.Mock };
function fakeReads(over: Partial<LocalReads> = {}): FakeReads {
  return {
    hasSynced: () => true,
    role: () => "technician",
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue({ id: "j1" }),
    ...over,
  } as FakeReads;
}

const P1: JobPhoto = {
  id: "ph2",
  job_id: "j1",
  storage_path: "j1/ph2.jpg",
  photo_type: "after",
  uploaded_by: "u1",
  created_at: "2026-10-09T03:00:00.000Z",
};
const P2: JobPhoto = {
  id: "ph1",
  job_id: "j1",
  storage_path: "j1/ph1.jpg",
  photo_type: "before",
  uploaded_by: null,
  created_at: "2026-10-09T01:00:00.000Z",
};

beforeEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
  mockRemote.result = { data: null, error: null };
  mockSigned.result = { data: [], error: null };
});

describe("listJobPhotos", () => {
  it("serves from the device mirror with the expected SQL and params", async () => {
    const db = fakeReads();
    db.getAll.mockResolvedValue([P1, P2]);
    setLocalReads(db);

    const out = await listJobPhotos("j1");

    expect(norm(db.getOptional.mock.calls[0][0])).toBe(norm(SQL_JOB_IS_LOCAL));
    expect(db.getOptional.mock.calls[0][1]).toEqual(["j1"]);
    expect(norm(db.getAll.mock.calls[0][0])).toBe(norm(SQL_LIST_JOB_PHOTOS));
    expect(norm(SQL_LIST_JOB_PHOTOS)).toBe(
      "SELECT id, job_id, storage_path, photo_type, uploaded_by, created_at FROM job_photos WHERE job_id = ? ORDER BY created_at DESC, id DESC"
    );
    expect(db.getAll.mock.calls[0][1]).toEqual(["j1"]);
    expect(out).toEqual([P1, P2]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("local and remote return the identical shape for the same rows", async () => {
    // Remote (no local DB registered).
    mockRemote.result = { data: [P1, P2], error: null };
    const remote = await listJobPhotos("j1");

    const db = fakeReads();
    db.getAll.mockResolvedValue([P1, P2]);
    setLocalReads(db);
    const local = await listJobPhotos("j1");

    expect(local).toEqual(remote);
    // Same keys, nothing extra on either side (caption / simpro_file_id are not
    // in the technician stream, so neither side may select them).
    expect(Object.keys(local[0]).sort()).toEqual(Object.keys(remote[0]).sort());
    expect(Object.keys(local[0]).sort()).toEqual(
      ["created_at", "id", "job_id", "photo_type", "storage_path", "uploaded_by"]
    );
  });

  it("remote fallback selects the same column list, filtered and ordered the same", async () => {
    mockRemote.result = { data: [P1], error: null };
    await listJobPhotos("j1");
    const builder = (supabase.from as jest.Mock).mock.results[0].value;
    expect(supabase.from).toHaveBeenCalledWith("job_photos");
    expect(builder.select).toHaveBeenCalledWith("id, job_id, storage_path, photo_type, uploaded_by, created_at");
    expect(builder.eq).toHaveBeenCalledWith("job_id", "j1");
    expect(builder.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(builder.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
  });

  it("a job absent from the mirror is answered by Supabase, not as an empty grid", async () => {
    const db = fakeReads({ getOptional: jest.fn().mockResolvedValue(null) } as Partial<LocalReads>);
    setLocalReads(db);
    mockRemote.result = { data: [P1], error: null };

    const out = await listJobPhotos("j-unassigned");

    expect(db.getAll).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith("job_photos");
    expect(out).toEqual([P1]);
  });

  it("before first sync it goes to Supabase", async () => {
    const db = fakeReads({ hasSynced: () => false });
    setLocalReads(db);
    mockRemote.result = { data: [], error: null };
    await listJobPhotos("j1");
    expect(db.getAll).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalled();
  });

  it("a failed remote read throws instead of posing as 'no photos'", async () => {
    mockRemote.result = { data: null, error: { message: "permission denied", code: "42501" } };
    await expect(listJobPhotos("j1")).rejects.toThrow(/listJobPhotos: permission denied/);
  });
});

describe("signJobPhotoUrls", () => {
  it("signs every path in ONE batched Storage call, de-duplicated", async () => {
    mockSigned.result = {
      data: [
        { path: "j1/ph1.jpg", signedUrl: "https://s/ph1?token=a", error: null },
        { path: "j1/ph2.jpg", signedUrl: "https://s/ph2?token=b", error: null },
      ],
      error: null,
    };
    const out = await signJobPhotoUrls(["j1/ph1.jpg", "j1/ph2.jpg", "j1/ph1.jpg"]);
    expect(supabase.storage.from).toHaveBeenCalledTimes(1);
    expect(supabase.storage.from).toHaveBeenCalledWith(JOB_PHOTOS_BUCKET);
    const bucket = (supabase.storage.from as jest.Mock).mock.results[0].value;
    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(["j1/ph1.jpg", "j1/ph2.jpg"], 3600);
    expect(out).toEqual({ "j1/ph1.jpg": "https://s/ph1?token=a", "j1/ph2.jpg": "https://s/ph2?token=b" });
  });

  it("leaves a per-item failure out so the cell can say it didn't load", async () => {
    mockSigned.result = {
      data: [
        { path: "j1/ph1.jpg", signedUrl: "https://s/ph1?token=a", error: null },
        { path: "j1/gone.jpg", signedUrl: null, error: "Object not found" },
      ],
      error: null,
    };
    expect(await signJobPhotoUrls(["j1/ph1.jpg", "j1/gone.jpg"])).toEqual({ "j1/ph1.jpg": "https://s/ph1?token=a" });
  });

  it("makes no request for an empty list", async () => {
    expect(await signJobPhotoUrls([])).toEqual({});
    expect(supabase.storage.from).not.toHaveBeenCalled();
  });

  it("a request-level Storage error throws", async () => {
    mockSigned.result = { data: null, error: { message: "JWT expired" } };
    await expect(signJobPhotoUrls(["j1/ph1.jpg"])).rejects.toThrow(/signJobPhotoUrls: JWT expired/);
  });
});
