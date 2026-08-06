// A missing native module must cost background SYNC, never the whole app.
//
// THE SAME BUG, THE SECOND TIME. backgroundClockTask.ts was fixed with a guarded
// require after a static `import * as TaskManager from "expo-task-manager"` took
// the entire app down to a red screen on any build lacking the native module,
// and backgroundClockTask.guard.test.ts pins that fix.
//
// backgroundSync.ts was then added AFTERWARDS with the same static imports and
// no guard:
//
//     import * as BackgroundFetch from "expo-background-fetch";
//     import * as TaskManager from "expo-task-manager";
//
// It is reached from app/_layout.tsx by the same route — _layout imports
// location-tracking, which imports backgroundSync — so the crash is identical
// and equally fatal. Every unit test passed while that was true, because jest
// resolves the JS package happily; only a real launch reveals it.
//
// This file exists so the guard is a contract for BOTH task modules rather than
// a lesson that has to be relearned each time one is added.

describe("backgroundSync registration", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    jest.resetModules();
    warn.mockClear();
  });

  afterAll(() => warn.mockRestore());

  function mockEverythingExceptTheNativeModules() {
    jest.doMock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));
    jest.doMock("./data/outbox/sqliteStore", () => ({ SqliteOutboxStore: { open: jest.fn() } }));
    jest.doMock("./data/createDataLayer", () => ({ createDataLayer: jest.fn() }));
    jest.doMock("./data/gateway.supabase", () => ({ supabaseGateway: {}, apiBridge: {} }));
    jest.doMock("./data/net/connectivity", () => ({ netInfoConnectivity: {} }));
  }

  it("imports WITHOUT THROWING when expo-task-manager is missing", () => {
    jest.doMock("expo-task-manager", () => {
      throw new Error("Cannot find native module 'ExpoTaskManager'");
    });
    jest.doMock("expo-background-fetch", () => ({
      BackgroundFetchResult: { NoData: 1, NewData: 2, Failed: 3 },
      registerTaskAsync: jest.fn(),
      unregisterTaskAsync: jest.fn(),
    }));
    mockEverythingExceptTheNativeModules();

    // The assertion IS that this does not throw. If it does, the app shows a red
    // screen on launch instead of merely losing background draining.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./backgroundSync");
    }).not.toThrow();
  });

  it("imports WITHOUT THROWING when expo-background-fetch is missing", () => {
    jest.doMock("expo-background-fetch", () => {
      throw new Error("Cannot find native module 'ExpoBackgroundFetch'");
    });
    jest.doMock("expo-task-manager", () => ({ defineTask: jest.fn(), isTaskRegisteredAsync: jest.fn() }));
    mockEverythingExceptTheNativeModules();

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./backgroundSync");
    }).not.toThrow();
  });

  it("says plainly that background sync is off, rather than failing silently", () => {
    jest.doMock("expo-task-manager", () => {
      throw new Error("Cannot find native module 'ExpoTaskManager'");
    });
    jest.doMock("expo-background-fetch", () => ({
      BackgroundFetchResult: { NoData: 1, NewData: 2, Failed: 3 },
      registerTaskAsync: jest.fn(),
      unregisterTaskAsync: jest.fn(),
    }));
    mockEverythingExceptTheNativeModules();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./backgroundSync");

    // A silent degradation here means queued writes wait for someone to reopen
    // the app and nobody knows why.
    const said = warn.mock.calls.flat().join(" ");
    expect(said).toMatch(/background sync/i);
  });

  it("startBackgroundSync resolves false instead of rejecting when the module is absent", async () => {
    jest.doMock("expo-task-manager", () => {
      throw new Error("Cannot find native module 'ExpoTaskManager'");
    });
    jest.doMock("expo-background-fetch", () => ({
      BackgroundFetchResult: { NoData: 1, NewData: 2, Failed: 3 },
      registerTaskAsync: jest.fn(),
      unregisterTaskAsync: jest.fn(),
    }));
    mockEverythingExceptTheNativeModules();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./backgroundSync");

    // location-tracking calls this with .catch(), but an unhandled rejection in
    // React Native renders as a full-screen red box over a working app — the
    // very outcome the guard exists to prevent.
    await expect(mod.startBackgroundSync(true)).resolves.toBe(false);
  });
});
