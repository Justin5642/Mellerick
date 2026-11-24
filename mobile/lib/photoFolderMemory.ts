import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_FOLDER_GROUP, DOCUMENT_FOLDER_GROUPS, type DocumentFolderGroup } from "./documentFolders";

// The folder a technician last filed a photo in, per job, on this phone
// (Justin, 24 Nov 2026: "technicians pick the folder when taking a photo").
// Someone photographing a Rough In takes a run of shots, so the next photo on
// that job starts in the same folder. A convenience only: unreadable or
// cleared storage just starts on Other, and nothing else depends on it.

const KEY = "photoFolder:";

/** The remembered folder for this job, or Other. Never throws. */
export async function lastPhotoFolder(jobId: string): Promise<DocumentFolderGroup> {
  try {
    const v = await AsyncStorage.getItem(KEY + jobId);
    return v && (DOCUMENT_FOLDER_GROUPS as readonly string[]).includes(v) ? (v as DocumentFolderGroup) : DEFAULT_FOLDER_GROUP;
  } catch {
    return DEFAULT_FOLDER_GROUP;
  }
}

/** Remember the folder just used for this job. Best-effort, never throws. */
export async function rememberPhotoFolder(jobId: string, folder: DocumentFolderGroup): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY + jobId, folder);
  } catch {
    // A convenience; losing it costs one tap.
  }
}
