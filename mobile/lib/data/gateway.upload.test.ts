// The gateway's halves of three audit findings:
//   • uploadObject streams from the file path (no base64 in the JS heap)
//   • failures carry whether they were transient (no signal / timeout / 5xx)
//   • callSideEffect THROWS when the web API is not configured, instead of
//     reporting success for work that never left the phone

const mockCreateUploadTask = jest.fn();
const mockReadAsString = jest.fn();
const mockInsert = jest.fn();

jest.mock("expo-file-system/legacy", () => ({
  createUploadTask: (...args: unknown[]) => mockCreateUploadTask(...args),
  readAsStringAsync: (...args: unknown[]) => mockReadAsString(...args),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  EncodingType: { Base64: "base64" },
  documentDirectory: "file:///doc/",
}));
jest.mock("../supabase", () => ({
  supabase: {
    from: () => ({ insert: mockInsert }),
    auth: { getSession: async () => ({ data: { session: { access_token: "user-jwt" } }, error: null }) },
  },
}));

// The gateway is loaded in isolation per test (env is read at module scope),
// so its TransientSyncError is a different class object from any imported
// here — assert on the marker the outbox actually reads instead.
const TRANSIENT = { transient: true };

process.env.EXPO_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

function task(result: unknown, opts: { reject?: Error } = {}) {
  const t = {
    uploadAsync: jest.fn(() => (opts.reject ? Promise.reject(opts.reject) : Promise.resolve(result))),
    cancelAsync: jest.fn().mockResolvedValue(undefined),
  };
  mockCreateUploadTask.mockReturnValue(t);
  return t;
}

function loadGateway(apiBase?: string) {
  if (apiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = apiBase;
  let mod: typeof import("./gateway.supabase") | undefined;
  jest.isolateModules(() => {
    mod = require("./gateway.supabase");
  });
  return mod!;
}

beforeEach(() => {
  mockCreateUploadTask.mockReset();
  mockReadAsString.mockReset();
  mockInsert.mockReset();
});

describe("uploadObject — streamed from disk", () => {
  it("uploads the FILE PATH natively, with the user's token and upsert, never reading it into JS", async () => {
    task({ status: 200, body: "{}" });
    const { supabaseGateway } = loadGateway();
    await supabaseGateway.uploadObject("job-audio", "job-1/report.wav", "file:///doc/outbox-attachments/x.wav");

    expect(mockReadAsString).not.toHaveBeenCalled();
    const [url, fileUri, options] = mockCreateUploadTask.mock.calls[0];
    expect(url).toBe("https://proj.supabase.co/storage/v1/object/job-audio/job-1/report.wav");
    expect(fileUri).toBe("file:///doc/outbox-attachments/x.wav");
    expect(options).toEqual(
      expect.objectContaining({
        httpMethod: "POST",
        uploadType: 0,
        headers: expect.objectContaining({
          Authorization: "Bearer user-jwt",
          apikey: "anon-key",
          "Content-Type": "audio/wav",
          "x-upsert": "true",
        }),
      })
    );
  });

  it("encodes path segments so a space in a file name cannot break the URL", async () => {
    task({ status: 200, body: "{}" });
    const { supabaseGateway } = loadGateway();
    await supabaseGateway.uploadObject("job-photos", "/job 1//a#b.jpg", "file:///x.jpg");
    expect(mockCreateUploadTask.mock.calls[0][0]).toBe("https://proj.supabase.co/storage/v1/object/job-photos/job%201/a%23b.jpg");
  });

  it("a 4xx is a rejection, carrying the server's message", async () => {
    task({ status: 403, body: JSON.stringify({ message: "new row violates row-level security policy" }) });
    const { supabaseGateway } = loadGateway();
    const err = await supabaseGateway.uploadObject("b", "p.jpg", "file:///x.jpg").catch((e) => e);
    expect(err.message).toMatch(/row-level security/);
    expect(err.transient).toBeUndefined();
  });

  it("a 5xx and a thrown (network) upload are transient", async () => {
    task({ status: 503, body: "Service Unavailable" });
    const { supabaseGateway } = loadGateway();
    await expect(supabaseGateway.uploadObject("b", "p.jpg", "file:///x.jpg")).rejects.toMatchObject(TRANSIENT);
    task(undefined, { reject: new Error("The Internet connection appears to be offline.") });
    await expect(supabaseGateway.uploadObject("b", "p.jpg", "file:///x.jpg")).rejects.toMatchObject(TRANSIENT);
  });

  it("cancels a stalled upload at the storage deadline and reports it as transient", async () => {
    jest.useFakeTimers();
    try {
      let resolveUpload: (v: unknown) => void = () => {};
      const t = {
        uploadAsync: jest.fn(() => new Promise((r) => (resolveUpload = r))),
        // A cancelled task resolves with nothing.
        cancelAsync: jest.fn(async () => resolveUpload(undefined)),
      };
      mockCreateUploadTask.mockReturnValue(t);
      const { supabaseGateway } = loadGateway();
      const pending = supabaseGateway.uploadObject("b", "p.jpg", "file:///x.jpg");
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(t.cancelAsync).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("insertRow — status travels with the failure", () => {
  it("status 0 (no connection / timeout) is transient", async () => {
    mockInsert.mockResolvedValue({ error: { message: "TypeError: Network request failed", code: "" }, status: 0 });
    const { supabaseGateway } = loadGateway();
    await expect(supabaseGateway.insertRow("time_entries", { id: "x" })).rejects.toMatchObject(TRANSIENT);
  });

  it("a 403 is a rejection", async () => {
    mockInsert.mockResolvedValue({ error: { message: "rls", code: "42501" }, status: 403 });
    const { supabaseGateway } = loadGateway();
    const err = await supabaseGateway.insertRow("time_entries", { id: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.transient).toBeUndefined();
  });
});

describe("callSideEffect — configuration and classification", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("THROWS when EXPO_PUBLIC_API_BASE_URL is missing, so the op stays queued instead of being marked done", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const { apiBridge } = loadGateway(undefined);
    await expect(apiBridge.callSideEffect("sync-billing", { entryId: "e1" })).rejects.toThrow(/EXPO_PUBLIC_API_BASE_URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a 5xx is transient and a 4xx is a rejection", async () => {
    const { apiBridge } = loadGateway("https://api.test.local");
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as never;
    await expect(apiBridge.callSideEffect("sync-billing", { entryId: "e1" })).rejects.toMatchObject(TRANSIENT);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as never;
    const err = await apiBridge.callSideEffect("sync-billing", { entryId: "e1" }).catch((e) => e);
    expect(err.message).toBe("sync-billing: HTTP 404");
    expect(err.transient).toBeUndefined();
  });

  it("succeeds on a 2xx", async () => {
    const { apiBridge } = loadGateway("https://api.test.local");
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
    await expect(apiBridge.callSideEffect("sync-billing", { entryId: "e1" })).resolves.toBeUndefined();
  });
});
