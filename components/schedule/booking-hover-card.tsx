"use client";

// The schedule board's hover card (25 Nov 2026): rest the mouse on a booking
// and, after HOVER_OPEN_MS, a card shows the job's details — customer, the
// full site address, site notes, who/when, cost centre, booking note, the
// rest of the crew that day, priority, description — so the office doesn't
// have to open the job. Content comes from lib/schedule-hover.ts (no money,
// ever).
//
// Mouse only: touch keeps press-and-hold for the booking menu, and a pen's
// hover is ignored. Keyboard focus on a booking (Tab) shows it too. It hides
// on mouse leave (with a short grace so the pointer can reach "Open job"),
// on any press, scroll, Esc, and when a drag, a resize, the booking menu or a
// pick mode starts — the board passes `suppressed` for those.
import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CalendarClock, MapPin, Navigation, StickyNote, User, Users } from "lucide-react";
import { DIDNT_MAKE_IT } from "@/lib/booking-attendance";
import { HOVER_CLOSE_MS, HOVER_OPEN_MS, hoverCardPlacement, type HoverCardDetails } from "@/lib/schedule-hover";
import { cn } from "@/lib/utils";

export type HoverTarget<T> = { item: T; anchor: DOMRect };

/**
 * The hover card's timing. `enter` on a booking starts the open timer;
 * `leave` cancels it, or closes an open card after the grace; `keep` (the
 * card's own pointer-enter) cancels that close; `show` opens at once (focus);
 * `hide` closes at once.
 */
export function useHoverCard<T>(suppressed: boolean) {
  const [target, setTarget] = useState<HoverTarget<T> | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setTarget(null);
  }, [clearTimers]);

  const show = useCallback(
    (item: T, el: HTMLElement) => {
      clearTimers();
      setTarget({ item, anchor: el.getBoundingClientRect() });
    },
    [clearTimers],
  );

  const enter = useCallback(
    (item: T, el: HTMLElement) => {
      clearTimers();
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        // Still under the mouse? (A drag or a re-render may have moved it.)
        if (el.isConnected) setTarget({ item, anchor: el.getBoundingClientRect() });
      }, HOVER_OPEN_MS);
    },
    [clearTimers],
  );

  const leave = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setTarget(null);
    }, HOVER_CLOSE_MS);
  }, []);

  const keep = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  // A drag, resize, menu or pick mode: no card, and none pending.
  const [wasSuppressed, setWasSuppressed] = useState(suppressed);
  if (wasSuppressed !== suppressed) {
    setWasSuppressed(suppressed);
    if (suppressed && target) setTarget(null);
  }
  useEffect(() => {
    if (suppressed) clearTimers();
  }, [suppressed, clearTimers]);

  // Any scroll (the board's own scrollers included), a resize or Esc closes it.
  const open = target !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, hide]);

  useEffect(() => clearTimers, [clearTimers]);

  return { target: suppressed ? null : target, enter, leave, keep, show, hide };
}

/** Pointer and focus wiring for one booking block — spread on its outer element. */
export function hoverHandlers<T>(
  card: Pick<ReturnType<typeof useHoverCard<T>>, "enter" | "leave" | "show" | "hide">,
  item: T,
  describedBy: string | undefined,
) {
  return {
    "aria-describedby": describedBy,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse" && e.buttons === 0) card.enter(item, e.currentTarget);
    },
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse") card.leave();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      // Keyboard focus only — a click focuses the link too, and then opens the job.
      if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) card.show(item, e.currentTarget);
    },
    onBlur: () => card.hide(),
    // Any press — a click, a drag, the hold menu — closes it first.
    onPointerDownCapture: () => card.hide(),
  };
}

