import { Undo2 } from "lucide-react";
import { sentBackNotice, sentBackWhen, type SentBackJob } from "@/lib/sent-back";

// "Sent back by the office" — shown on the job to its crew and the office while
// the job is sent back and open (0122, a draft; rule in lib/sent-back.ts). Not on
// view-only jobs: the page strips the columns for a technician not on the job.
export function SentBackBanner({ job, className = "" }: { job: SentBackJob; className?: string }) {
  const notice = sentBackNotice(job);
  if (!notice) return null;
  const when = sentBackWhen(notice.at);
  return (
    <div
      role="alert"
      className={`rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 ${className}`}
    >
      <div className="flex items-center gap-2 font-semibold">
        <Undo2 className="h-4 w-4" aria-hidden />
        Sent back by the office{when ? <span className="font-normal text-red-700"> · {when}</span> : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap">
        {notice.note ?? "Ask the office what's needed before it can be approved."}
      </p>
      <p className="mt-1 text-xs text-red-700">Sort it out, then sign the job off again — it goes back to the office for approval.</p>
    </div>
  );
}
