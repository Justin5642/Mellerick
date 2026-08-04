// A missing native module must cost background tracking, never the whole app.
//
// THE BUG THIS PINS, found by launching the app rather than by any test:
// backgroundClockTask.ts is imported for its SIDE EFFECT at the very top of
// app/_layout.tsx, so that the OS can relaunch straight into the background task
// with no UI. It used to do `import * as TaskManager from "expo-task-manager"`,
// which throws at module load when the native module is absent. On the existing
// dev client — compiled before the dependency was added — that threw during
// startup and took the ENTIRE APP down to a red screen:
//
//     Uncaught Error: Cannot find native module 'ExpoTaskManager'
//
// All 430 unit tests passed while that was true, because jest resolves the JS
// package happily; only a real launch revealed it. The same would happen in Expo
// Go, or in any build where the native module did not make it in.
//
// So the registration is a guarded require, and this test makes the guard a
// contract rather than a comment.

describe("backgroundClockTask registration", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    jest.resetModules();
    warn.mockClear();
  });

  afterAll(() => warn.mockRestore());

  it("imports WITHOUT THROWING when the native module is missing", () => {
    jest.doMock("expo-task-manager", () => {
      throw new Error("Cannot find native module 'ExpoTaskManager'");
    });
    jest.doMock("./supabase", () => ({ supabase: {} }));
    jest.doMock("expo-location", () => ({}));
    jest.doMock("@react-native-async-storage/async-storage", () => ({
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      multiRemove: jest.fn(),
    }));

    // The assertion IS that this does not throw. If it does, the app shows a
    // red screen on launch instead of merely losing background tracking.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./backgroundClockTask");
    }).not.toThrow();
  });

  it("says plainly that background tracking is off, rather than failing silently", () => {
    jest.doMock("expo-task-manager", () => {
      throw new Error("Cannot find native module 'ExpoTaskManager'");
    });
    jest.doMock("./supabase", () => ({ supabase: {} }));
    jest.doMock("expo-location", () => ({}));
    jest.doMock("@react-native-async-storage/async-storage", () => ({
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      multiRemove: jest.fn(),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./backgroundClockTask");

    const said = warn.mock.calls.flat().join(" ");
    expect(said).toMatch(/background tracking is OFF/i);
    // The consequence matters more than the cause: someone reading this log
    // needs to know hours are affected, not just that a module is missing.
    expect(said).toMatch(/only be recorded while the app is open/i);
  });

  it("registers the task when the native module IS available", () => {
    const defineTask = jest.fn();
    jest.doMock("expo-task-manager", () => ({ defineTask }));
    jest.doMock("./supabase", () => ({ supabase: {} }));
    jest.doMock("expo-location", () => ({}));
    jest.doMock("@react-native-async-storage/async-storage", () => ({
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      multiRemove: jest.fn(),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./backgroundClockTask");

    expect(defineTask).toHaveBeenCalledTimes(1);
    expect(defineTask.mock.calls[0][0]).toBe("mellerick-background-clock");
  });
});
