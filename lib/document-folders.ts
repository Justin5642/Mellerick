// Job document folders (Justin's notebook list, 20 Nov 2026). The column is
// job_documents.folder from migration 0114 (applied 2026-11-21; on a database without it every
// document reads as "Other"). Mirrored byte for byte below this header at
// mobile/lib/documentFolders.ts (tests/unit/document-folders.test.ts) —
// change this file first, then copy.

/** The folders a document can be filed in. NULL in the database = "Other". */
export const DOCUMENT_FOLDERS = ["site_documents", "drainage", "plumbing", "soil"] as const;
export type DocumentFolder = (typeof DOCUMENT_FOLDERS)[number];
/** Every group the Documents tab shows, in order — "other" last. */
export type DocumentFolderGroup = DocumentFolder | "other";
export const DOCUMENT_FOLDER_GROUPS: readonly DocumentFolderGroup[] = [...DOCUMENT_FOLDERS, "other"];

/** Where a new upload goes unless the person picks another folder. */
export const DEFAULT_DOCUMENT_FOLDER: DocumentFolder = "site_documents";

const LABELS: Record<DocumentFolderGroup, string> = {
  site_documents: "Site Documents",
  drainage: "Drainage",
  plumbing: "Plumbing",
  soil: "Soil",
  other: "Other",
};

export function documentFolderLabel(folder: DocumentFolderGroup): string {
  return LABELS[folder];
}

export function isDocumentFolder(value: unknown): value is DocumentFolder {
  return typeof value === "string" && (DOCUMENT_FOLDERS as readonly string[]).includes(value);
}

/**
 * A folder value from a request body: a known folder, null for "Other"
 * ("other", null or ""), or undefined when it is anything else — the caller
 * refuses that, or treats an absent value as "not given".
 */
export function parseDocumentFolder(value: unknown): DocumentFolder | null | undefined {
  if (value === null || value === "" || value === "other") return null;
  if (isDocumentFolder(value)) return value;
  return undefined;
}

/** The group a document row belongs to: its folder, else "other" (legacy, unfiled). */
export function documentFolderGroup(doc: { folder?: string | null }): DocumentFolderGroup {
  return isDocumentFolder(doc.folder) ? doc.folder : "other";
}

export interface DocumentFolderSection<T> {
  folder: DocumentFolderGroup;
  label: string;
  documents: T[];
}

/**
 * Documents grouped by folder, in the fixed folder order, each group keeping
 * the order it was given (newest first on both screens). Empty folders are
 * left out unless `includeEmpty`.
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
