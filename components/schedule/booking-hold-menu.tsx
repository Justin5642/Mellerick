"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PointerSensor, type PointerSensorProps } from "@dnd-kit/core";
import { boardDragConstraint, HOLD_MS, holdTolerance, menuPlacement, movedBeyond, type BookingMenuAction, type BookingMenuItem, type Point } from "./board-actions";
import { cn } from "@/lib/utils";

/**
 * The board's drag sensor: a mouse or pen drag starts as soon as the pointer
 * moves DRAG_DISTANCE_PX (so a still, held button is free to mean "menu");
 * touch keeps the old 200 ms press-and-hold, so a swipe across a card never
 * moves a booking by accident. Rules in board-actions.ts.
 */
export class BoardPointerSensor extends PointerSensor {
  constructor(props: PointerSensorProps) {
    const pointerType = (props.event as PointerEvent | undefined)?.pointerType;
    super({ ...props, options: { ...props.options, activationConstraint: boardDragConstraint(pointerType) } });
  }
}

/** Eat the one click a press-and-hold's release produces, so it doesn't open the job underneath. */
function swallowNextClick() {
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const timer = window.setTimeout(() => done(), 400);
  function done() {
    window.clearTimeout(timer);
    window.removeEventListener("click", onClick, true);
  }
  window.addEventListener("click", onClick, true);
}

/**
 * Press and hold: `onHold` runs once the pointer has stayed within the hold
 * tolerance for HOLD_MS. Moving further first cancels it (that is a drag, which
 * dnd-kit takes); letting go first cancels it (a click). The returned handler
 * goes on the card's onPointerDown, beside dnd-kit's own.
 */
export function useHoldGesture(onHold: ((at: Point) => void) | undefined) {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  return useCallback(
    (e: React.PointerEvent) => {
      if (!onHold || !e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      stopRef.current?.();
      const start = { x: e.clientX, y: e.clientY };
      const id = e.pointerId;
      const tolerance = holdTolerance(e.pointerType);
      let fired = false;
      const timer = window.setTimeout(() => {
        fired = true;
        onHold(start);
      }, HOLD_MS);
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId === id && !fired && movedBeyond(start, { x: ev.clientX, y: ev.clientY }, tolerance)) stop();
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        const wasHold = fired;
        stop();
        if (wasHold) swallowNextClick();
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === id) stop();
      };
      function stop() {
        window.clearTimeout(timer);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        stopRef.current = null;
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      stopRef.current = stop;
    },
    [onHold],
  );
}

/**
 * The booking's menu (press and hold, or right-click): a small list at the
 * press, inside the viewport. Closes on Esc, a press outside it, a scroll or a
 * resize — and after an item is chosen.
 */
export function BookingMenu({
  at,
  title,
  items,
  onAction,
  onClose,
}: {
  at: Point;
  title: string;
  items: BookingMenuItem[];
  onAction: (action: BookingMenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(menuPlacement(at, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
    el.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={title}
      data-booking-menu
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-64 rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
      style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y, visibility: pos ? "visible" : "hidden" }}
    >
      <p className="truncate px-3 py-1.5 text-xs font-semibold text-slate-500">{title}</p>
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          disabled={!!item.disabled}
          title={item.disabled}
          onClick={() => {
            onClose();
            onAction(item.action);
          }}
          className={cn(
            "block w-full px-3 py-2 text-left text-sm",
            item.disabled ? "cursor-not-allowed text-slate-300" : "text-slate-800 hover:bg-blue-50 focus:bg-blue-50 focus:outline-none",
          )}
        >
          {item.label}
          {item.disabled && <span className="block text-[11px] text-slate-400">{item.disabled}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
