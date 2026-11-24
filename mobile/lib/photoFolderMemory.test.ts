jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { lastPhotoFolder, rememberPhotoFolder } from "./photoFolderMemory";

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe("photo folder memory", () => {
  it("starts on Other and remembers the last folder per job", async () => {
    expect(await lastPhotoFolder("j1")).toBe("other");
    await rememberPhotoFolder("j1", "rough_in");
    await rememberPhotoFolder("j2", "camera_inspections");
    expect(await lastPhotoFolder("j1")).toBe("rough_in");
    expect(await lastPhotoFolder("j2")).toBe("camera_inspections");
    await rememberPhotoFolder("j1", "other");
    expect(await lastPhotoFolder("j1")).toBe("other");
  });

  it("ignores a stored value that is no longer a folder (e.g. a 0114 key)", async () => {
    await AsyncStorage.setItem("photoFolder:j1", "drainage");
    expect(await lastPhotoFolder("j1")).toBe("other");
  });

  it("never throws when storage does", async () => {
    jest.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("blocked"));
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("blocked"));
    await expect(rememberPhotoFolder("j1", "r1")).resolves.toBeUndefined();
    expect(await lastPhotoFolder("j1")).toBe("other");
  });
});
