"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

// Standalone client island for the Customers list page (a server component),
// so marking/unmarking a favourite doesn't need the whole page to become a
// client component. Sits inside a <Link> row, so clicks must stop
// propagation or they'd also navigate to the customer's detail page.
export function CustomerFavoriteButton({ customerId, initialFavorite }: { customerId: string; initialFavorite: boolean }) {
  const supabase = createClient();
  const [isFavorite, setIsFavorite] = useState(initialFavorite);
  const [saving, setSaving] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (saving) return;
    setSaving(true);
    const next = !isFavorite;
    setIsFavorite(next);
    const { error } = await supabase.from("customers").update({ is_favorite: next }).eq("id", customerId);
    if (error) setIsFavorite(!next);
    setSaving(false);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="shrink-0 p-1 -m-1 rounded hover:bg-slate-100"
      title={isFavorite ? "Remove from favourites" : "Mark as favourite"}
    >
      <Star className={cn("w-4 h-4", isFavorite ? "fill-amber-400 text-amber-400" : "text-slate-300")} />
    </button>
  );
}
