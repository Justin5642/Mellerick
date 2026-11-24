import { describe, it, expect } from "vitest";
import {
  dragHasFiles,
  droppedOnlyALink,
  inlineImageUrls,
  pasteTargetIsEditable,
  pastedFileName,
  rejectionMessage,
  splitAcceptedFiles,
} from "@/lib/file-drop";

const f = (name: string, type: string, size = 1000) => ({ name, type, size });
const DOCS = ".pdf,.doc,.docx,.dwg,.dxf,.png,.jpg,.jpeg,.xlsx,.xls";

describe("dragHasFiles", () => {
  it("lights up for files from the desktop or another tab", () => {
    expect(dragHasFiles(["Files"])).toBe(true);
    expect(dragHasFiles(["text/uri-list", "Files"])).toBe(true);
    expect(dragHasFiles(["application/x-moz-file"])).toBe(true);
  });
  it("ignores text, links and on-page drags", () => {
    expect(dragHasFiles(["text/plain"])).toBe(false);
    expect(dragHasFiles(["text/uri-list", "text/html"])).toBe(false);
    expect(dragHasFiles([])).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});

describe("splitAcceptedFiles — the same allow-list as the Upload button", () => {
  it("Photos take images only", () => {
    const { accepted, rejected } = splitAcceptedFiles([f("a.jpg", "image/jpeg"), f("b.heic", "image/heic"), f("plan.pdf", "application/pdf")], "image/*");
    expect(accepted.map((x) => x.name)).toEqual(["a.jpg", "b.heic"]);
    expect(rejected.map((x) => x.name)).toEqual(["plan.pdf"]);
  });
  it("Documents take the listed extensions, whatever the case", () => {
    const { accepted, rejected } = splitAcceptedFiles(
      [f("Plan.PDF", "application/pdf"), f("site.dwg", ""), f("notes.txt", "text/plain"), f("photo.png", "image/png")],
      DOCS
    );
    expect(accepted.map((x) => x.name)).toEqual(["Plan.PDF", "site.dwg", "photo.png"]);
    expect(rejected.map((x) => x.name)).toEqual(["notes.txt"]);
  });
  it("refuses a dropped folder (empty, typeless, no extension) even with no allow-list", () => {
    const { accepted, rejected } = splitAcceptedFiles([f("Lot 12 plans", "", 0), f("a.pdf", "application/pdf")]);
    expect(accepted.map((x) => x.name)).toEqual(["a.pdf"]);
    expect(rejected.map((x) => x.name)).toEqual(["Lot 12 plans"]);
  });
  it("keeps the caller's objects (so real Files pass through)", () => {
    const file = f("a.png", "image/png");
    expect(splitAcceptedFiles([file], "image/*").accepted[0]).toBe(file);
  });
});

describe("rejectionMessage", () => {
  it("is null when nothing was refused", () => {
    expect(rejectionMessage([])).toBeNull();
  });
  it("names one file and what is accepted", () => {
    expect(rejectionMessage([f("notes.txt", "text/plain")], "PDF or JPG")).toBe("notes.txt isn't a supported file type — PDF or JPG");
  });
  it("names up to three and counts the rest", () => {
    const msg = rejectionMessage([f("a.txt", ""), f("b.txt", ""), f("c.txt", ""), f("d.txt", ""), f("e.txt", "")]);
    expect(msg).toBe("5 files aren't a supported file type (a.txt, b.txt, c.txt and 2 more)");
  });
});

describe("pastedFileName", () => {
  const now = new Date(2026, 10, 24, 9, 5, 7);
  it("dates a clipboard screenshot", () => {
    expect(pastedFileName({ name: "image.png", type: "image/png" }, now)).toBe("pasted-20261124-090507.png");
    expect(pastedFileName({ name: "", type: "image/jpeg" }, now)).toBe("pasted-20261124-090507.jpg");
  });
  it("numbers several pasted at once", () => {
    expect(pastedFileName({ name: "image.png", type: "image/png" }, now, 1)).toBe("pasted-20261124-090507-2.png");
  });
  it("keeps a real file name copied from the desktop", () => {
    expect(pastedFileName({ name: "Lot 12 plan.pdf", type: "application/pdf" }, now)).toBe("Lot 12 plan.pdf");
  });
  it("falls back sensibly for unknown types", () => {
    expect(pastedFileName({ name: "blob", type: "image/avif" }, now)).toBe("pasted-20261124-090507.avif");
    expect(pastedFileName({ name: "", type: "" }, now)).toBe("pasted-20261124-090507.bin");
  });
});

describe("pasteTargetIsEditable — a paste into a field stays in the field", () => {
  it("text inputs, text areas and editable regions", () => {
    expect(pasteTargetIsEditable({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(pasteTargetIsEditable({ tagName: "input" })).toBe(true);
    expect(pasteTargetIsEditable({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(pasteTargetIsEditable({ tagName: "TEXTAREA" })).toBe(true);
    expect(pasteTargetIsEditable({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("buttons, checkboxes and the page itself are not", () => {
    expect(pasteTargetIsEditable({ tagName: "BODY" })).toBe(false);
    expect(pasteTargetIsEditable({ tagName: "BUTTON" })).toBe(false);
    expect(pasteTargetIsEditable({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(pasteTargetIsEditable(null)).toBe(false);
  });
});

describe("images dragged from another page without a file", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  it("finds inline data: images in a uri-list or HTML, once each", () => {
    expect(inlineImageUrls(`# comment\n${png}`, `<img alt="x" src="${png}">`)).toEqual([png]);
    expect(inlineImageUrls(null, `<p><img src='${png}'/></p>`)).toEqual([png]);
  });
  it("ignores web addresses (another site won't hand them over)", () => {
    expect(inlineImageUrls("https://example.com/a.png", '<img src="https://example.com/a.png">')).toEqual([]);
    expect(inlineImageUrls("data:text/html;base64,PGI+", null)).toEqual([]);
  });
  it("knows when only a link arrived", () => {
    expect(droppedOnlyALink("https://example.com/a.png", null)).toBe(true);
    expect(droppedOnlyALink(null, '<img src="https://mail.example/x.jpg">')).toBe(true);
    expect(droppedOnlyALink(null, null)).toBe(false);
  });
});
