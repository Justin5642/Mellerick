import { nextGeofenceState, GEOFENCE_RADIUS_METERS, type TrackedSite } from "./geofenceState";

// The geofence decision, extracted from LocationTrackingProvider so it can be
// tested and — the actual point — reused by a BACKGROUND task.
//
// Until now this logic lived inside a closure over three refs in a React
// provider. That made it unreachable two ways: no test could call it, and the
// background location task (which runs with no React tree at all) could not
// either. So the auto-clock only ran while the app was open, and the gap was
// invisible: a technician driving between sites with the app backgrounded had
// that travel time silently NOT recorded. Under-paying quietly is worse than
// failing loudly, because nobody goes looking.
//
// Classical (Detroit-school) tests: this is pure arithmetic over coordinates,
// so there is nothing to mock and the real distance maths is what is under test.

// Two points ~111m apart in latitude (0.001 deg ≈ 111m).
const SITE_A: TrackedSite = { jobId: "job-a", lat: -37.8136, lng: 144.9631 };
const SITE_B: TrackedSite = { jobId: "job-b", lat: -37.9136, lng: 144.9631 }; // ~11km away

const AT_SITE_A = { latitude: -37.8136, longitude: 144.9631 };
const NEAR_SITE_A = { latitude: -37.8137, longitude: 144.9631 }; // ~11m — inside
const FAR_FROM_ALL = { latitude: -37.0, longitude: 144.0 };

describe("nextGeofenceState", () => {
  it("reports arrival when entering a site's radius from nowhere", () => {
    const s = nextGeofenceState(AT_SITE_A, [SITE_A, SITE_B], null);
    expect(s).toEqual({ insideJobId: "job-a", previousJobId: null, transition: "arrival" });
  });

  it("reports nothing while STAYING inside the same site", () => {
    // The caller writes a time entry on every transition; repeating "arrival"
    // on each GPS tick would clock the technician in over and over.
    const s = nextGeofenceState(NEAR_SITE_A, [SITE_A], "job-a");
    expect(s.transition).toBe("none");
    expect(s.insideJobId).toBe("job-a");
  });

  it("reports departure when leaving the radius", () => {
    const s = nextGeofenceState(FAR_FROM_ALL, [SITE_A], "job-a");
    expect(s).toEqual({ insideJobId: null, previousJobId: "job-a", transition: "departure" });
  });

  it("reports arrival at the NEW site when moving directly between two sites", () => {
    // Site-to-site without an intervening out-of-range reading. The caller needs
    // previousJobId to attribute the travel leg, so it must survive the switch.
    const atB = { latitude: SITE_B.lat, longitude: SITE_B.lng };
    const s = nextGeofenceState(atB, [SITE_A, SITE_B], "job-a");
    expect(s).toEqual({ insideJobId: "job-b", previousJobId: "job-a", transition: "arrival" });
  });

  it("reports nothing when outside every site and already outside", () => {
    const s = nextGeofenceState(FAR_FROM_ALL, [SITE_A, SITE_B], null);
    expect(s.transition).toBe("none");
    expect(s.insideJobId).toBeNull();
  });

  it("picks the NEAREST site when two overlap", () => {
    const overlapping: TrackedSite[] = [
      { jobId: "far", lat: -37.8137, lng: 144.9631 }, // ~11m
      { jobId: "near", lat: -37.8136, lng: 144.9631 }, // 0m
    ];
    expect(nextGeofenceState(AT_SITE_A, overlapping, null).insideJobId).toBe("near");
  });

  it("treats no tracked sites as no transition, not as a departure", () => {
    // Sites load asynchronously. An empty list means "not known yet", and
    // clocking someone OUT because their job list has not arrived would be a
    // fabricated time entry.
    expect(nextGeofenceState(AT_SITE_A, [], "job-a").transition).toBe("none");
    expect(nextGeofenceState(AT_SITE_A, [], "job-a").insideJobId).toBe("job-a");
  });

  it("ignores a site with missing coordinates rather than treating it as (0,0)", () => {
    // A site with null lat/lng is off the coast of Africa if coerced to zero,
    // which would make the technician permanently "departed" from it.
    const sites = [{ jobId: "no-coords", lat: null as never, lng: null as never }, SITE_A];
    expect(nextGeofenceState(AT_SITE_A, sites, null).insideJobId).toBe("job-a");
  });

  it("uses the same radius the web side uses", () => {
    // components/job/job-time.tsx applies the same constant; a divergence would
    // clock a technician in on one platform and not the other.
    expect(GEOFENCE_RADIUS_METERS).toBe(150);
  });

  it("treats a point just outside the radius as outside", () => {
    // ~200m north of site A — beyond the 150m radius.
    const justOutside = { latitude: -37.8154, longitude: 144.9631 };
    expect(nextGeofenceState(justOutside, [SITE_A], null).insideJobId).toBeNull();
  });
});
