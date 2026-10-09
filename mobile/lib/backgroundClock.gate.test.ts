// The native edge of the tracking gate: what backgroundClock.ts hands to
// expo-location, when it restarts the task, how often it asks for "Always",
// and the stop check the background task runs on its own when headless.
// expo-location is a fake that records calls; nothing here needs a device.

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3 },
  GeofencingEventType: { Enter: 1, Exit: 2 },
  hasStartedGeofencingAsync: jest.fn(),
  startGeofencingAsync: jest.fn(),
  stopGeofencingAsync: jest.fn(),
  ActivityType: { Other: 1, AutomotiveNavigation: 2 },
  getForegroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
}));
jest.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItem: jest.fn(async (k: string) => store.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    removeItem: jest.fn(async (k: string) => void store.delete(k)),
    multiRemove: jest.fn(async (ks: string[]) => ks.forEach((k) => store.delete(k))),
  };
});

import {
  PUBLISHED_VERDICT_TTL_MS,
  backgroundTrackingDecision,
  parsePublishedVerdict,
  handleSiteWake,
  resetBackgroundClockForTests,
  startBackgroundClock,
  startSiteWake,
  stopBackgroundClock,
  toLocationOptions,
  type BackgroundGateDeps,
  type SiteWakeDeps,
} from "./backgroundClock";
import { trackingSettings } from "./trackingGate";
import type { TrackedSite } from "./geofenceState";

const mockLocation = require("expo-location") as Record<string, jest.Mock>;

const SITE: TrackedSite = { jobId: "job-a", lat: -37.81, lng: 144.96, scheduledCostCenterId: null };
const granted = { status: "granted" };

beforeEach(() => {
  jest.clearAllMocks();
  resetBackgroundClockForTests();
  (require("@react-native-async-storage/async-storage").__store as Map<string, string>).clear();
  let geofencing = false;
  mockLocation.hasStartedGeofencingAsync.mockImplementation(async () => geofencing);
  mockLocation.startGeofencingAsync.mockImplementation(async () => {
    geofencing = true;
  });
  mockLocation.stopGeofencingAsync.mockImplementation(async () => {
    geofencing = false;
  });
  mockLocation.getForegroundPermissionsAsync.mockResolvedValue(granted);
  mockLocation.requestBackgroundPermissionsAsync.mockResolvedValue(granted);
  mockLocation.getBackgroundPermissionsAsync.mockResolvedValue(granted);
  let running = false;
  mockLocation.hasStartedLocationUpdatesAsync.mockImplementation(async () => running);
  mockLocation.startLocationUpdatesAsync.mockImplementation(async () => {
    running = true;
  });
  mockLocation.stopLocationUpdatesAsync.mockImplementation(async () => {
    running = false;
  });
});

describe("toLocationOptions", () => {
  it("maps a gate profile onto expo-location, pause off", () => {
    expect(toLocationOptions(trackingSettings("on-the-clock", true))).toEqual({
      accuracy: 3,
      timeInterval: 15_000,
      distanceInterval: 25,
      deferredUpdatesInterval: 60_000,
      deferredUpdatesDistance: 0,
      activityType: 1,
      pausesUpdatesAutomatically: false,
    });
    expect(toLocationOptions(trackingSettings("on-the-clock", false)).activityType).toBe(2);
  });
});

