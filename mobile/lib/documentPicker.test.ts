// lib/documentPicker.ts — the lazily loaded file picker and the checks that
// run before a picked file is sent to an upload route.

const mockGetDocumentAsync = jest.fn();
// mockNativeMissing = an old binary: the JS package is bundled but its native
// module isn't, so getDocumentAsync isn't there.
let mockNativeMissing = false;
jest.mock("expo-document-picker", () => ({
  get getDocumentAsync() {
    return mockNativeMissing ? undefined : (...a: unknown[]) => mockGetDocumentAsync(...a);
  },
}));

const mockRead = jest.fn();
const mockDelete = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: (...a: unknown[]) => mockRead(...a),
  deleteAsync: (...a: unknown[]) => mockDelete(...a),
  EncodingType: { Base64: "base64" },
}));

const mockPrepare = jest.fn();
jest.mock("./imageUpload", () => ({ prepareImage: (...a: unknown[]) => mockPrepare(...a) }));

import {
  __resetDocumentPickerForTests,
  base64ByteLength,
  base64Head,
  documentPickerAvailable,
  fileTooBigMessage,
  isPickedImage,
  mapPickerResult,
  MAX_PICKED_UPLOAD_BYTES,
  pickDocuments,
  pickedBaseName,
  pickedUploadProblem,
  pickUploadFile,
  readPickedForUpload,
  sniffBase64Kind,
  uploadFileName,
  UPLOAD_PICKER_TYPES,
} from "./documentPicker";

