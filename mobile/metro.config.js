// Metro config — this app lives nested inside the main Next.js repo but is
// NOT an npm workspace of it: mobile/ has its own package.json, its own
// lockfile, and its own self-contained node_modules (including its own copy
// of react).
//
// HISTORY: a previous session set `resolver.disableHierarchicalLookup = true`
// here, theorizing that Metro was climbing up into the parent repo's
// ../node_modules and picking up a second, mismatched copy of react (two
// live React copies in one bundle can silently break hooks/state updates —
// e.g. auth state stuck on a loading spinner forever).
//
// REVERTED (this session): that override actually broke bundling outright —
// `npx expo export` failed with "Unable to resolve module
// expo-router/entry-classic", because expo-router's own entry.js resolves
// itself via a self-reference import (`import 'expo-router/entry-classic'`
// from inside expo-router's own entry.js) that depends on normal
// hierarchical/self-reference resolution. With the override in place the
// app never bundled at all — which is what was actually behind the "mobile
// app is frozen" report, not the original React-duplicate theory. Confirmed
// via `getDefaultConfig(__dirname)`: `watchFolders`/`nodeModulesPaths` are
// already empty (scoped to this project only) by default, and there's no
// nested react copy inside mobile/node_modules/**, so the original
// duplicate-react scenario doesn't appear to reproduce with today's
// dependency tree anyway. Leaving Metro on Expo's default config.
// https://docs.expo.dev/versions/v54.0.0/config/metro/
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// `npx expo-doctor` still flags a real duplicate: the parent repo's
// ../node_modules/react (19.2.4) sits alongside this project's own
// node_modules/react (19.1.0). Rather than the blanket
// `disableHierarchicalLookup` used previously (which broke bundling
// entirely, see git history), pin just the `react` specifier so it always
// resolves to this project's own copy no matter which nested dependency
// asks for it. Everything else keeps Metro's normal resolution, so
// self-referencing packages like expo-router (which imports
// "expo-router/entry-classic" from within its own entry.js) keep working.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  react: path.resolve(__dirname, "node_modules/react"),
};

// NativeWind: processes global.css (Tailwind directives) into RN styles at
// build time. Wraps — does not replace — the react-pin config above.
module.exports = withNativeWind(config, { input: "./global.css" });
