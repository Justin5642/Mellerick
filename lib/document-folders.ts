// Job folders for documents AND photos (Justin, 24 Nov 2026 — replaces the
// 20 Nov notebook list's Site Documents / Drainage / Plumbing / Soil). The
// columns are job_documents.folder (0114, keys replaced by migration 0116, drafted)
// and job_photos.folder (0116); on a database without 0116 the old document
// keys read as their new folders and photos all read as "Other". Mirrored
// byte for byte below this header at mobile/lib/documentFolders.ts
// (tests/unit/document-folders.test.ts) — change this file first, then copy.

/**
 * The folders a document or photo can be filed in (0116, drafted). NULL in the
 * database = "Other". One list for job_documents.folder and job_photos.folder.
 */
export const DOCUMENT_FOLDERS = ["drains", "soil_rock", "r1", "r2", "rough_in", "fit_off", "camera_inspections"] as const;
export type DocumentFolder = (typeof DOCUMENT_FOLDERS)[number];
/** Every group the Documents and Photos tabs show, in order — "other" last. */
export type DocumentFolderGroup = DocumentFolder | "other";
export const DOCUMENT_FOLDER_GROUPS: readonly DocumentFolderGroup[] = [...DOCUMENT_FOLDERS, "other"];

/**
 * Where a new upload goes unless the person picks another folder: Other.
 * None of the stage folders is a safe guess for an unsorted upload, and
 * Other is where every legacy row already is.
 */
export const DEFAULT_FOLDER_GROUP: DocumentFolderGroup = "other";

const LABELS: Record<DocumentFolderGroup, string> = {
  drains: "Drains",
  soil_rock: "Soil & Rock",
  r1: "R1",
  r2: "R2",
  rough_in: "Rough In",
  fit_off: "Fit Off",
  camera_inspections: "Camera Inspections",
  other: "Other",
};

/**
 * The 0114 keys (Site Documents / Drainage / Plumbing / Soil) and where 0116
 * moved them. Read on a database 0116 hasn't reached yet, and accepted from
 * an older phone build's request, so neither breaks while they overlap.
 */
const LEGACY_FOLDERS: Readonly<Record<string, DocumentFolder | null>> = {
  drainage: "drains",
  soil: "soil_rock",
  site_documents: null,
  plumbing: null,
};

export function documentFolderLabel(folder: DocumentFolderGroup): string {
  return LABELS[folder];
}

export function isDocumentFolder(value: unknown): value is DocumentFolder {
  return typeof value === "string" && (DOCUMENT_FOLDERS as readonly string[]).includes(value);
}

/** The stored value for a group: its key, or null for "Other". */
export function folderValue(group: DocumentFolderGroup): DocumentFolder | null {
  return group === "other" ? null : group;
}

/**
 * A folder value from a request body: a known folder, null for "Other"
 * ("other", null, "" or a 0114 key 0116 put under Other), or undefined when
 * it is anything else — the caller refuses that, or treats an absent value
 * as "not given".
 */
export function parseDocumentFolder(value: unknown): DocumentFolder | null | undefined {
  if (value === null || value === "" || value === "other") return null;
  if (isDocumentFolder(value)) return value;
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY_FOLDERS, value)) return LEGACY_FOLDERS[value];
  return undefined;
}

/** The group a document or photo row belongs to: its folder, else "other" (legacy, unfiled). */
export function documentFolderGroup(row: { folder?: string | null }): DocumentFolderGroup {
  const folder = row.folder;
  if (isDocumentFolder(folder)) return folder;
  if (typeof folder === "string" && Object.prototype.hasOwnProperty.call(LEGACY_FOLDERS, folder)) {
    return LEGACY_FOLDERS[folder] ?? "other";
  }
  return "other";
}

export interface DocumentFolderSection<T> {
  folder: DocumentFolderGroup;
  label: string;
  documents: T[];
}

/**
 * Rows (documents or photos) grouped by folder, in the fixed folder order,
 * each group keeping the order it was given (newest first on every screen).
 * Empty folders are left out unless `includeEmpty`.
 */
export function groupDocumentsByFolder<T extends { folder?: string | null }>(
  documents: readonly T[],
  includeEmpty = false
): DocumentFolderSection<T>[] {
  const byFolder = new Map<DocumentFolderGroup, T[]>();
  for (const g of DOCUMENT_FOLDER_GROUPS) byFolder.set(g, []);
  for (const doc of documents) byFolder.get(documentFolderGroup(doc))!.push(doc);
  return DOCUMENT_FOLDER_GROUPS.filter((g) => includeEmpty || byFolder.get(g)!.length > 0).map((g) => ({
    folder: g,
    label: LABELS[g],
    documents: byFolder.get(g)!,
  }));
}

/** True when a read or write failed only because the folder column is missing. */
export function isMissingFolderColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  return /\bfolder\b/.test(error.message ?? "");
}

/**
 * True when a write failed because these folders aren't in the database yet:
 * the column is missing, or (0114 applied, 0116 not) the old folder check
 * refused a new key.
 */
export function isFolderNotSwitchedOn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (isMissingFolderColumn(error)) return true;
  return !!error && error.code === "23514" && /folder/.test(error.message ?? "");
}
