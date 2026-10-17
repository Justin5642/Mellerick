// Who may change a time entry from the job's Time tab.
//
// One rule for every control on the row. The edit dialog already applied it,
// but the stage ("cost centre") picker under each entry did not: any signed-in
// user could move a colleague's hours onto another stage, which shifts what
// that stage is billed and costed at. Admins can correct anyone's entry (e.g.
// re-attributing time logged against the wrong stage); everyone else, their own.
//
// UI only — the real boundary has to be time_entries RLS, since anyone with a
// session can write through PostgREST directly. This keeps the screen from
// offering, and the component from sending, what the rule says it shouldn't.
export function canEditTimeEntry(
  entry: { staff_id: string },
  currentUserId: string,
  isAdmin: boolean | undefined
): boolean {
  return entry.staff_id === currentUserId || !!isAdmin;
}
