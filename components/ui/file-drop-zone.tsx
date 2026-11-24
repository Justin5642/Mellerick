"use client";

// A whole area that takes files three ways besides its own Upload button:
// dropped from the desktop (several at once), dragged straight from another
// browser tab or an email when the browser hands over the file, and pasted
// (Ctrl/Cmd+V of a screenshot or a copied file) while the area is on screen.
// Used by the job's Photos and Documents tabs. The single-file box for forms
// is components/ui/file-dropzone.tsx; the rules are in lib/file-drop.ts.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  dragHasFiles,
  droppedOnlyALink,
  inlineImageUrls,
  pasteTargetIsEditable,
  pastedFileName,
  rejectionMessage,
  splitAcceptedFiles,
} from "@/lib/file-drop";

// A drag that started on this page (a link, an image, a schedule card) is not
// an upload. Browsers don't say where a drag came from, so we remember it.
let dragStartedHere = false;
if (typeof window !== "undefined") {
  window.addEventListener("dragstart", () => { dragStartedHere = true; }, true);
  window.addEventListener("dragend", () => { dragStartedHere = false; }, true);
  window.addEventListener("drop", () => { dragStartedHere = false; }, true);
}

function isUploadDrag(types: readonly string[]): boolean {
  if (dragHasFiles(types)) return true;
  // An image dragged from another tab that the browser won't hand over as a
  // file still arrives as a link; accept the drop so we can say what to do.
  return !dragStartedHere && Array.from(types).includes("text/uri-list");
}

async function dataUrlToFile(url: string, index: number): Promise<File | null> {
  try {
    const blob = await (await fetch(url)).blob();
    return new File([blob], pastedFileName({ name: "", type: blob.type }, new Date(), index), { type: blob.type });
  } catch {
    return null;
  }
}

export interface FileDropZoneProps {
  onFiles: (files: File[]) => void | Promise<void>;
  /** The same `accept` string as the area's file input (checked here: the browser doesn't for a drop or paste). */
  accept?: string;
  /** Plain-words list of what is accepted, used in the refusal message ("photos (JPEG, PNG, HEIC…)"). */
  hint?: string;
  /** What the overlay says: "Drop photos to upload". */
  label?: string;
  /** Read-only views: no drop, no paste. */
  disabled?: boolean;
  /** An upload is running: further drops/pastes are refused with a message instead of overlapping. */
  busy?: boolean;
  /** Take Ctrl/Cmd+V while this area is on screen. Default true. */
  paste?: boolean;
  className?: string;
  children: ReactNode;
}

export function FileDropZone({ onFiles, accept, hint, label = "Drop files to upload", disabled, busy, paste = true, className, children }: FileDropZoneProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Counter, not a boolean: dragenter/dragleave fire for every child element the
  // cursor crosses, which would make a boolean flicker off mid-drag.
  const [depth, setDepth] = useState(0);
  const active = depth > 0 && !disabled;

  // Latest props for the window paste listener without re-binding it.
  const latest = useRef({ onFiles, accept, hint, busy, disabled });
  latest.current = { onFiles, accept, hint, busy, disabled };

  function deliver(files: File[]) {
    const { onFiles: send, accept: acc, hint: h, busy: isBusy, disabled: off } = latest.current;
    if (off || files.length === 0) return;
    if (isBusy) {
      toast.info("Wait for the current upload to finish, then try again.");
      return;
    }
    const { accepted, rejected } = splitAcceptedFiles(files, acc);
    const refusal = rejectionMessage(rejected, h);
    if (refusal) toast.error(refusal);
    if (accepted.length) void send(accepted);
  }

  useEffect(() => {
    if (disabled || !paste) return;
    function onPaste(e: ClipboardEvent) {
      const el = ref.current;
      // Only while this area is actually showing (tabs unmount, but be sure).
      if (!el || !el.isConnected || el.getClientRects().length === 0) return;
      if (pasteTargetIsEditable(e.target as HTMLElement | null)) return;
      // A dialog over the page (the photo viewer) owns the paste.
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog && !dialog.contains(el)) return;
      const data = e.clipboardData;
      if (!data) return;
      let files = Array.from(data.files ?? []);
      if (files.length === 0) {
        files = Array.from(data.items ?? [])
          .filter((i) => i.kind === "file")
          .map((i) => i.getAsFile())
          .filter((f): f is File => !!f);
      }
      if (files.length === 0) return; // plain text: not ours
      e.preventDefault();
      const now = new Date();
      deliver(files.map((f, i) => {
        const name = pastedFileName(f, now, files.length > 1 ? i : 0);
        return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified });
      }));
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // deliver reads `latest`, so only these switch the listener on and off.
  }, [disabled, paste]);

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDepth(0);
    if (disabled) return;
    const dt = e.dataTransfer;
    const files = Array.from(dt.files ?? []);
    if (files.length) return deliver(files);
    // No file handed over: an inline (data:) image can still be rebuilt here.
    const uriList = dt.getData("text/uri-list");
    const html = dt.getData("text/html");
    const inline = inlineImageUrls(uriList, html);
    if (inline.length) {
      const rebuilt = (await Promise.all(inline.map(dataUrlToFile))).filter((f): f is File => !!f);
      if (rebuilt.length) return deliver(rebuilt);
    }
    if (droppedOnlyALink(uriList, html)) {
      toast.error("That page didn't hand the file over. Save it to your computer first, then drop or upload it here.");
    }
  }

  return (
    <div
      ref={ref}
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (disabled || !isUploadDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        setDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (disabled || !isUploadDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (disabled || !isUploadDrag(e.dataTransfer.types)) return;
        setDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={onDrop}
      data-drop-active={active || undefined}
    >
      {children}
      {active && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 rounded-xl border-2 border-dashed border-blue-400 bg-blue-50/80 text-blue-700"
        >
          {/* Sticky, so the prompt stays in view over a long list. */}
          <div className="sticky top-16 flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Upload className="h-8 w-8" />
            <p className="text-sm font-semibold">{label}</p>
            {hint && <p className="text-xs text-blue-600/80">{hint}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
