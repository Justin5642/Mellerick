"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ArrowDown, ArrowUp, Plus } from "lucide-react";

// Settings → Mistake categories (0119, a draft not applied yet): the list the crew pick from when they
// log a mistake. Office/admin edit it (RLS); a category in use is retired, not
// deleted, so old mistakes keep their label.

interface Category {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export default function MistakeCategoriesPage() {
  const [rows, setRows] = useState<Category[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const { data, error } = await createClient().from("mistake_categories").select("id, name, sort_order, is_active").order("sort_order").order("name");
    if (error) {
      if (["42P01", "PGRST205"].includes(error.code ?? "")) setNotReady(true);
      else toast.error("Couldn't load the categories.");
      setRows([]);
      return;
    }
    setRows((data ?? []) as Category[]);
  }
  useEffect(() => {
    void load();
  }, []);

  async function add() {
    const n = name.trim();
    if (!n || n.length > 80) return toast.error("Enter a name (up to 80 characters).");
    setSaving(true);
    const max = Math.max(0, ...(rows ?? []).map((r) => r.sort_order));
    const { error } = await createClient().from("mistake_categories").insert({ name: n, sort_order: max + 10 });
    setSaving(false);
    if (error) return toast.error(error.code === "23505" ? "There's already a category with that name." : "Couldn't add the category.");
    setName("");
    void load();
  }

  async function update(id: string, patch: Partial<Category>) {
    const { error } = await createClient().from("mistake_categories").update(patch).eq("id", id);
    if (error) return toast.error(error.code === "23505" ? "There's already a category with that name." : "Couldn't save the category.");
    void load();
  }

  async function move(i: number, dir: -1 | 1) {
    if (!rows) return;
    const a = rows[i];
    const b = rows[i + dir];
    if (!a || !b) return;
    const supabase = createClient();
    const first = await supabase.from("mistake_categories").update({ sort_order: b.sort_order }).eq("id", a.id);
    const second = first.error
      ? first
      : await supabase.from("mistake_categories").update({ sort_order: a.sort_order === b.sort_order ? a.sort_order + dir : a.sort_order }).eq("id", b.id);
    if (first.error || second.error) toast.error("Couldn't change the order.");
    void load();
  }

  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <Link href="/dashboard/settings" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="w-4 h-4" /> Settings
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mistake categories</CardTitle>
          <CardDescription>What the crew pick from when they log a mistake. Retire a category instead of deleting it, so old mistakes keep their label.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {notReady ? (
            <p className="text-sm text-slate-500">Mistake categories arrive with the 0119 database update, which hasn&apos;t been applied yet.</p>
          ) : !rows ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (
            <>
              <div className="divide-y divide-slate-100 rounded border border-slate-200">
                {rows.map((r, i) => (
                  <div key={r.id} className="flex items-center gap-2 px-3 py-2">
                    <Input
                      defaultValue={r.name}
                      maxLength={80}
                      className={r.is_active ? "" : "text-slate-400"}
                      onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== r.name && void update(r.id, { name: e.target.value.trim() })}
                    />
                    <button type="button" aria-label="Move up" className="p-1 text-slate-400 hover:text-slate-700" onClick={() => void move(i, -1)}>
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button type="button" aria-label="Move down" className="p-1 text-slate-400 hover:text-slate-700" onClick={() => void move(i, 1)}>
                      <ArrowDown className="w-4 h-4" />
                    </button>
                    <Button size="sm" variant="outline" onClick={() => void update(r.id, { is_active: !r.is_active })}>
                      {r.is_active ? "Retire" : "Bring back"}
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input placeholder="New category" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
                <Button onClick={() => void add()} disabled={saving} className="gap-1">
                  <Plus className="w-4 h-4" /> Add
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
