import { canChangeStageNote, mergeStageNotes, validateStageNoteEdit } from "./stageNoteEdits";

describe("canChangeStageNote", () => {
  const mine = { author_id: "u1" };
  const theirs = { author_id: "u2" };

  it("lets a technician change only their own notes", () => {
    const viewer = { currentUserId: "u1", isOfficeOrAdmin: false, readOnly: false };
    expect(canChangeStageNote(mine, viewer)).toBe(true);
    expect(canChangeStageNote(theirs, viewer)).toBe(false);
  });

  it("lets office/admin change every note", () => {
    const viewer = { currentUserId: "u9", isOfficeOrAdmin: true, readOnly: false };
    expect(canChangeStageNote(mine, viewer)).toBe(true);
    expect(canChangeStageNote(theirs, viewer)).toBe(true);
  });

  it("shows nothing on a view-only job, even for the author", () => {
    expect(canChangeStageNote(mine, { currentUserId: "u1", isOfficeOrAdmin: false, readOnly: true })).toBe(false);
    expect(canChangeStageNote(mine, { currentUserId: "u1", isOfficeOrAdmin: true, readOnly: true })).toBe(false);
  });

  it("fails closed when the author or the viewer is unknown", () => {
    expect(canChangeStageNote({ author_id: null }, { currentUserId: "u1", isOfficeOrAdmin: false, readOnly: false })).toBe(false);
    expect(canChangeStageNote({}, { currentUserId: "u1", isOfficeOrAdmin: false, readOnly: false })).toBe(false);
    expect(canChangeStageNote({ author_id: undefined }, { currentUserId: undefined, isOfficeOrAdmin: false, readOnly: false })).toBe(false);
    expect(canChangeStageNote({ author_id: null }, { currentUserId: null, isOfficeOrAdmin: false, readOnly: false })).toBe(false);
  });
});

describe("validateStageNoteEdit", () => {
  it("trims the text", () => {
    expect(validateStageNoteEdit("  ok  ")).toEqual({ content: "ok" });
  });
  it("refuses an empty note", () => {
    expect(validateStageNoteEdit("   ")).toEqual({ error: "A note can't be empty — delete it instead." });
  });
});

describe("mergeStageNotes", () => {
  type N = { id: string; content: string };
  const none = new Set<string>();

  it("takes the server's rows when nothing is pending", () => {
    const local: N[] = [{ id: "a", content: "old" }];
    const server: N[] = [{ id: "a", content: "new" }, { id: "b", content: "b" }];
    expect(mergeStageNotes(local, server, none, none)).toEqual(server);
  });

  it("keeps a queued edit over the server's older text", () => {
    const local: N[] = [{ id: "a", content: "edited" }];
    const server: N[] = [{ id: "a", content: "original" }];
    expect(mergeStageNotes(local, server, new Set(["a"]), none)).toEqual([{ id: "a", content: "edited" }]);
  });

  it("keeps a deleted note hidden while its delete is pending", () => {
    const server: N[] = [{ id: "a", content: "x" }, { id: "b", content: "y" }];
    expect(mergeStageNotes([{ id: "b", content: "y" }], server, new Set(["a"]), new Set(["a"]))).toEqual([{ id: "b", content: "y" }]);
  });

  it("brings a deleted note back once the delete is no longer pending (refused)", () => {
    const server: N[] = [{ id: "a", content: "x" }];
    expect(mergeStageNotes([], server, none, new Set(["a"]))).toEqual(server);
  });

  it("shows the server version of a pending row the screen doesn't hold", () => {
    const server: N[] = [{ id: "a", content: "x" }];
    expect(mergeStageNotes([], server, new Set(["a"]), none)).toEqual(server);
  });

  it("keeps an optimistic insert absent from the server, first", () => {
    const local: N[] = [{ id: "new", content: "n" }];
    const server: N[] = [{ id: "a", content: "x" }];
    expect(mergeStageNotes(local, server, new Set(["new"]), none)).toEqual([...local, ...server]);
  });

  it("drops a local-only row whose write is done or gone", () => {
    expect(mergeStageNotes([{ id: "gone", content: "g" }], [], none, none)).toEqual([]);
  });
});
