"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fileMatchesAccept } from "@/lib/file-accept";
import { resizeImageForUpload } from "@/lib/image-resize";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_HINT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  formatBytes,
} from "@/lib/invoice-attachments";

export type PickedAttachment = { id: string; file: File };

/**
 * Drag files onto the Send Invoice dialog (or browse) to email them with the
 * invoice. Photos are shrunk first; the total is held under the send limit.
 */
export function InvoiceAttachmentsField({
  value,
  onChange,
  disabled,
}: {
  value: PickedAttachment[];
  onChange: (next: PickedAttachment[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [busy, setBusy] = useState(false);
  const total = value.reduce((s, a) => s + a.file.size, 0);

  async function add(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    const next = [...value];
    let size = total;
    for (const original of files) {
      if (!fileMatchesAccept(original, ATTACHMENT_ACCEPT)) {
        toast.error(`${original.name} can't be attached (${ATTACHMENT_HINT})`);
        continue;
      }
      if (next.length >= MAX_ATTACHMENTS) {
        toast.error(`At most ${MAX_ATTACHMENTS} files can be attached`);
        break;
      }
      const file = await resizeImageForUpload(original).catch(() => original);
      if (size + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        toast.error(`${original.name} (${formatBytes(file.size)}) would take the attachments over ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}`);
        continue;
      }
      size += file.size;
      next.push({ id: crypto.randomUUID(), file });
    }
    onChange(next);
    setBusy(false);
  }

  const open = () => { if (!disabled && !busy) inputRef.current?.click(); };

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-label="Attach files to the email: click to browse or drag and drop"
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
        onDragEnter={(e) => { e.preventDefault(); if (!disabled) setDragDepth((d) => d + 1); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = disabled ? "none" : "copy"; }}
        onDragLeave={(e) => { e.preventDefault(); setDragDepth((d) => Math.max(0, d - 1)); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragDepth(0);
          if (!disabled) void add(Array.from(e.dataTransfer.files ?? []));
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed p-3 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-400",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          dragDepth > 0
            ? "border-blue-400 bg-blue-50/60 text-blue-600"
            : "border-slate-200 text-slate-400 hover:border-slate-300 hover:bg-slate-50/50",
        )}
      >
        <Paperclip className="h-4 w-4 opacity-60" />
        <p className="text-xs">
          {busy ? "Adding…" : dragDepth > 0 ? "Drop to attach" : (
            <>Drag files here to attach them, or <span className="font-medium text-blue-600">browse</span></>
          )}
        </p>
        <p className="text-[11px] text-slate-400">{ATTACHMENT_HINT}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }}
        />
      </div>
      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50/50 px-2 py-1 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-slate-500" />
              <span className="min-w-0 flex-1 truncate text-slate-700">{a.file.name}</span>
              <span className="shrink-0 text-[11px] text-slate-400">{formatBytes(a.file.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${a.file.name}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((x) => x.id !== a.id))}
                className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-red-500"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          <li className="text-right text-[11px] text-slate-400">
            {formatBytes(total)} of {formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}
          </li>
        </ul>
      )}
    </div>
  );
}

/** Base64 of a file, without the data: prefix. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
