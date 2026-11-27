"use client";

import { Download } from "lucide-react";

/** Saves CSV text the server already built (hours only — no money) as a file. */
export function DownloadCsvButton({ csv, fileName }: { csv: string; fileName: string }) {
  const download = () => {
    // BOM so Excel reads the file as UTF-8 (names with accents, "→").
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button
      type="button"
      onClick={download}
      className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      <Download className="w-4 h-4 text-blue-600" /> Download CSV
    </button>
  );
}
