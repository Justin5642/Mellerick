import AsyncStorage from "@react-native-async-storage/async-storage";
import { shouldPopUp, markSeen, seenKey } from "./schedule-note-banner";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
jest.mock("../../lib/supabase", () => ({ supabase: {} }));

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("schedule note pop-up", () => {
  it("pops up for a note never seen on this device", async () => {
    await expect(shouldPopUp("job-1", "2026-10-08T01:00:00Z")).resolves.toBe(true);
  });

  it("does not pop up again once dismissed", async () => {
    await markSeen("job-1", "2026-10-08T01:00:00Z");
    await expect(shouldPopUp("job-1", "2026-10-08T01:00:00Z")).resolves.toBe(false);
  });

  it("pops up again when the job is rescheduled with a new note", async () => {
    await markSeen("job-1", "2026-10-08T01:00:00Z");
    await expect(shouldPopUp("job-1", "2026-10-09T03:00:00Z")).resolves.toBe(true);
  });

  it("tracks each job separately", async () => {
    await markSeen("job-1", "2026-10-08T01:00:00Z");
    await expect(shouldPopUp("job-2", "2026-10-08T01:00:00Z")).resolves.toBe(true);
    expect(seenKey("job-1")).not.toBe(seenKey("job-2"));
  });

  it("does not nag when storage is unavailable", async () => {
    jest.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("unavailable"));
    await expect(shouldPopUp("job-1", "2026-10-08T01:00:00Z")).resolves.toBe(false);
  });
});
