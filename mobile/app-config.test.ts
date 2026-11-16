import { readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// The EAS project identity appears in THREE places in app.json, and nothing
// kept them in agreement.
//
//   expo.owner                — which Expo account owns the project
//   expo.extra.eas.projectId  — which project builds are attributed to
//   expo.updates.url          — https://u.expo.dev/<projectId>, where the app
//                               asks for OTA updates AT RUNTIME
//
// The last one is the hazard. `eas init` rewrites extra.eas.projectId; it does
// not reliably rewrite the id embedded in updates.url. Move the app to a
// different Expo account and you can end up with builds going to the new
// project while every installed device keeps asking the OLD project for
// updates.
//
// Nothing fails. The build succeeds, the app runs, and OTA updates simply never
// arrive — for a field app whose users are in basements, that is the update
// channel silently ceasing to exist with no error anywhere. It is the same
// shape as every other defect on this branch: an operation that reports success
// while doing nothing.
//
// Written BEFORE the account move rather than after, so the move is verified by
// something that was not built to agree with it.
// ============================================================================

type AppConfig = {
  expo: {
    owner?: string;
    slug?: string;
    updates?: { url?: string };
    extra?: { eas?: { projectId?: string } };
  };
};

const config = JSON.parse(readFileSync(join(__dirname, "app.json"), "utf8")) as AppConfig;

describe("EAS project identity is stated consistently", () => {
  it("declares an owner, a projectId and an updates url", () => {
    // Vacuity guard: every assertion below passes trivially against undefined.
    expect({
      owner: typeof config.expo.owner === "string" && config.expo.owner.length > 0,
      projectId: typeof config.expo.extra?.eas?.projectId === "string",
      updatesUrl: typeof config.expo.updates?.url === "string",
    }).toEqual({ owner: true, projectId: true, updatesUrl: true });
  });

  it("points updates.url at the SAME project builds are attributed to", () => {
    const projectId = config.expo.extra!.eas!.projectId!;
    const url = config.expo.updates!.url!;

    // If this fails after an `eas init` or an account move, fix app.json — do
    // not relax the test. A mismatch means installed devices are asking a
    // project you no longer build to for their updates.
    expect(url).toBe(`https://u.expo.dev/${projectId}`);
  });

  it("uses a project id shaped like a UUID", () => {
    // A truncated or placeholder id produces an updates.url that resolves to
    // nothing, which again fails silently at runtime rather than at build time.
    expect(config.expo.extra!.eas!.projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});

// ============================================================================
// App Review settings (see APPLE-PRIVATE-RELEASE.md). Each of these can sink a
// submission: a missing or vague purpose string (5.1.1), an Info.plist key for
// a feature the app never uses (Face ID), or no export-compliance flag (every
// build then waits on a manual questionnaire in App Store Connect).
// ============================================================================
type Plugin = string | [string, Record<string, unknown>];
const full = JSON.parse(readFileSync(join(__dirname, "app.json"), "utf8")) as {
  expo: {
    ios: {
      bundleIdentifier: string;
      supportsTablet: boolean;
      infoPlist: Record<string, unknown>;
      privacyManifests: {
        NSPrivacyTracking: boolean;
        NSPrivacyCollectedDataTypes: { NSPrivacyCollectedDataType: string }[];
      };
    };
    plugins: Plugin[];
  };
};
const ios = full.expo.ios;
function pluginOptions(name: string): Record<string, unknown> | undefined {
  const p = full.expo.plugins.find((x) => (Array.isArray(x) ? x[0] : x) === name);
  return Array.isArray(p) ? p[1] : undefined;
}

describe("iOS App Review settings", () => {
  it("keeps the identity the TestFlight app already has", () => {
    expect(ios.bundleIdentifier).toBe("au.com.mellerick.field");
    expect(ios.supportsTablet).toBe(false);
  });

  it("declares exempt encryption and background location", () => {
    expect(ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(ios.infoPlist.UIBackgroundModes).toEqual(["location"]);
  });

  it("has a specific purpose string for every permission it asks for", () => {
    const picker = pluginOptions("expo-image-picker");
    const location = pluginOptions("expo-location");
    const speech = pluginOptions("expo-speech-recognition");
    const strings = [
      picker?.photosPermission,
      picker?.cameraPermission,
      location?.locationWhenInUsePermission,
      location?.locationAlwaysPermission,
      location?.locationAlwaysAndWhenInUsePermission,
      speech?.microphonePermission,
      speech?.speechRecognitionPermission,
    ];
    for (const s of strings) {
      expect(typeof s).toBe("string");
      expect((s as string).startsWith("Mellerick Field")).toBe(true);
      expect((s as string).length).toBeGreaterThan(50);
    }
  });

  it("does not ship a Face ID purpose string for a feature it does not have", () => {
    expect(pluginOptions("expo-secure-store")?.faceIDPermission).toBe(false);
  });

  it("declares no tracking and the data types the App Privacy answers name", () => {
    expect(ios.privacyManifests.NSPrivacyTracking).toBe(false);
    const types = ios.privacyManifests.NSPrivacyCollectedDataTypes.map((t) => t.NSPrivacyCollectedDataType);
    for (const t of ["Name", "EmailAddress", "PreciseLocation", "PhotosorVideos", "AudioData", "UserID", "OtherUserContent", "CrashData"]) {
      expect(types).toContain(`NSPrivacyCollectedDataType${t}`);
    }
  });
});
