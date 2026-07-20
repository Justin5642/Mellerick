// Babel config for the Expo app. Adds NativeWind's jsxImportSource so
// `className` works on RN components, and the Reanimated plugin (required by
// NativeWind transitions/dark variants and all motion) — which MUST be last.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    plugins: ["react-native-reanimated/plugin"],
  };
};