const b64 = (bytes: number[], pad = 120) => Buffer.from([...bytes, ...new Array(pad).fill(0x20)]).toString("base64");
const PDF = b64([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const DOCX = b64([0x50, 0x4b, 0x03, 0x04]);

beforeEach(() => {
  jest.clearAllMocks();
  mockNativeMissing = false;
  __resetDocumentPickerForTests();
});

describe("mapPickerResult", () => {
  it("is null when cancelled or empty", () => {
    expect(mapPickerResult({ canceled: true, assets: null })).toBeNull();
    expect(mapPickerResult({ canceled: false, assets: [] })).toBeNull();
    expect(mapPickerResult(null)).toBeNull();
  });

  it("maps assets, normalising size and type and naming unnamed files from the uri", () => {
    expect(
      mapPickerResult({
        canceled: false,
        assets: [
          { name: " Plan.PDF ", uri: "file:///c/Plan.PDF", size: 1234, mimeType: "Application/PDF", lastModified: 1 },
          { name: "", uri: "file:///c/scan-2.jpg?x=1", size: -1, lastModified: 1 },
          { name: "no-uri" },
        ],
      })
    ).toEqual([
      { name: "Plan.PDF", uri: "file:///c/Plan.PDF", size: 1234, mimeType: "application/pdf" },
      { name: "scan-2.jpg", uri: "file:///c/scan-2.jpg?x=1", size: null, mimeType: null },
    ]);
  });
});

describe("pure checks", () => {
  it("sniffs the bytes the routes accept", () => {
    expect(sniffBase64Kind(PDF)).toBe("pdf");
    expect(sniffBase64Kind(JPEG)).toBe("jpeg");
    expect(sniffBase64Kind(PNG)).toBe("png");
    expect(sniffBase64Kind(WEBP)).toBe("webp");
    expect(sniffBase64Kind(DOCX)).toBeNull();
    expect(sniffBase64Kind("")).toBeNull();
    expect(base64Head(Buffer.from("%PDF-").toString("base64"), 5)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it("counts base64 bytes", () => {
    expect(base64ByteLength(Buffer.alloc(10).toString("base64"))).toBe(10);
    expect(base64ByteLength(Buffer.alloc(11).toString("base64"))).toBe(11);
    expect(base64ByteLength(Buffer.alloc(12).toString("base64"))).toBe(12);
  });

  it("knows photos by type or extension", () => {
    expect(isPickedImage({ name: "a.HEIC", mimeType: null })).toBe(true);
    expect(isPickedImage({ name: "a", mimeType: "image/png" })).toBe(true);
    expect(isPickedImage({ name: "a.pdf", mimeType: "application/pdf" })).toBe(false);
  });

  it("refuses other types, and a too-big PDF before it is read — but not a big photo (it is shrunk)", () => {
    const big = MAX_PICKED_UPLOAD_BYTES + 1;
    expect(pickedUploadProblem({ name: "q.docx", uri: "u", size: 10, mimeType: null })).toMatch(/can't be uploaded here/);
    expect(pickedUploadProblem({ name: "p.pdf", uri: "u", size: big, mimeType: "application/pdf" })).toBe(fileTooBigMessage("p.pdf", big));
    expect(pickedUploadProblem({ name: "p.pdf", uri: "u", size: null, mimeType: null })).toBeNull();
    expect(pickedUploadProblem({ name: "p.jpg", uri: "u", size: big * 3, mimeType: "image/jpeg" })).toBeNull();
    expect(fileTooBigMessage("p.pdf", 5 * 1024 * 1024)).toBe("p.pdf is 5.0 MB — the phone can send 3.0 MB at most. Upload it on the website instead.");
  });

  it("names the upload by the typed label, else the original, with the bytes' extension", () => {
    expect(pickedBaseName("Plan sheet 2.pdf")).toBe("Plan sheet 2");
    expect(uploadFileName("", "Plan sheet 2.pdf", "pdf")).toBe("Plan sheet 2.pdf");
    expect(uploadFileName(" Permit ", "x.pdf", "pdf")).toBe("Permit.pdf");
    expect(uploadFileName("", "IMG_1.HEIC", "jpeg")).toBe("IMG_1.jpg");
    expect(uploadFileName("", ".pdf", "pdf")).toBe("file.pdf");
    expect(uploadFileName("a/b:c", "x.pdf", "pdf")).toBe("abc.pdf");
  });
});

describe("the native module", () => {
  it("is available when it loads, and opens with the given types, copying to the cache", async () => {
    expect(documentPickerAvailable()).toBe(true);
    mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [{ name: "a.pdf", uri: "file:///a.pdf", size: 9, mimeType: "application/pdf" }] });
    await expect(pickDocuments({ types: UPLOAD_PICKER_TYPES })).resolves.toEqual([{ name: "a.pdf", uri: "file:///a.pdf", size: 9, mimeType: "application/pdf" }]);
    expect(mockGetDocumentAsync).toHaveBeenCalledWith({ type: UPLOAD_PICKER_TYPES, multiple: false, copyToCacheDirectory: true });
  });

  it("is unavailable (and picking says why) on a binary without it", async () => {
    mockNativeMissing = true;
    expect(documentPickerAvailable()).toBe(false);
    await expect(pickDocuments()).rejects.toThrow(/latest version of the app/);
    await expect(pickUploadFile()).resolves.toEqual({ ok: false, error: expect.stringMatching(/latest version of the app/) });
  });
});

describe("readPickedForUpload", () => {
  it("sends a PDF as it is and clears the cache copy", async () => {
    mockRead.mockResolvedValue(PDF);
    const r = await readPickedForUpload({ name: "Plan.pdf", uri: "file:///c/Plan.pdf", size: 128, mimeType: "application/pdf" });
    expect(r).toEqual({ ok: true, upload: { originalName: "Plan.pdf", base64: PDF, bytes: base64ByteLength(PDF), kind: "pdf" } });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith("file:///c/Plan.pdf", { idempotent: true });
  });

  it("shrinks a photo to a JPEG first", async () => {
    mockPrepare.mockResolvedValue({ uri: "x", width: 1, height: 1, base64: JPEG });
    const r = await readPickedForUpload({ name: "IMG.HEIC", uri: "file:///c/IMG.HEIC", size: 9e6, mimeType: "image/heic" });
    expect(r.ok && r.upload.kind).toBe("jpeg");
    expect(mockPrepare).toHaveBeenCalledWith("file:///c/IMG.HEIC", { base64: true });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("refuses a file whose bytes aren't a PDF or photo (a renamed Word file)", async () => {
    mockRead.mockResolvedValue(DOCX);
    const r = await readPickedForUpload({ name: "fake.pdf", uri: "u", size: 10, mimeType: "application/pdf" });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/can't be uploaded here/) });
  });

  it("refuses a PDF that turns out too big once read", async () => {
    mockRead.mockResolvedValue(PDF);
    const r = await readPickedForUpload({ name: "Plan.pdf", uri: "u", size: null, mimeType: null }, 50);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^Plan.pdf is .* at most\. Upload it on the website instead\.$/) });
  });

  it("says so when the file can't be read", async () => {
    mockRead.mockRejectedValue(new Error("EACCES"));
    const r = await readPickedForUpload({ name: "Plan.pdf", uri: "u", size: 10, mimeType: null });
    expect(r).toEqual({ ok: false, error: "Plan.pdf couldn't be read. Try choosing it again." });
  });
});

describe("pickUploadFile", () => {
  it("is null when cancelled", async () => {
    mockGetDocumentAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickUploadFile()).resolves.toBeNull();
  });

  it("reads the one file picked", async () => {
    mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [{ name: "Inv.pdf", uri: "file:///Inv.pdf", size: 128, mimeType: "application/pdf" }] });
    mockRead.mockResolvedValue(PDF);
    const r = await pickUploadFile();
    expect(r && r.ok && r.upload.originalName).toBe("Inv.pdf");
  });

  it("turns a picker failure into a sentence", async () => {
    mockGetDocumentAsync.mockRejectedValue(new Error("Different document picking in progress."));
    await expect(pickUploadFile()).resolves.toEqual({ ok: false, error: "Different document picking in progress." });
  });
});