describe("startBackgroundClock", () => {
  it("starts with the profile's options and a foreground-service notification", async () => {
    await expect(startBackgroundClock(trackingSettings("watching", false))).resolves.toBe(true);
    const [, options] = mockLocation.startLocationUpdatesAsync.mock.calls[0];
    expect(options).toMatchObject({ timeInterval: 30_000, pausesUpdatesAutomatically: false });
    expect(options.foregroundService.notificationTitle).toBeTruthy();
  });

  it("is a no-op for the same profile, and retunes the running task for a new one", async () => {
    await startBackgroundClock(trackingSettings("watching", false));
    await startBackgroundClock(trackingSettings("watching", false));
    expect(mockLocation.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);

    await startBackgroundClock(trackingSettings("on-the-clock", false));
    expect(mockLocation.startLocationUpdatesAsync).toHaveBeenCalledTimes(2);
    expect(mockLocation.startLocationUpdatesAsync.mock.calls[1][1]).toMatchObject({ timeInterval: 15_000 });
  });

  it("asks for 'Always' once per session, then only reads it — the gate re-runs every few minutes", async () => {
    await startBackgroundClock(trackingSettings("watching", false));
    await stopBackgroundClock();
    await startBackgroundClock(trackingSettings("watching", false));
    expect(mockLocation.requestBackgroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockLocation.getBackgroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it("reports false when 'Always' is declined, without starting — the foreground watcher carries on", async () => {
    mockLocation.requestBackgroundPermissionsAsync.mockResolvedValue({ status: "denied" });
    await expect(startBackgroundClock(trackingSettings("watching", false))).resolves.toBe(false);
    expect(mockLocation.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it("stop stops the task (and so the Android foreground service), and a later start really restarts", async () => {
    await startBackgroundClock(trackingSettings("watching", false));
    await stopBackgroundClock();
    expect(mockLocation.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    await startBackgroundClock(trackingSettings("watching", false));
    expect(mockLocation.startLocationUpdatesAsync).toHaveBeenCalledTimes(2);
  });
});

describe("backgroundTrackingDecision (headless stop check)", () => {
  // Monday 2026-10-05, device-local.
  const DAY = new Date(2026, 9, 5, 10, 0);
  const NIGHT = new Date(2026, 9, 5, 22, 0);

  function gateDeps(over: Partial<BackgroundGateDeps> = {}): BackgroundGateDeps {
    return {
      readStaffId: jest.fn().mockResolvedValue("tech-1"),
      readSites: jest.fn().mockResolvedValue([SITE]),
      readInside: jest.fn().mockResolvedValue(null),
      readPendingDeparture: jest.fn().mockResolvedValue(null),
      readOnTheClock: jest.fn().mockResolvedValue(false),
      readSiteWakeAt: jest.fn().mockResolvedValue(null),
      ...over,
    };
  }

  it("continues inside work hours", async () => {
    expect((await backgroundTrackingDecision(gateDeps(), DAY)).track).toBe(true);
  });

  it("stops off hours when nothing says the technician is working — reason off-hours keeps the wake regions", async () => {
    expect(await backgroundTrackingDecision(gateDeps(), NIGHT)).toEqual({ track: false, reason: "off-hours" });
    expect((await backgroundTrackingDecision(gateDeps(), NIGHT)).track).toBe(false);
  });

  it("continues off hours while the foreground said on the clock", async () => {
    expect((await backgroundTrackingDecision(gateDeps({ readOnTheClock: jest.fn().mockResolvedValue(true) }), NIGHT)).track).toBe(true);
  });

  it("decides from its own state when no current verdict exists — a frozen 'yes' must not hold GPS on all night", async () => {
    expect((await backgroundTrackingDecision(gateDeps({ readOnTheClock: jest.fn().mockResolvedValue(null) }), NIGHT)).track).toBe(false);
    expect((await backgroundTrackingDecision(gateDeps({ readOnTheClock: jest.fn().mockResolvedValue(null) }), DAY)).track).toBe(true);
  });

  it("continues off hours while its OWN state has us on site or mid-drive, even against a stale 'off' verdict", async () => {
    expect((await backgroundTrackingDecision(gateDeps({ readInside: jest.fn().mockResolvedValue("job-a") }), NIGHT)).track).toBe(true);
    const departure = { jobId: "job-a", at: new Date(NIGHT.getTime() - 30 * 60_000).toISOString() };
    expect(
      (await backgroundTrackingDecision(gateDeps({ readPendingDeparture: jest.fn().mockResolvedValue(departure) }), NIGHT)).track
    ).toBe(true);
  });

  it("continues off hours for a while after a site wake, so the arrival can land", async () => {
    const wake = new Date(NIGHT.getTime() - 5 * 60_000).toISOString();
    expect((await backgroundTrackingDecision(gateDeps({ readSiteWakeAt: jest.fn().mockResolvedValue(wake) }), NIGHT)).track).toBe(true);
    const stale = new Date(NIGHT.getTime() - 60 * 60_000).toISOString();
    expect((await backgroundTrackingDecision(gateDeps({ readSiteWakeAt: jest.fn().mockResolvedValue(stale) }), NIGHT)).track).toBe(false);
  });

  it("stops when signed out or the site list is empty", async () => {
    expect((await backgroundTrackingDecision(gateDeps({ readStaffId: jest.fn().mockResolvedValue(null) }), DAY)).track).toBe(false);
    expect((await backgroundTrackingDecision(gateDeps({ readSites: jest.fn().mockResolvedValue([]) }), DAY)).track).toBe(false);
  });
});

describe("startSiteWake", () => {
  it("registers the sites as wider wake regions, enter-only", async () => {
    await expect(startSiteWake([SITE])).resolves.toBe(true);
    expect(mockLocation.startGeofencingAsync).toHaveBeenCalledWith("mellerick-site-wake", [
      { identifier: "job-a", latitude: -37.81, longitude: 144.96, radius: 300, notifyOnEnter: true, notifyOnExit: false },
    ]);
  });

  it("does not re-register identical regions — each registration re-fires Enter for a region the phone is already in", async () => {
    await startSiteWake([SITE]);
    await startSiteWake([SITE]);
    expect(mockLocation.startGeofencingAsync).toHaveBeenCalledTimes(1);
    await startSiteWake([SITE, { ...SITE, jobId: "job-b", lat: -37.9 }]);
    expect(mockLocation.startGeofencingAsync).toHaveBeenCalledTimes(2);
  });

  it("needs 'Always' and never prompts for it", async () => {
    mockLocation.getBackgroundPermissionsAsync.mockResolvedValue({ status: "denied" });
    await expect(startSiteWake([SITE])).resolves.toBe(false);
    expect(mockLocation.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(mockLocation.startGeofencingAsync).not.toHaveBeenCalled();
  });

  it("unregisters when there are no sites", async () => {
    await startSiteWake([SITE]);
    await expect(startSiteWake([])).resolves.toBe(false);
    expect(mockLocation.stopGeofencingAsync).toHaveBeenCalledTimes(1);
  });
});

describe("handleSiteWake", () => {
  const NOW = new Date(2026, 9, 5, 22, 0);
  function wakeDeps(over: Partial<SiteWakeDeps> = {}): SiteWakeDeps & { [K in keyof SiteWakeDeps]: jest.Mock } {
    return {
      isTracking: jest.fn().mockResolvedValue(false),
      readStaffId: jest.fn().mockResolvedValue("tech-1"),
      writeSiteWakeAt: jest.fn().mockResolvedValue(undefined),
      startTracking: jest.fn().mockResolvedValue(true),
      ...over,
    } as SiteWakeDeps & { [K in keyof SiteWakeDeps]: jest.Mock };
  }

  it("on Enter while stopped: stamps the wake BEFORE restarting, in the between-sites profile", async () => {
    const order: string[] = [];
    const d = wakeDeps({
      writeSiteWakeAt: jest.fn(async () => void order.push("stamp")),
      startTracking: jest.fn(async () => (order.push("start"), true)),
    });
    await handleSiteWake(1, d, NOW);
    // Stamped first, so the headless stop check cannot see a running task with
    // no reason to run and switch it straight back off.
    expect(order).toEqual(["stamp", "start"]);
    expect(d.writeSiteWakeAt).toHaveBeenCalledWith(NOW.toISOString());
    expect(d.startTracking.mock.calls[0][0]).toMatchObject({ timeIntervalMs: 15_000, deferredUpdatesIntervalMs: 0 });
  });

  it("does nothing while tracking is already running, on Exit, or when signed out", async () => {
    const running = wakeDeps({ isTracking: jest.fn().mockResolvedValue(true) });
    await handleSiteWake(1, running, NOW);
    const exit = wakeDeps();
    await handleSiteWake(2, exit, NOW);
    const signedOut = wakeDeps({ readStaffId: jest.fn().mockResolvedValue(null) });
    await handleSiteWake(1, signedOut, NOW);
    for (const d of [running, exit, signedOut]) {
      expect(d.writeSiteWakeAt).not.toHaveBeenCalled();
      expect(d.startTracking).not.toHaveBeenCalled();
    }
  });
});

describe("parsePublishedVerdict", () => {
  const NOW = Date.parse("2026-10-05T12:00:00.000Z");
  const raw = (onTheClock: unknown, msAgo: number) =>
    JSON.stringify({ onTheClock, at: new Date(NOW - msAgo).toISOString() });

  it("returns the verdict while it is current", () => {
    expect(parsePublishedVerdict(raw(true, 60_000), NOW)).toBe(true);
    expect(parsePublishedVerdict(raw(false, 60_000), NOW)).toBe(false);
  });

  it("expires it — the foreground stops republishing once the app is swiped away", () => {
    expect(parsePublishedVerdict(raw(true, PUBLISHED_VERDICT_TTL_MS), NOW)).toBeNull();
    expect(PUBLISHED_VERDICT_TTL_MS).toBe(15 * 60_000);
  });

  it("keeps a future-stamped verdict (clock moved back) and drops anything corrupt", () => {
    expect(parsePublishedVerdict(raw(true, -60 * 60_000), NOW)).toBe(true);
    expect(parsePublishedVerdict(null, NOW)).toBeNull();
    expect(parsePublishedVerdict("1", NOW)).toBeNull();
    expect(parsePublishedVerdict("{nope", NOW)).toBeNull();
    expect(parsePublishedVerdict(raw("yes", 0), NOW)).toBeNull();
  });
});
