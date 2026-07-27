// Technician "My Jobs" tab. The screen body lives in a shared component so the
// admin-facing route (app/my-jobs.tsx, reachable from the office More hub) renders
// exactly the same list and the two can never diverge — same pattern as the
// backflow tech tab vs /backflow/list (D36).
export { MyJobsScreen as default } from "../../components/jobs/my-jobs-screen";
