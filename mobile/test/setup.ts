// @testing-library/react-native v14 auto-registers its jest matchers — no
// extend-expect import needed.

// Silence the NativeWind/reanimated warnings that are irrelevant to unit tests.
jest.mock("react-native-reanimated", () => {
  const Reanimated = require("react-native-reanimated/mock");
  Reanimated.default.call = () => {};
  return Reanimated;
});
