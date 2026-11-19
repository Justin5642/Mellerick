// Send Invoice on the phone: online calls to the web routes with the user's
// Bearer token, and the screen's own checks (same sentences as the web).

const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("./supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => mockFetch(...a) }));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  writeAsStringAsync: jest.fn(async () => undefined),
}));

process.env.EXPO_PUBLIC_API_BASE_URL = "https://office.example";

const s = require("./invoiceSend") as typeof import("./invoiceSend");

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: () => null },
});

class FakeReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: { b64: string }) {
    this.result = `data:application/pdf;base64,${blob.b64}`;
    this.onload?.();
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = FakeReader;

const draft: import("./invoiceSend").JobReportDraft = {
  jobNumber: 12,
  jobTitle: "Sewer",
  defaultNotes: "Laid 40 m of 100 mm sewer.",
  visits: [{ date: "2026-11-03", label: "Mon 3 Nov 2026", names: ["Dave"] }],
  photos: [
    { id: "p1", caption: null, createdAt: "2026-11-03T01:00:00Z", thumbUrl: "https://x/1" },
    { id: "p2", caption: "Trench", createdAt: "2026-11-03T02:00:00Z", thumbUrl: null },
    { id: "p3", caption: null, createdAt: "2026-11-04T02:00:00Z", thumbUrl: null },
  ],
  unsupportedPhotos: 0,
  signature: { signerName: "Sam", createdAt: "2026-11-04T05:00:00Z", url: null },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-1" } } });
});

describe("the calls", () => {
  it("loads the draft with the Bearer token", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, draft));
    await expect(s.loadJobReportDraft("inv-1")).resolves.toEqual(draft);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://office.example/api/invoices/inv-1/job-report",
      { headers: { "Content-Type": "application/json", Authorization: "Bearer tok-1" } },
      undefined
    );
  });

  it("sends the web dialog's body; report and files only when there are any", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { success: true, sentTo: "a@b.co" }));
    await s.sendInvoice("inv-1", { to: " a@b.co ", message: "Thanks", jobReport: null, attachments: [] });
    const report = { notes: "n", photoIds: ["p1"], includeSignature: true };
    const files = [{ filename: "cert.pdf", content: "QUJD" }];
    await s.sendInvoice("inv-1", { to: "a@b.co", message: "", jobReport: report, attachments: files, confirmUnpriced: true });
    const bodies = mockFetch.mock.calls.map(([url, init]) => [url, init.method, JSON.parse(init.body)]);
    expect(bodies).toEqual([
      ["https://office.example/api/invoices/inv-1/send", "POST", { to: "a@b.co", message: "Thanks", confirmUnpriced: false }],
      [
        "https://office.example/api/invoices/inv-1/send",
        "POST",
        { to: "a@b.co", message: "", jobReport: report, attachments: files, confirmUnpriced: true },
      ],
    ]);
  });

  it("turns the unpriced-hours 409 into a question, and shows the route's sentence otherwise", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(409, { code: "unpriced_hours", error: "3.00h on this job aren't on this invoice yet." }));
    const first = await s.sendInvoice("inv-1", { to: "a@b.co", message: "", jobReport: null, attachments: [] }).catch((e) => e);
    expect(first).toBeInstanceOf(s.UnpricedHoursError);
    expect(first.message).toMatch(/3.00h/);

    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: "Attach at most 10 files. Nothing was sent." }));
    const second = await s.sendInvoice("inv-1", { to: "a@b.co", message: "", jobReport: null, attachments: [] }).catch((e) => e);
    expect(second).not.toBeInstanceOf(s.UnpricedHoursError);
    expect(second.message).toBe("Attach at most 10 files. Nothing was sent.");
  });

  it("says sending needs signal when the request can't go", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network request failed"));
    const err = await s.loadJobReportDraft("inv-1").catch((e) => e);
    expect(err.message).toMatch(/needs signal/);
  });

  it("returns the preview PDF as base64 with the decoded notice", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === "X-Report-Notice" ? encodeURIComponent("2 photos left out.") : null) },
      blob: async () => ({ b64: "JVBERi0=" }),
    });
    const sel = s.buildReportSelection(draft, "n", new Set(["p1"]), true);
    await expect(s.previewJobReport("inv-1", sel)).resolves.toEqual({ base64: "JVBERi0=", notice: "2 photos left out." });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://office.example/api/invoices/inv-1/job-report/preview");
    expect(JSON.parse(init.body)).toEqual(sel);
  });

  it("shows the preview route's refusal", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { error: "The job report could not be made. Try again." }));
    const err = await s.previewJobReport("inv-1", { notes: "", photoIds: [], includeSignature: false }).catch((e) => e);
    expect(err.message).toBe("The job report could not be made. Try again.");
  });
});

