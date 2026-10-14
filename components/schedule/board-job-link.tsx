"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// Long enough to tell a double-click from a click on every OS default (Windows
// 500 ms max, but real double-clicks land well under 300), short enough that a
// single click still feels like it opens the job straight away.
const DOUBLE_CLICK_WINDOW_MS = 250;

/**
 * A job card's link on the schedule board, where double-click means "cut".
 *
 * A plain <Link> navigates on the FIRST click of a double-click, before the
 * dblclick event ever fires — so the page would be gone before the job could
 * be cut. Here a plain left click waits DOUBLE_CLICK_WINDOW_MS and then opens
 * the job; a second click inside that window cancels the navigation and
 * `onCut` runs instead.
 *
 * Left alone, so the browser keeps its usual meaning: modifier and middle
 * clicks (open in a new tab), and keyboard activation (Enter, detail 0 —
 * navigates at once).
 *
 * While a job is cut (`cutActive`) a click never navigates: it bubbles to the
 * board cell underneath, which is where the cut job gets pasted.
 *
 * Unaffected by the dnd-kit PointerSensor: its 200 ms hold delay is never
 * reached by the two quick presses of a double-click.
 */
export function BoardJobLink({
  href,
  className,
  cutActive,
  onCut,
  children,
}: {
  href: string;
  className?: string;
  cutActive: boolean;
  onCut: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const timer = useRef<number | null>(null);

  function cancelPending() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  useEffect(() => cancelPending, []);

  return (
    <Link
      prefetch={false}
      href={href}
      className={className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (cutActive) return;
        if (e.detail === 0) {
          router.push(href);
          return;
        }
        cancelPending();
        if (e.detail > 1) return; // second click of a double-click — onDoubleClick cuts
        timer.current = window.setTimeout(() => {
          timer.current = null;
          router.push(href);
        }, DOUBLE_CLICK_WINDOW_MS);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        cancelPending();
        onCut();
      }}
    >
      {children}
    </Link>
  );
}
