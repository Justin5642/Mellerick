// "Today's run" — the truck driver's run sheet. Shared by technicians and
// office/admin (registered outside the role groups in app/_layout.tsx, beside
// job/[id]); reached from the card at the top of My Jobs. The server only
// ever answers with the caller's own cartage bookings, so there is nothing
// role-specific to hide here. The screen's SafeAreaView leaves the top inset
// to the native header (test/screens/header-safe-area.test.ts).
export { TodaysRunScreen as default } from "../../components/run/todays-run-screen";
