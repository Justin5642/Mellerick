// @testing-library/react-native v14 auto-registers its jest matchers — no
// extend-expect import needed.

// Silence the NativeWind/reanimated warnings that are irrelevant to unit tests.
jest.mock("react-native-reanimated", () => {
  const Reanimated = require("react-native-reanimated/mock");
  Reanimated.default.call = () => {};
  return Reanimated;
});

// The Sentry SDK is a native module; no unit test may load it. This stand-in
// records calls so lib/monitoring tests can assert what WOULD be sent.
jest.mock("@sentry/react-native", () => ({
  init: jest.fn(),
  wrap: jest.fn((component: unknown) => component),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
