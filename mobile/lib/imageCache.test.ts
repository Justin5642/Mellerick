const mockClearMemory = jest.fn();
const mockClearDisk = jest.fn();
jest.mock("expo-image", () => ({
  Image: { clearMemoryCache: () => mockClearMemory(), clearDiskCache: () => mockClearDisk() },
}));

import { clearImageCaches } from "./imageCache";

// Job photos are cached on disk by storage path; sign-out must empty that cache
// without ever failing the sign-out itself.
describe("clearImageCaches", () => {
  it("clears both the memory and the disk cache", async () => {
    mockClearMemory.mockResolvedValue(true);
    mockClearDisk.mockResolvedValue(true);
    await clearImageCaches();
    expect(mockClearMemory).toHaveBeenCalled();
    expect(mockClearDisk).toHaveBeenCalled();
  });

  it("never throws", async () => {
    mockClearDisk.mockRejectedValue(new Error("io"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(clearImageCaches()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
