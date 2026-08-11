import { Alert, Linking } from "react-native";
import { openExternalUrl, openNavigation } from "./open-external-url";

// Item N3. `Linking.openURL` REJECTS when nothing on the device can handle the
// URL, and every call site discarded that promise — so a technician tapping
// "Waze" with no handler installed saw the screen not move and had no way to
// tell that from a slow tap.
//
// These assert on what the USER ends up with (did it open / were they told),
// not on Linking having been called, because "the call was made" is precisely
// the thing that was already true while the feature was broken.

jest.mock("react-native", () => ({
  Alert: { alert: jest.fn() },
  Linking: { openURL: jest.fn() },
}));

const openURL = Linking.openURL as jest.Mock;
const alert = Alert.alert as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("openExternalUrl", () => {
  it("reports success when the platform opens the link", async () => {
    openURL.mockResolvedValue(true);
    await expect(openExternalUrl("https://example.test")).resolves.toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it("tells the user when nothing can open it, instead of doing nothing", async () => {
    openURL.mockRejectedValue(new Error("No Activity found to handle Intent"));

    await expect(openExternalUrl("waze://", "navigation")).resolves.toBe(false);

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, body] = alert.mock.calls[0];
    expect(title).toBe("Couldn't open that");
    // The thing being opened is named, so the message is actionable rather
    // than a generic failure.
    expect(body).toContain("navigation");
    expect(body).toContain("No Activity found to handle Intent");
  });

  it("still tells the user when the rejection carries no message", async () => {
    openURL.mockRejectedValue(undefined);
    await expect(openExternalUrl("waze://")).resolves.toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

describe("openNavigation", () => {
  const site = {
    site_lat: -37.81,
    site_lng: 144.96,
    address_line1: "1 Test Street",
    suburb: "Testville",
    state: "VIC",
  };

  it("uses coordinates when the site has them", async () => {
    openURL.mockResolvedValue(true);
    await expect(openNavigation(site)).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0][0]).toContain("ll=-37.81,144.96");
  });

  it("falls back to an address search when the coordinate link will not open", async () => {
    // The two URLs fail for different reasons — one needs a waze handler, the
    // other needs a resolvable address — so trying the second is worth doing.
    // No call site did.
    openURL.mockRejectedValueOnce(new Error("no handler")).mockResolvedValueOnce(true);

    await expect(openNavigation(site)).resolves.toBe(true);

    expect(openURL).toHaveBeenCalledTimes(2);
    expect(openURL.mock.calls[1][0]).toContain("q=1%20Test%20Street%20Testville%20VIC");
  });

  it("uses the address directly when there are no coordinates", async () => {
    openURL.mockResolvedValue(true);
    await expect(openNavigation({ ...site, site_lat: null, site_lng: null })).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0][0]).toContain("q=");
  });

  it("does nothing, quietly, when there is no site and nothing to navigate to", async () => {
    // The one case where silence is right: there is no address, so there is
    // nothing to tell the user beyond what the screen already shows.
    await expect(openNavigation(null)).resolves.toBe(false);
    await expect(openNavigation({ site_lat: null, site_lng: null, address_line1: "" })).resolves.toBe(false);
    expect(openURL).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});