function Row({ icon: Icon, children, className }: { icon: typeof MapPin; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex gap-2", className)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-slate-400" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** The card itself, portalled to <body> and placed beside the booking inside the viewport. */
export function BookingHoverCard({
  id,
  anchor,
  details,
  href,
  navigateUrl,
  completed,
  overText,
  leaveText,
  actualText = null,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  anchor: DOMRect;
  details: HoverCardDetails;
  href: string;
  navigateUrl: string | null;
  completed: boolean;
  /** "Over hours: 34 h of 30 h (Drainage)" — office/admin only; null otherwise. */
  overText: string | null;
  /** The technician is on leave that day (Needs reassigning). */
  leaveText: string | null;
  /** "Clocked 7:42–3:10 · 7.5 h" — what was actually clocked (office/admin only; null otherwise). */
  actualText?: string | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(hoverCardPlacement(anchor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor, details]);

  const d = details;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-booking-hover-card
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="fixed z-50 w-80 max-h-[80vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-xl"
      style={{ left: pos?.x ?? anchor.right, top: pos?.y ?? anchor.top, visibility: pos ? "visible" : "hidden" }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-slate-900">{d.heading}</p>
        <span className="flex flex-shrink-0 flex-col items-end gap-0.5">
          <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-semibold", completed ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-700")}>
            {completed ? "✓ " : ""}
            {d.status}
          </span>
          {d.priority && <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">{d.priority}</span>}
        </span>
      </div>

      {(overText || leaveText || d.attendance) && (
        <div className="mt-2 space-y-1">
          {d.attendance && (
            <p className={cn("rounded px-2 py-1 font-semibold", d.attendance.startsWith(DIDNT_MAKE_IT) ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-800")}>
              {d.attendance}
            </p>
          )}
          {leaveText && <p className="rounded bg-rose-50 px-2 py-1 font-semibold text-rose-800">{leaveText}</p>}
          {overText && (
            <p className="flex items-center gap-1 rounded bg-amber-50 px-2 py-1 font-semibold text-amber-800">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" aria-hidden />
              {overText}
            </p>
          )}
        </div>
      )}

      <div className="mt-2 space-y-2">
        {(d.customer || d.address.length > 0) && (
          <Row icon={MapPin}>
            {d.customer && <p className="font-semibold text-slate-900">{d.customer}</p>}
            {d.attention && <p className="text-slate-500">Attn: {d.attention}</p>}
            {d.address.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {navigateUrl && (
              <a href={navigateUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-blue-600 hover:underline">
                <Navigation className="h-3 w-3" aria-hidden />
                Navigate
              </a>
            )}
          </Row>
        )}
        {d.siteNotes && (
          <Row icon={StickyNote}>
            <p className="whitespace-pre-line text-slate-600">{d.siteNotes}</p>
          </Row>
        )}
        <Row icon={User}>
          <p>
            <span className="font-semibold text-slate-900">{d.technician}</span>
          </p>
        </Row>
        <Row icon={CalendarClock}>
          <p>{d.when}</p>
          {d.span && <p className="text-violet-700">{d.span}</p>}
          {d.costCentre && <p className="font-medium text-cyan-700">{d.costCentre}</p>}
          {actualText && <p data-hover-actual className="font-semibold text-emerald-700">⏱ {actualText}</p>}
        </Row>
        {d.note && (
          <Row icon={StickyNote}>
            <p className="whitespace-pre-line text-amber-800">{d.note}</p>
          </Row>
        )}
        {d.crew.length > 0 && (
          <Row icon={Users}>
            <p className="text-slate-500">Also on the job that day</p>
            {d.crew.map((c, i) => (
              <p key={`${c.name}-${c.time}-${i}`}>
                <span className="font-medium text-slate-900">{c.name}</span> · {c.time}
                {c.costCentre ? <span className="text-cyan-700"> · {c.costCentre}</span> : null}
              </p>
            ))}
          </Row>
        )}
        {d.description && <p className="border-t border-slate-100 pt-2 whitespace-pre-line text-slate-600">{d.description}</p>}
      </div>

      <div className="mt-2 border-t border-slate-100 pt-2 text-right">
        <Link prefetch={false} href={href} className="text-sm font-semibold text-blue-600 hover:underline">
          Open job →
        </Link>
      </div>
    </div>,
    document.body,
  );
}

/** A stable id for the card, for the booking's aria-describedby. */
export function useHoverCardId() {
  return `booking-hover-${useId().replace(/:/g, "")}`;
}
