"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Archive, ArchiveRestore } from "lucide-react";

// Soft-delete for a customer site. Sites are never hard-deleted: jobs and
// quotes reference them, so archiving hides the site from pickers while every
// existing job/quote keeps its link. Archived sites can be restored.
export function SiteArchiveButton({ siteId, siteName, isActive }: { siteId: string; siteName: string; isActive: boolean }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleToggle() {
    if (isActive && !confirm(`Archive "${siteName}"? It will be hidden from site lists and pickers. Existing jobs and quotes keep it, and you can restore it any time.`)) {
      return;
    }
    setLoading(true);
    // count: "exact" so an RLS refusal (0 rows, no error) isn't reported as success.
    const { error, count } = await supabase.from("sites").update({ is_active: !isActive }, { count: "exact" }).eq("id", siteId);
    setLoading(false);
    if (error || count === 0) {
      toast.error(error?.message ?? "Couldn't update the site");
      return;
    }
    toast.success(isActive ? "Site archived" : "Site restored");
    router.refresh();
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-7 gap-1.5 text-xs ${isActive ? "text-slate-400 hover:text-red-600" : "text-blue-600"}`}
      onClick={handleToggle}
      disabled={loading}
      title={isActive ? "Archive site" : "Restore site"}
    >
      {isActive ? <Archive className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />}
      {isActive ? "Archive" : "Restore"}
    </Button>
  );
}
