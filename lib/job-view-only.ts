// Whether the job page is view-only for this viewer: a technician on a job they
// are not assigned to. Office/admin can always edit. Mirrors the mobile rule in
// mobile/app/job/[id].tsx and the database rule in migration 0074
// (user_can_manage_job: office/admin or any current assignee).
export function isJobViewOnly(isOffice: boolean, assignedIds: string[], userId: string): boolean {
  return !isOffice && !assignedIds.includes(userId);
}

/** Tabs a technician sees on a job they are not on: the job, its plans and
 *  photos. Not Notes (office chatter, scheduling notes) and never the schedule
 *  (Justin, 16 Nov 2026: look up the plans, don't watch other people's work). */
export const VIEW_ONLY_TABS = ["overview", "documents", "photos"];
