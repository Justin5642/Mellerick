import { audioExtension, joinSegments } from "./dictation";

describe("joinSegments", () => {
  it("joins recognised segments with single spaces, skipping empties", () => {
    expect(joinSegments("Replaced the TMV.", "  Tested OK ")).toBe("Replaced the TMV. Tested OK");
    expect(joinSegments("", null, undefined, "only")).toBe("only");
    expect(joinSegments()).toBe("");
  });
});

describe("audioExtension", () => {
  it("reads the recording's extension, defaulting to m4a", () => {
    expect(audioExtension("file:///cache/recording_123.wav")).toBe("wav");
    expect(audioExtension("file:///cache/recording.CAF")).toBe("caf");
    expect(audioExtension("file:///cache/noext")).toBe("m4a");
  });
});
