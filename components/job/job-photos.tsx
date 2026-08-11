"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Image as ImageIcon, Upload, Trash2, X, ZoomIn } from "lucide-react";
import { formatDate } from "@/lib/date";
import { photoTagColors } from "@/lib/badge-colors";

interface Props {
  jobId: string;
  photos: any[];
  onUpdate: (photos: any[]) => void;
  currentUserId: string;
}

export function JobPhotos({ jobId, photos, onUpdate, currentUserId }: Props) {
  const supabase = createClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [photoType, setPhotoType] = useState<string>("general");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  async function getUrl(path: string) {
    if (signedUrls[path]) return signedUrls[path];
    const { data } = await supabase.storage.from("job-photos").createSignedUrl(path, 3600);
    if (data?.signedUrl) {
      setSignedUrls((prev) => ({ ...prev, [path]: data.signedUrl }));
      return data.signedUrl;
    }
    return "";
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);

    // The upload was checked and the ROW INSERT was not — the same asymmetry as
    // the delete below. A refused insert leaves the file in the bucket with
    // nothing referencing it: the photo never appears, and "Photos uploaded"
    // says otherwise. On a job where photos are the evidence of what was done,
    // the technician has no reason to look again.
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      const path = `${jobId}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: uploadError } = await supabase.storage.from("job-photos").upload(path, file);
      if (uploadError) { failed.push(file.name); continue; }

      const { error: rowError } = await supabase.from("job_photos").insert({
        job_id: jobId,
        uploaded_by: currentUserId,
        storage_path: path,
        photo_type: photoType,
      });
      if (rowError) {
        console.error("job-photos: file uploaded but row not recorded", path, rowError);
        failed.push(file.name);
      }
    }

    const { data } = await supabase.from("job_photos").select("*, profiles(full_name)").eq("job_id", jobId).order("created_at", { ascending: false });
    onUpdate(data ?? []);
    if (failed.length) {
      toast.error(`${failed.length} photo(s) did not save: ${failed.join(", ")}. Please try again.`);
    } else {
      toast.success("Photos uploaded");
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleDelete(photo: { id: string; storage_path: string }) {
    // The ROW goes first, and its result is checked before the object is
    // touched. Both were previously fired and ignored, with an unconditional
    // success toast — which was harmless only while everyone could delete
    // everything. Migration 0049 WOULD scope both to office/admin or the job's
    // assigned technician — it is DRAFTED AND NOT APPLIED, so production's only
    // job_photos policy is still 0000_baseline.sql:165,
    // `for all using (auth.role() = 'authenticated')`.
    //
    // The checking below is right either way, and that is the point: neither
    // call throws on a refusal — storage.remove() returns { data, error }, and
    // a PostgREST delete that RLS filters out succeeds against zero rows — so
    // the handling does not depend on which policy is in force. Today a
    // zero-row result means the row was already gone; once 0049 is applied it
    // can also mean refused. Both are handled.
    //
    // Row first because it is the authoritative record and it fails closed: if
    // it is refused, nothing has been destroyed and nothing is orphaned. The
    // old order removed the file first, so a refused row delete left a photo
    // the app still listed but could no longer display.
    const { error: rowError, count } = await supabase
      .from("job_photos")
      .delete({ count: "exact" })
      .eq("id", photo.id);

    if (rowError) {
      toast.error(`Could not delete photo: ${rowError.message}`);
      return;
    }
    if (count === 0) {
      // Deliberately does NOT name the reason. Migration 0049, which scopes
      // this delete to office/admin or the job's assigned technician, is
      // DRAFTED AND NOT APPLIED — production's only job_photos policy is still
      // 0000_baseline.sql:165, `for all using (auth.role() = 'authenticated')`.
      // So today a zero-row result means the row is already gone, not that
      // permission was refused, and the old wording stated a rule that is not
      // in force. Once 0049 is applied both readings are true and this stays
      // correct; asserting the stricter one now would be telling the user
      // something false about the system.
      toast.error("That photo could not be removed — it may already have been deleted. Refresh and try again.");
      return;
    }

    // Checking `error` alone is not enough. A bulk remove that RLS filters out
    // comes back HTTP 200 with an EMPTY ARRAY — no error at all — so the only
    // reliable signal that the file actually went is that it is named in `data`.
    const { data: removed, error: objectError } = await supabase.storage
      .from("job-photos")
      .remove([photo.storage_path]);

    if (objectError || !removed?.length) {
      // The record is gone, so the photo has left every screen and report —
      // which is what the user asked for. The file is now an orphan. Say so
      // rather than reporting a clean delete.
      console.error("job-photos: row deleted but object remains", photo.storage_path, objectError);
      toast.warning("Photo removed, but the file could not be cleaned up.");
    } else {
      toast.success("Photo deleted");
    }

    onUpdate(photos.filter((p) => p.id !== photo.id));
  }

  async function openLightbox(path: string) {
    const url = await getUrl(path);
    setLightbox(url);
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Photos</h2>
          <p className="text-sm text-slate-500">{photos.length} photo{photos.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={photoType} onValueChange={(v) => setPhotoType(v ?? "general")}>
            <SelectTrigger className="w-32 h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="before">Before</SelectItem>
              <SelectItem value="after">After</SelectItem>
              <SelectItem value="general">General</SelectItem>
            </SelectContent>
          </Select>
          <input ref={inputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleUpload} />
          <Button onClick={() => inputRef.current?.click()} disabled={uploading} className="gap-2 h-9">
            <Upload className="w-4 h-4" />
            {uploading ? "Uploading..." : "Upload Photos"}
          </Button>
        </div>
      </div>

      {photos.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-16 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50 transition-colors"
          onClick={() => inputRef.current?.click()}
        >
          <ImageIcon className="w-12 h-12 mb-3 opacity-40" />
          <p className="text-sm font-medium">No photos yet</p>
          <p className="text-xs mt-1">Click to upload site photos</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {photos.map((photo) => (
            <PhotoCard
              key={photo.id}
              photo={photo}
              onOpen={() => openLightbox(photo.storage_path)}
              onDelete={() => handleDelete(photo)}
              getUrl={getUrl}
              tagColors={photoTagColors}
            />
          ))}
        </div>
      )}

      <Dialog open={!!lightbox} onOpenChange={() => setLightbox(null)}>
        <DialogContent className="max-w-4xl p-2 bg-black border-0">
          {lightbox && <img src={lightbox} alt="Job photo" className="w-full h-auto max-h-[85vh] object-contain rounded" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PhotoCard({ photo, onOpen, onDelete, getUrl, tagColors }: any) {
  const [url, setUrl] = useState<string>("");
  const supabase = createClient();

  useState(() => {
    getUrl(photo.storage_path).then(setUrl);
  });

  return (
    <div className="group relative aspect-square rounded-lg overflow-hidden bg-slate-100 cursor-pointer" onClick={onOpen}>
      {url && <img src={url} alt="" className="w-full h-full object-cover" />}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
        <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      <div className="absolute top-1.5 left-1.5">
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${tagColors[photo.photo_type]}`}>
          {photo.photo_type}
        </span>
      </div>
      <button
        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        <X className="w-3 h-3" />
      </button>
      <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs p-1 opacity-0 group-hover:opacity-100 transition-opacity truncate">
        {formatDate(photo.created_at)}
      </div>
    </div>
  );
}
