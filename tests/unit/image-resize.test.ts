import { describe, it, expect } from "vitest";
import { fitWithin, MAX_EDGE_PX } from "@/lib/image-resize";
import { getCachedSignedUrl, putCachedSignedUrl, clearSignedUrlCache } from "@/lib/signed-url-cache";

describe("fitWithin — the web upload resize matches mobile's 1600px long edge", () => {
  it("shrinks a landscape phone photo to 1600 on the long edge, keeping the ratio", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: MAX_EDGE_PX, height: 1200 });
  });

  it("shrinks a portrait photo by its height", () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: MAX_EDGE_PX });
  });

  it("never upscales a small image", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("signed URL cache — revisiting the Photos tab reuses URLs", () => {
  it("returns a cached URL until shortly before it expires", () => {
    clearSignedUrlCache();
    const t0 = 1_000_000;
    putCachedSignedUrl("job-photos", "j/a.jpg", "https://signed/a", 3600, t0);
    expect(getCachedSignedUrl("job-photos", "j/a.jpg", t0 + 10 * 60_000)).toBe("https://signed/a");
    // Inside the 5-minute safety margin: re-sign rather than hand out a URL
    // that may die while the user is looking at it.
    expect(getCachedSignedUrl("job-photos", "j/a.jpg", t0 + 56 * 60_000)).toBeNull();
  });

  it("keys by bucket as well as path", () => {
    clearSignedUrlCache();
    putCachedSignedUrl("job-photos", "x", "u1", 3600, 0);
    expect(getCachedSignedUrl("job-documents", "x", 0)).toBeNull();
  });
});
