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
