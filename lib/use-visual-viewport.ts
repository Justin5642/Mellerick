"use client";

import { useEffect, useState } from "react";

// The part of the page the user can actually see — what is left above the
// on-screen keyboard on a phone.
//
// iPhone Safari does not shrink the layout viewport when the keyboard opens
// (and ignores `interactive-widget`), so `vh`, `dvh` and `position: fixed`
// all still measure the full screen: a dialog centred on it, or a footer
// pinned to its bottom, ends up under the keyboard. Only window.visualViewport
// knows the visible rectangle. The Schedule dialog's Next/Save button sat
// behind the keyboard after typing the technician's note because of this.

export interface VisibleViewport {
  /** Height of the visible area, px. */
  height: number;
  /** How far the visible area is scrolled down the layout viewport, px. */
  offsetTop: number;
  /** The layout viewport's height (window.innerHeight), px. */
  layoutHeight: number;
}

/** The visible viewport, kept current while the keyboard opens, closes and the page pans. Null where unsupported or before mount. */
export function useVisualViewport(enabled = true): VisibleViewport | null {
  const [vv, setVv] = useState<VisibleViewport | null>(null);
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !window.visualViewport) return;
    const v = window.visualViewport;
    const update = () => setVv({ height: v.height, offsetTop: v.offsetTop, layoutHeight: window.innerHeight });
    update();
    v.addEventListener("resize", update);
    v.addEventListener("scroll", update);
    return () => {
      v.removeEventListener("resize", update);
      v.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return vv;
}

/** Space kept between the dialog and the keyboard / top of the screen, px. */
export const KEYBOARD_DIALOG_MARGIN = 8;

/**
 * Where a centred dialog goes so all of it — its footer included — is inside
 * the visible area. Undefined when nothing covers the page (no keyboard, or a
 * desktop browser), so the dialog keeps its ordinary CSS centring.
 */
export function keyboardSafeDialogStyle(vv: VisibleViewport | null): { top: string; maxHeight: string } | undefined {
  if (!vv) return undefined;
  // A sliver of difference is browser chrome settling, not a keyboard.
  if (vv.layoutHeight - vv.height < 80 && vv.offsetTop < 1) return undefined;
  const maxHeight = Math.max(160, vv.height - 2 * KEYBOARD_DIALOG_MARGIN);
  return { top: `${Math.round(vv.offsetTop + vv.height / 2)}px`, maxHeight: `${Math.round(maxHeight)}px` };
}
