"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, Send, Sparkles } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatTime } from "@/lib/date";
import { JOB_STAGES, getJobStageLabel } from "@/lib/job-stages";

interface Props {
  jobId: string;
  notes: any[];
  onUpdate: (notes: any[]) => void;
  currentUserId: string;
  stageNotes: any[];
  onUpdateStageNotes: (notes: any[]) => void;
}

export function JobNotes({ jobId, notes, onUpdate, currentUserId, stageNotes, onUpdateStageNotes }: Props) {
  const supabase = createClient();
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);

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

  // Sends the current draft (typically dictated via the phone's voice-to-text
  // keyboard) to the server for AI cleanup, then drops the result back into
  // the textarea for the tech to review/edit — it's never auto-saved, so a
  // bad rewrite can just be edited or discarded before hitting Add.
  async function handlePolish() {
    if (!content.trim() || polishing) return;
    setPolishing(true);
    try {
      const res = await fetch("/api/ai/polish-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "AI polish failed"); return; }
      setContent(data.polished);
    } catch {
      toast.error("AI polish failed");
    } finally {
      setPolishing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAdd();
  }

  const [stageFilter, setStageFilter] = useState<string>("all");
  const [stageForNewNote, setStageForNewNote] = useState<string>("");
  const [stageContent, setStageContent] = useState("");
  const [stageSaving, setStageSaving] = useState(false);

  async function handleAddStageNote() {
    if (!stageContent.trim() || !stageForNewNote) return;
    setStageSaving(true);
    const { error } = await supabase.from("job_stage_notes").insert({
      job_id: jobId,
      stage: stageForNewNote,
      author_id: currentUserId,
      content: stageContent.trim(),
    });
    if (error) { toast.error(error.message); setStageSaving(false); return; }
    const { data } = await supabase.from("job_stage_notes").select("*, profiles(full_name)").eq("job_id", jobId).order("created_at", { ascending: false });
    onUpdateStageNotes(data ?? []);
    setStageContent("");
    setStageSaving(false);
  }

  // Grouped by stage in the fixed workflow order (rather than by timestamp)
  // so "history builds up stage by stage" — a technician opening the drain
  // stage's history sees every drain note together, not interleaved with
  // fit-off notes from a different visit.
  const stagesToShow = stageFilter === "all" ? JOB_STAGES : JOB_STAGES.filter((s) => s.value === stageFilter);
  const stageNotesByStage = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const stage of JOB_STAGES) map.set(stage.value, []);
    for (const note of stageNotes) {
      if (!map.has(note.stage)) map.set(note.stage, []);
      map.get(note.stage)!.push(note);
    }
    return map;
  }, [stageNotes]);

  return (
    <div className="p-6 flex flex-col gap-6 h-full overflow-y-auto">
      {/* Stage notes */}
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Stage Notes</h2>
          <p className="text-sm text-slate-500">History by workflow stage — visible to everyone on this job</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Select value={stageForNewNote} onValueChange={(v) => setStageForNewNote(v ?? "")}>
            <SelectTrigger className="sm:w-44"><SelectValue placeholder="Select stage..." /></SelectTrigger>
            <SelectContent>
              {JOB_STAGES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={stageContent}
            onChange={(e) => setStageContent(e.target.value)}
            placeholder={stageForNewNote ? `Add a note for the ${getJobStageLabel(stageForNewNote)} stage...` : "Pick a stage first..."}
            rows={2}
            className="resize-none text-sm flex-1"
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={handleAddStageNote} disabled={stageSaving || !stageContent.trim() || !stageForNewNote} className="gap-2 h-9">
            <Send className="w-3.5 h-3.5" />
            {stageSaving ? "..." : "Add stage note"}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setStageFilter("all")}
            className={`text-xs px-2.5 py-1 rounded-full border ${stageFilter === "all" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200"}`}
          >
            All stages
          </button>
          {JOB_STAGES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setStageFilter(s.value)}
              className={`text-xs px-2.5 py-1 rounded-full border ${stageFilter === s.value ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200"}`}
            >
              {s.label} ({stageNotesByStage.get(s.value)?.length ?? 0})
            </button>
          ))}
        </div>

        {stageNotes.length === 0 ? (
          <p className="text-xs text-slate-400 py-2">No stage notes yet — pick a stage above to log the first one.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {stagesToShow.map((stage) => {
              const stageItems = stageNotesByStage.get(stage.value) ?? [];
              if (stageItems.length === 0) return null;
              return (
                <div key={stage.value} className="flex flex-col gap-2">
                  <Badge variant="outline" className="w-fit text-xs">{stage.label}</Badge>
                  <div className="space-y-2">
                    {stageItems.map((note) => (
                      <div key={note.id} className="bg-white border border-slate-200 rounded-lg px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-slate-700">{note.profiles?.full_name ?? "Unknown"}</span>
                          <span className="text-xs text-slate-400">
                            {formatDate(note.created_at, { day: "numeric", month: "short", year: "numeric" })} at {formatTime(note.created_at)}
                          </span>
                        </div>
                        <p className="text-sm text-slate-700 whitespace-pre-wrap">{note.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-slate-200" />

      <div>
        <h2 className="text-base font-semibold text-slate-900">Notes & Activity</h2>
        <p className="text-sm text-slate-500">General job log visible to all staff</p>
      </div>

      {/* Add note */}
      <div className="flex flex-col gap-2">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a note, or dictate one with your keyboard's mic then tap Polish... (Cmd+Enter to save)"
          rows={3}
          className="resize-none text-sm"
        />
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handlePolish}
            disabled={polishing || !content.trim()}
            className="gap-1.5 text-slate-600"
            title="Clean up grammar and voice-to-text artifacts with AI"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {polishing ? "Polishing..." : "Polish with AI"}
          </Button>
          <Button onClick={handleAdd} disabled={saving || !content.trim()} className="gap-2 h-9">
            <Send className="w-3.5 h-3.5" />
            {saving ? "..." : "Add"}
          </Button>
        </div>
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
                    {formatDate(note.created_at, { day: "numeric", month: "short", year: "numeric" })} at {formatTime(note.created_at)}
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
