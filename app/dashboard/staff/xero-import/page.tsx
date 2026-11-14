export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { XeroImportClient } from "@/components/staff/xero-import-client";

// Payroll: admins only (the API routes check the same).
export default async function XeroImportPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.profile?.role !== "admin") redirect("/dashboard/staff");
  return <XeroImportClient />;
}