describe("the job report selection", () => {
  it("keeps report order, not tick order, and drops a sign-off the job hasn't got", () => {
    expect(s.buildReportSelection(draft, "x", new Set(["p3", "p1"]), true)).toEqual({
      notes: "x",
      photoIds: ["p1", "p3"],
      includeSignature: true,
    });
    expect(s.buildReportSelection({ ...draft, signature: null }, "x", new Set(), true).includeSignature).toBe(false);
  });
});

describe("sendProblem", () => {
  const ok = { to: "a@b.co", includeReport: false, report: null, attachments: [], invoiceNumber: 1042 };
  it("passes a plain send", () => expect(s.sendProblem(ok)).toBeNull());
  it("needs an address", () => expect(s.sendProblem({ ...ok, to: "  " })).toBe("Enter an email address to send to"));
  it("waits for a ticked report", () =>
    expect(s.sendProblem({ ...ok, includeReport: true })).toBe("The job report hasn't loaded yet — wait for it, or untick it"));
  it("refuses notes over the server's limit", () =>
    expect(s.sendProblem({ ...ok, report: { notes: "a".repeat(s.MAX_REPORT_NOTES_CHARS + 1), photoIds: [], includeSignature: false } })).toMatch(
      /too long/
    ));
  it("runs the server's attachment check", () => {
    expect(s.sendProblem({ ...ok, attachments: [{ filename: "virus.exe", content: "QUJD" }] })).toMatch(/isn't a file type/);
    expect(s.sendProblem({ ...ok, attachments: [{ filename: "cert.pdf", content: "QUJD" }] })).toBeNull();
  });
});

describe("attachments", () => {
  const file = (name: string, bytes: number) => ({ id: name, filename: name, content: "", bytes });
  it("adds an allowed file", () => {
    const r = s.addAttachment([], file("cert.pdf", 1000));
    expect(r.ok && r.list.map((f) => f.filename)).toEqual(["cert.pdf"]);
  });
  it("refuses a type the server refuses", () => {
    expect(s.addAttachment([], file("thing.zip", 10))).toEqual({ ok: false, error: expect.stringMatching(/thing.zip can't be attached/) });
  });
  it("stops at 10 files", () => {
    const ten = Array.from({ length: 10 }, (_, i) => file(`f${i}.pdf`, 10));
    expect(s.addAttachment(ten, file("x.pdf", 10))).toEqual({ ok: false, error: "At most 10 files can be attached" });
  });
  it("keeps the total under 3 MB", () => {
    const big = file("a.pdf", 2.5 * 1024 * 1024);
    const r = s.addAttachment([big], file("b.pdf", 0.6 * 1024 * 1024));
    expect(r).toEqual({ ok: false, error: "b.pdf (614 KB) would take the attachments over 3.0 MB" });
    expect(s.attachmentsTotal([big, file("c.pdf", 100)])).toBe(2.5 * 1024 * 1024 + 100);
  });
  it("names a photo .jpg (it was re-encoded), or photo-<n>.jpg with no name", () => {
    expect(s.photoAttachmentName("IMG_0042.HEIC", 1)).toBe("IMG_0042.jpg");
    expect(s.photoAttachmentName(null, 3)).toBe("photo-3.jpg");
    expect(s.photoAttachmentName("../../evil", 1)).toBe("evil.jpg");
  });
  it("reserves the invoice and report names", () => {
    expect(s.reservedAttachmentNames(1042)).toEqual(["invoice-1042.pdf", "job-report-1042.pdf"]);
  });
});

describe("sentMessage", () => {
  it("names what went", () => {
    expect(s.sentMessage({ sentTo: "a@b.co" })).toBe("Invoice emailed to a@b.co");
    expect(s.sentMessage({ sentTo: "a@b.co", jobReportAttached: true, attachmentCount: 2 })).toBe(
      "Invoice and job report and 2 attached files emailed to a@b.co"
    );
  });
});
