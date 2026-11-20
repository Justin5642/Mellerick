import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_FOLDER,
  documentFolderGroup,
  groupDocumentsByFolder,
  isMissingFolderColumn,
  parseDocumentFolder,
} from "@/lib/document-folders";

/** Everything after the first blank line — each copy has its own header. */
const body = (f: string) => {
  const src = readFileSync(f, "utf8");
  return src.slice(src.indexOf("\n\n") + 2);
};

describe("document folders", () => {
  it("the phone's copy is byte-identical below its header", () => {
    expect(body("mobile/lib/documentFolders.ts")).toBe(body("lib/document-folders.ts"));
    expect(body("lib/document-folders.ts").length).toBeGreaterThan(500);
  });

  it("files new uploads in Site Documents by default", () => {
    expect(DEFAULT_DOCUMENT_FOLDER).toBe("site_documents");
  });

  it("parses a folder from a request: known, Other, or refused", () => {
    expect(parseDocumentFolder("drainage")).toBe("drainage");
    expect(parseDocumentFolder("other")).toBeNull();
    expect(parseDocumentFolder(null)).toBeNull();
    expect(parseDocumentFolder("")).toBeNull();
    expect(parseDocumentFolder("Drainage")).toBeUndefined();
    expect(parseDocumentFolder("invoices")).toBeUndefined();
    expect(parseDocumentFolder(3)).toBeUndefined();
  });

  it("puts legacy and unknown folders under Other", () => {
    expect(documentFolderGroup({})).toBe("other");
    expect(documentFolderGroup({ folder: null })).toBe("other");
    expect(documentFolderGroup({ folder: "garbage" })).toBe("other");
    expect(documentFolderGroup({ folder: "soil" })).toBe("soil");
  });

  it("groups in folder order, keeping each folder's order, Other last", () => {
    const docs = [
      { id: "1", folder: null },
      { id: "2", folder: "soil" },
      { id: "3", folder: "site_documents" },
      { id: "4", folder: "soil" },
    ];
    const groups = groupDocumentsByFolder(docs);
    expect(groups.map((g) => [g.folder, g.label, g.documents.map((d) => d.id)])).toEqual([
      ["site_documents", "Site Documents", ["3"]],
      ["soil", "Soil", ["2", "4"]],
      ["other", "Other", ["1"]],
    ]);
    expect(groupDocumentsByFolder([], true).map((g) => g.label)).toEqual(["Site Documents", "Drainage", "Plumbing", "Soil", "Other"]);
  });

  it("recognises only the missing folder column", () => {
    expect(isMissingFolderColumn({ code: "42703", message: 'column "folder" of relation "job_documents" does not exist' })).toBe(true);
    expect(isMissingFolderColumn({ code: "PGRST204", message: "Could not find the 'folder' column of 'job_documents'" })).toBe(true);
    expect(isMissingFolderColumn({ code: "42703", message: 'column "office_only" does not exist' })).toBe(false);
    expect(isMissingFolderColumn({ code: "42501", message: "folder" })).toBe(false);
    expect(isMissingFolderColumn(null)).toBe(false);
  });
});
