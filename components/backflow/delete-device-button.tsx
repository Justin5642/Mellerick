"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

export function DeleteDeviceButton({ deviceId, customerName }: { deviceId: string; customerName: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleDelete() {
    if (!confirm(`Delete this backflow device for ${customerName}? Its test history is kept, but it will no longer appear in the active devices list.`)) {
      return;
    }
    setLoading(true);
    const { error } = await supabase.from("backflow_devices").update({ is_active: false }).eq("id", deviceId);
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    toast.success("Device deleted");
    router.push("/dashboard/backflow");
    router.refresh();
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-2 text-slate-400 hover:text-red-600"
      onClick={handleDelete}
      disabled={loading}
    >
      <Trash2 className="w-4 h-4" />
      {loading ? "Deleting..." : "Delete"}
    </Button>
  );
}
