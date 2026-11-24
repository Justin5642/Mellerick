import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOLDER_GROUP,
  DOCUMENT_FOLDERS,
  documentFolderGroup,
  documentFolderLabel,
  folderValue,
  groupDocumentsByFolder,
  isFolderNotSwitchedOn,
  isMissingFolderColumn,
  parseDocumentFolder,
} from "@/lib/document-folders";

/** Everything after the first blank line — each copy has its own header. */
const body = (f: string) => {
  const src = readFileSync(f, "utf8");
  return src.slice(src.indexOf("\n\n") + 2);
};

describe("job folders (documents and photos)", () => {
  it("the phone's copy is byte-identical below its header", () => {
    expect(body("mobile/lib/documentFolders.ts")).toBe(body("lib/document-folders.ts"));
    expect(body("lib/document-folders.ts").length).toBeGreaterThan(500);
  });

  it("is Justin's list, in his order, matching migration 0116's check", () => {
    expect(DOCUMENT_FOLDERS.map((f) => documentFolderLabel(f))).toEqual([
      "Drains",
      "Soil & Rock",
      "R1",
      "R2",
      "Rough In",
      "Fit Off",
      "Camera Inspections",
    ]);
    const sql = readFileSync("supabase/migrations/0116_job_folders.sql", "utf8");
    const checks = sql.match(/check \(folder is null or folder in \(([^)]*)\)\)/g) ?? [];
    expect(checks).toHaveLength(2); // job_documents and job_photos
    for (const check of checks) {
      const keys = [...check.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
      expect(keys).toEqual([...DOCUMENT_FOLDERS]);
    }
  });

  it("files new uploads under Other unless a folder is picked", () => {
    expect(DEFAULT_FOLDER_GROUP).toBe("other");
    expect(folderValue("other")).toBeNull();
    expect(folderValue("rough_in")).toBe("rough_in");
  });

  it("parses a folder from a request: known, Other, legacy, or refused", () => {
    expect(parseDocumentFolder("drains")).toBe("drains");
    expect(parseDocumentFolder("camera_inspections")).toBe("camera_inspections");
    expect(parseDocumentFolder("other")).toBeNull();
    expect(parseDocumentFolder(null)).toBeNull();
    expect(parseDocumentFolder("")).toBeNull();
    // An older phone build still sends the 0114 keys: mapped as 0116 did.
    expect(parseDocumentFolder("drainage")).toBe("drains");
    expect(parseDocumentFolder("soil")).toBe("soil_rock");
    expect(parseDocumentFolder("site_documents")).toBeNull();
    expect(parseDocumentFolder("plumbing")).toBeNull();
    expect(parseDocumentFolder("Drains")).toBeUndefined();
    expect(parseDocumentFolder("invoices")).toBeUndefined();
    expect(parseDocumentFolder("toString")).toBeUndefined();
    expect(parseDocumentFolder(3)).toBeUndefined();
  });

  it("puts unfiled and unknown rows under Other, and reads 0114 keys as 0116 moved them", () => {
    expect(documentFolderGroup({})).toBe("other");
    expect(documentFolderGroup({ folder: null })).toBe("other");
    expect(documentFolderGroup({ folder: "garbage" })).toBe("other");
    expect(documentFolderGroup({ folder: "constructor" })).toBe("other");
    expect(documentFolderGroup({ folder: "soil_rock" })).toBe("soil_rock");
    expect(documentFolderGroup({ folder: "drainage" })).toBe("drains");
    expect(documentFolderGroup({ folder: "soil" })).toBe("soil_rock");
    expect(documentFolderGroup({ folder: "site_documents" })).toBe("other");
    expect(documentFolderGroup({ folder: "plumbing" })).toBe("other");
  });

  it("groups in folder order, keeping each folder's order, Other last", () => {
    const rows = [
      { id: "1", folder: null },
      { id: "2", folder: "fit_off" },
      { id: "3", folder: "drains" },
      { id: "4", folder: "fit_off" },
      { id: "5", folder: "drainage" },
    ];
    const groups = groupDocumentsByFolder(rows);
    expect(groups.map((g) => [g.folder, g.label, g.documents.map((d) => d.id)])).toEqual([
      ["drains", "Drains", ["3", "5"]],
      ["fit_off", "Fit Off", ["2", "4"]],
      ["other", "Other", ["1"]],
    ]);
    expect(groupDocumentsByFolder([], true).map((g) => g.label)).toEqual([
      "Drains",
      "Soil & Rock",
      "R1",
      "R2",
      "Rough In",
      "Fit Off",
      "Camera Inspections",
      "Other",
    ]);
  });

  it("recognises only the missing folder column", () => {
    expect(isMissingFolderColumn({ code: "42703", message: 'column "folder" of relation "job_documents" does not exist' })).toBe(true);
    expect(isMissingFolderColumn({ code: "PGRST204", message: "Could not find the 'folder' column of 'job_photos'" })).toBe(true);
    expect(isMissingFolderColumn({ code: "42703", message: 'column "office_only" does not exist' })).toBe(false);
    expect(isMissingFolderColumn({ code: "42501", message: "folder" })).toBe(false);
    expect(isMissingFolderColumn(null)).toBe(false);
  });

  it("treats the 0114 check refusing a new key as 'not switched on', nothing else", () => {
    expect(
      isFolderNotSwitchedOn({
        code: "23514",
        message: 'new row for relation "job_documents" violates check constraint "job_documents_folder_check"',
      })
    ).toBe(true);
    expect(isFolderNotSwitchedOn({ code: "PGRST204", message: "Could not find the 'folder' column" })).toBe(true);
    expect(isFolderNotSwitchedOn({ code: "23514", message: 'violates check constraint "jobs_job_type_check"' })).toBe(false);
    expect(isFolderNotSwitchedOn({ code: "42501", message: "folder" })).toBe(false);
    expect(isFolderNotSwitchedOn(undefined)).toBe(false);
  });
});
