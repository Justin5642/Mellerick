"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fileMatchesAccept } from "@/lib/file-accept";

type FileDropzoneProps = {
  file: File | null;
  onFileChange: (file: File | null) => void;
  /** Same format as <input accept>; also enforced on drop, which the browser doesn't do. */
  accept?: string;
  /** Shown under the main prompt, e.g. "PDF, PNG or JPG". */
  hint?: string;
  /** Smaller single-line version for tight spots (e.g. the PO supplier-invoice row). */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
};

/**
 * Click-or-drop single-file picker. The whole box is the target (click, Enter/Space,
 * or drag a file onto it) and the chosen file shows as a removable chip, replacing
 * the browser's "Choose File / No file chosen" input.
 */
export function FileDropzone({ file, onFileChange, accept, hint, compact, disabled, className }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Counter, not a boolean: dragenter/dragleave fire for every child element the
  // cursor crosses, which would make a boolean flicker off mid-drag.
  const [dragDepth, setDragDepth] = useState(0);
  const dragActive = dragDepth > 0;

  function pick(candidate: File | undefined | null) {
    if (!candidate) return;
    if (!fileMatchesAccept(candidate, accept)) {
      toast.error(`${candidate.name} isn't a supported file type${hint ? ` (${hint})` : ""}`);
      return;
    }
    onFileChange(candidate);
  }

  const open = () => { if (!disabled) inputRef.current?.click(); };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={file ? `Attached file ${file.name}. Click to replace.` : "Attach a file: click to browse or drag and drop"}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      }}
      onDragEnter={(e) => { e.preventDefault(); if (!disabled) setDragDepth((d) => d + 1); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = disabled ? "none" : "copy"; }}
      onDragLeave={(e) => { e.preventDefault(); setDragDepth((d) => Math.max(0, d - 1)); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragDepth(0);
        if (disabled) return;
        if (e.dataTransfer.files.length > 1) toast.info("Only one file can be attached here — using the first one");
        pick(e.dataTransfer.files?.[0]);
      }}
      className={cn(
        "rounded-md border-2 border-dashed text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-400",
        compact ? "flex items-center gap-2 px-2 py-1.5 text-left" : "flex flex-col items-center justify-center gap-1.5 p-4",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        dragActive
          ? "border-blue-400 bg-blue-50/60 text-blue-600"
          : file
            ? "border-slate-200 bg-slate-50/50 text-slate-700"
            : "border-slate-200 text-slate-400 hover:border-slate-300 hover:bg-slate-50/50",
        className,
      )}
    >
      {file && !dragActive ? (
        <div className={cn("flex min-w-0 items-center gap-2", compact ? "flex-1" : "max-w-full")}>
          <FileText className="h-4 w-4 shrink-0 text-slate-500" />
          <span className={cn("truncate text-slate-700", compact ? "text-[11px]" : "text-sm")}>{file.name}</span>
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            onClick={(e) => { e.stopPropagation(); onFileChange(null); if (inputRef.current) inputRef.current.value = ""; }}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-red-500"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <>
          <Upload className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "h-5 w-5 opacity-60")} />
          <p className={compact ? "text-[11px]" : "text-xs"}>
            {dragActive ? "Drop to attach" : (
              <>Drag and drop a file here, or <span className="font-medium text-blue-600">browse</span></>
            )}
          </p>
          {hint && !compact && !dragActive && <p className="text-[11px] text-slate-400">{hint}</p>}
        </>
      )}
      {file && !compact && !dragActive && <p className="text-[11px] text-slate-400">Click or drop another file to replace</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }}
      />
    </div>
  );
}
