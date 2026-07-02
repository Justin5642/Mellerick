"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, Send } from "lucide-react";

interface Props {
  jobId: string;
  notes: any[];
  onUpdate: (notes: any[]) => void;
  currentUserId: string;
}

export function JobNotes({ jobId, notes, onUpdate, currentUserId }: Props) {
  const supabase = createClient();
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!content.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("job_notes").insert({
      job_id: jobId,
      author_id: currentUserId,
      content: content.trim(),
    });
    if (error) { toast.error(error.message); setSaving(false); return; }
    const { data } = await supabase.from("job_notes").select("*, profiles(full_name)").eq("job_id", jobId).order("created_at", { ascending: false });
    onUpdate(data ?? []);
    setContent("");
    setSaving(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAdd();
  }

  return (
    <div className="p-6 flex flex-col gap-4 h-full">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Notes & Activity</h2>
        <p className="text-sm text-slate-500">Job log visible to all staff</p>
      </div>

      {/* Add note */}
      <div className="flex gap-2">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a note... (Cmd+Enter to save)"
          rows={2}
          className="resize-none flex-1 text-sm"
        />
        <Button onClick={handleAdd} disabled={saving || !content.trim()} className="self-end gap-2 h-9">
          <Send className="w-3.5 h-3.5" />
          {saving ? "..." : "Add"}
        </Button>
      </div>

      {/* Notes list */}
      {notes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl flex-1">
          <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">No notes yet</p>
          <p className="text-xs mt-1">Add the first note above</p>
        </div>
      ) : (
        <div className="space-y-3 flex-1 overflow-y-auto">
          {notes.map((note) => (
            <div key={note.id} className="flex gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex-shrink-0 mt-0.5">
                {note.profiles?.full_name?.slice(0, 2).toUpperCase() ?? "?"}
              </div>
              <div className="flex-1 bg-white border border-slate-200 rounded-lg px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-slate-700">{note.profiles?.full_name ?? "Unknown"}</span>
                  <span className="text-xs text-slate-400">
                    {new Date(note.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })} at {new Date(note.created_at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{note.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
