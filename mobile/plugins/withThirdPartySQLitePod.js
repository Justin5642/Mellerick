const { withPodfileProperties } = require("@expo/config-plugins");

// expo-updates bundles its own copy of SQLite on iOS. This app ALSO links
// @op-engineering/op-sqlite (via PowerSync) and expo-sqlite (the outbox
// store), each of which bundles/compiles its own sqlite3 symbols too. With
// three native SQLite engines in one binary, iOS can end up resolving a
// sqlite3_* symbol call into the wrong engine's compiled copy instead of
// throwing a link error — which is exactly the kind of fault that stays
// invisible in a debug/dev-client build (where expo-updates' native runtime
// isn't fully engaged the same way) and only surfaces as a hard native crash
// in a release/TestFlight build, at the moment op-sqlite's engine is first
// exercised for real (i.e. right after login, when PowerSync connects).
//
// This is a documented op-sqlite + expo-updates conflict; the fix is to tell
// expo-updates to defer to a third-party SQLite pod instead of bundling its
// own. See https://github.com/OP-Engineering/op-sqlite/issues/214 and
// https://github.com/expo/expo/issues/33644.
//
// This has to be injected via a config plugin (rather than hand-edited into
// ios/Podfile.properties.json) because that file lives inside the gitignored,
// locally-generated ios/ folder — EAS Build's cloud servers run `expo
// prebuild` fresh from app.json on every build, so anything not expressed as
// config here is silently lost.
const withThirdPartySQLitePod = (config) => {
  return withPodfileProperties(config, (config) => {
    config.modResults = {
      ...config.modResults,
      "expo.updates.useThirdPartySQLitePod": "true",
    };
    return config;
  });
};

module.exports = withThirdPartySQLitePod;
