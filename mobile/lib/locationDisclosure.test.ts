jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DISCLOSURE_STORAGE_KEY,
  needsDisclosure,
  readDisclosureAccepted,
  recordDisclosureAccepted,
} from "./locationDisclosure";
import { DISCLOSURE_BODY, DISCLOSURE_POINTS } from "../components/LocationDisclosure";

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("needsDisclosure", () => {
  it("is required before any prompt on a fresh install", () => {
    expect(needsDisclosure({ acceptedOnDevice: false, foregroundGranted: false, backgroundGranted: false })).toBe(true);
  });

  it("is required when only foreground is granted — the background prompt is what the policy is about", () => {
    // Photos request foreground location for geotagging, so this is the common case.
    expect(needsDisclosure({ acceptedOnDevice: false, foregroundGranted: true, backgroundGranted: false })).toBe(true);
  });

  it("is not shown again once accepted on this device", () => {
    expect(needsDisclosure({ acceptedOnDevice: true, foregroundGranted: false, backgroundGranted: false })).toBe(false);
  });

  it("is not shown when both permissions are already granted — no prompt can follow", () => {
    expect(needsDisclosure({ acceptedOnDevice: false, foregroundGranted: true, backgroundGranted: true })).toBe(false);
  });
});

describe("disclosure storage", () => {
  it("starts unaccepted and remembers acceptance", async () => {
    expect(await readDisclosureAccepted()).toBe(false);
    await recordDisclosureAccepted();
    expect(await readDisclosureAccepted()).toBe(true);
    expect(await AsyncStorage.getItem(DISCLOSURE_STORAGE_KEY)).toBe("accepted");
  });

  it("treats unreadable storage as not accepted, so the screen is shown rather than skipped", async () => {
    jest.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("disk"));
    expect(await readDisclosureAccepted()).toBe(false);
  });
});

describe("disclosure wording (Google Play prominent-disclosure requirements)", () => {
  const text = [DISCLOSURE_BODY, ...DISCLOSURE_POINTS].join(" ").toLowerCase();

  it("names location as the data collected", () => {
    expect(text).toContain("location");
  });

  it("says it is collected when the app is closed or not in use", () => {
    expect(text).toContain("even when the app is closed or not in use");
  });

  it("says what it is used for", () => {
    expect(text).toContain("clock you in and out");
    expect(text).toContain("travel time");
  });
});

describe("the tracking gate asks for consent before any location prompt", () => {
  const src = readFileSync(join(__dirname, "location-tracking.tsx"), "utf8");
  const gate = src.slice(src.indexOf("async function applyGate()"));

  it("awaits the disclosure before starting either watcher", () => {
    const consent = gate.indexOf("await locationConsent()");
    expect(consent).toBeGreaterThan(-1);
    expect(consent).toBeLessThan(gate.indexOf("startForeground(settings)"));
    expect(consent).toBeLessThan(gate.indexOf("startBackgroundClock(settings)"));
  });
});
