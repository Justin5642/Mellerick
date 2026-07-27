// Jest config for the mobile app. jest-expo preset handles the RN/Expo
// transform; we widen transformIgnorePatterns so ESM deps (nativewind, lucide,
// reanimated, gorhom, etc.) are transpiled, and allow importing the web's
// lib/badge-colors.ts (outside mobile/) for the token parity guard.
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|nativewind|react-native-css-interop|lucide-react-native|react-native-reanimated|@gorhom/.*|moti|@shopify/flash-list))",
  ],
  moduleNameMapper: {
    "\\.(css)$": "<rootDir>/test/styleMock.js",
  },
};
