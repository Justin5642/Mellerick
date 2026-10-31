jest.mock("expo-location", () => ({}));
import { fixColumns, fixFromCoords } from "./clockFix";

// Clock-on/off position (0092, DRAFT, not applied yet): recorded when known, never invented.
describe("clock fix", () => {
  it("turns a reading into columns", () => {
    const fix = fixFromCoords({ latitude: -37.8, longitude: 144.9, accuracy: 12.6 });
    expect(fixColumns("clock_in", fix)).toEqual({ clock_in_lat: -37.8, clock_in_lng: 144.9, clock_in_accuracy: 13 });
  });

  it("adds nothing with no fix", () => {
    expect(fixColumns("clock_out", null)).toEqual({});
    expect(fixFromCoords(null)).toBeNull();
    expect(fixFromCoords({ latitude: NaN, longitude: 1 })).toBeNull();
  });

  it("keeps an unknown accuracy as null", () => {
    expect(fixFromCoords({ latitude: 1, longitude: 2 })).toEqual({ lat: 1, lng: 2, accuracy: null });
  });
});
