// The resize helper every picker/camera path goes through. The native
// manipulator is mocked: each test describes the image the platform loader would
// decode (already EXIF-rotated, as the real loader returns it) and asserts what
// is asked of the context and the encoder.
const mockSave = jest.fn();
const mockResize = jest.fn();
let mockDims: { width: number; height: number }[] = [];
const mockManipulate = jest.fn();

jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
  ImageManipulator: { manipulate: (...args: unknown[]) => mockManipulate(...args) },
}));

import { JPEG_QUALITY, MAX_EDGE_PX, prepareImage, prepareImageForUpload } from "./imageUpload";

function stubImage(...renders: { width: number; height: number }[]) {
  mockDims = [...renders];
  const ctx = {
    resize: mockResize.mockImplementation(() => ctx),
    renderAsync: jest.fn(async () => {
      const dims = mockDims.shift();
      if (!dims) throw new Error("unexpected extra render");
      return {
        ...dims,
        saveAsync: (opts: unknown) => mockSave(dims, opts),
      };
    }),
  };
  mockManipulate.mockReturnValue(ctx);
  return ctx;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockImplementation(async (dims: { width: number; height: number }, opts: { base64?: boolean }) => ({
    uri: "file:///cache/out.jpg",
    width: dims.width,
    height: dims.height,
    ...(opts.base64 ? { base64: "QUJD" } : {}),
  }));
});

describe("prepareImage", () => {
  it("caps the longest edge of a landscape photo at MAX_EDGE_PX, preserving ratio", async () => {
    stubImage({ width: 4032, height: 3024 }, { width: 1600, height: 1200 });
    const out = await prepareImage("file:///picker/a.jpg");
    expect(mockManipulate).toHaveBeenCalledWith("file:///picker/a.jpg");
    expect(mockResize).toHaveBeenCalledWith({ width: MAX_EDGE_PX });
    expect(mockSave).toHaveBeenCalledWith({ width: 1600, height: 1200 }, { format: "jpeg", compress: JPEG_QUALITY, base64: false });
    expect(out).toEqual({ uri: "file:///cache/out.jpg", width: 1600, height: 1200 });
  });

  it("measures orientation on the decoded (EXIF-rotated) image: a portrait shot is capped on its height", async () => {
    // A phone held upright: sensor data is 4032x3024 with an orientation tag;
    // the loader hands back the upright 3024x4032 image.
    stubImage({ width: 3024, height: 4032 }, { width: 1200, height: 1600 });
    const out = await prepareImage("file:///picker/p.jpg");
    expect(mockResize).toHaveBeenCalledWith({ height: MAX_EDGE_PX });
    expect(out.width).toBeLessThan(out.height);
  });

  it("never upscales a small image, but still re-encodes it at JPEG_QUALITY", async () => {
    stubImage({ width: 1080, height: 1440 });
    const out = await prepareImage("file:///shot/v.jpg");
    expect(mockResize).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith({ width: 1080, height: 1440 }, { format: "jpeg", compress: JPEG_QUALITY, base64: false });
    expect(out).toEqual({ uri: "file:///cache/out.jpg", width: 1080, height: 1440 });
  });

  it("an image exactly at the cap is not resized", async () => {
    stubImage({ width: 1600, height: 900 });
    await prepareImage("file:///x.jpg");
    expect(mockResize).not.toHaveBeenCalled();
  });

  it("returns base64 of the RESIZED image only when asked (data-plate scan)", async () => {
    stubImage({ width: 4000, height: 3000 }, { width: 1600, height: 1200 });
    const out = await prepareImage("file:///plate.jpg", { base64: true });
    expect(mockSave).toHaveBeenCalledWith({ width: 1600, height: 1200 }, { format: "jpeg", compress: JPEG_QUALITY, base64: true });
    expect(out.base64).toBe("QUJD");
  });

  it("propagates a decode failure (the scan has no fallback image to send)", async () => {
    mockManipulate.mockImplementation(() => {
      throw new Error("cannot decode");
    });
    await expect(prepareImage("file:///bad.heic")).rejects.toThrow("cannot decode");
  });
});

describe("prepareImageForUpload", () => {
  it("returns the resized local file", async () => {
    stubImage({ width: 4032, height: 3024 }, { width: 1600, height: 1200 });
    await expect(prepareImageForUpload("file:///picker/a.jpg")).resolves.toBe("file:///cache/out.jpg");
  });

  it("falls back to the ORIGINAL file if resizing fails — a photo is never lost", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockManipulate.mockImplementation(() => {
      throw new Error("decoder fault");
    });
    await expect(prepareImageForUpload("file:///picker/odd.jpg")).resolves.toBe("file:///picker/odd.jpg");
    warn.mockRestore();
  });
});
