import AsyncStorage from "@react-native-async-storage/async-storage";
import { shouldPopUp, markSeen, seenKey } from "./schedule-note-banner";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("schedule note pop-up (per booking)", () => {
  it("pops up for a note never seen on this device", async () => {
    await expect(shouldPopUp("booking-1", "Bring the long ladder")).resolves.toBe(true);
  });

  it("does not pop up again once dismissed", async () => {
    await markSeen("booking-1", "Bring the long ladder");
    await expect(shouldPopUp("booking-1", "Bring the long ladder")).resolves.toBe(false);
  });

  it("pops up again when the booking's note is edited", async () => {
    await markSeen("booking-1", "Bring the long ladder");
    await expect(shouldPopUp("booking-1", "Bring the long ladder and the jetter")).resolves.toBe(true);
  });

  it("tracks each booking separately, even with the same text", async () => {
    await markSeen("booking-1", "Bring the long ladder");
    await expect(shouldPopUp("booking-2", "Bring the long ladder")).resolves.toBe(true);
    expect(seenKey("booking-1")).not.toBe(seenKey("booking-2"));
  });

  it("does not nag when storage is unavailable", async () => {
    jest.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("unavailable"));
    await expect(shouldPopUp("booking-1", "Bring the long ladder")).resolves.toBe(false);
  });
});
