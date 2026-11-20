jest.mock("./supabase", () => ({ supabase: {} }));
jest.mock("./siteLocation", () => ({ postSiteLocation: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({ getItem: jest.fn(), setItem: jest.fn() }));

import { shouldOfferSitePin } from "./sitePinOffer";

const good = { lat: -37.5, lng: 144.9, accuracy: 12 };
const base = { hasSite: true, siteLat: null, siteLng: null, fix: good, alreadyAsked: false };

describe("shouldOfferSitePin", () => {
  it("asks when the site has no pin and the fix is within ±50 m", () => {
    expect(shouldOfferSitePin(base)).toBe(true);
    expect(shouldOfferSitePin({ ...base, fix: { ...good, accuracy: 50 } })).toBe(true);
  });

  it("never asks when the site already has a pin", () => {
    expect(shouldOfferSitePin({ ...base, siteLat: -37.5, siteLng: 144.9 })).toBe(false);
  });

  it("never asks with a poor, unknown or missing fix", () => {
    expect(shouldOfferSitePin({ ...base, fix: { ...good, accuracy: 51 } })).toBe(false);
    expect(shouldOfferSitePin({ ...base, fix: { ...good, accuracy: null } })).toBe(false);
    expect(shouldOfferSitePin({ ...base, fix: null })).toBe(false);
  });

  it("asks once per job, and only for a job with a site", () => {
    expect(shouldOfferSitePin({ ...base, alreadyAsked: true })).toBe(false);
    expect(shouldOfferSitePin({ ...base, hasSite: false })).toBe(false);
  });
});
