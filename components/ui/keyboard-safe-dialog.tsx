"use client";

import * as React from "react";
import { DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { keyboardSafeDialogStyle, useVisualViewport } from "@/lib/use-visual-viewport";

// A dialog for forms with text fields that stays usable with a phone keyboard
// open — the bug where the Schedule dialog's Save button sat behind the iPhone
// keyboard after typing the technician's note:
//   * the dialog is sized to the VISIBLE viewport (lib/use-visual-viewport.ts;
//     90dvh when no keyboard is up), so it never extends under the keyboard;
//   * only the body scrolls; the footer is outside it, always on screen, so
//     the primary button rides just above the keyboard;
//   * a tap outside the field being typed in, or a drag of the form, closes
//     the keyboard (blurs the field);
//   * while a text field has focus a "Done" button shows above the footer on
//     phones — Return in a textarea adds a line, so there is no other obvious
//     way to put the keyboard away;
//   * fields are 16px on small screens, below which iPhone Safari zooms the
//     page on focus and the layout shifts.

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"]);

/** Whether an element brings up the on-screen keyboard. */
export function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (typeof HTMLElement === "undefined" || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el.isContentEditable;
}

function blurActiveField() {
  const active = document.activeElement;
  if (isTextField(active)) active.blur();
}

type Props = Omit<React.ComponentProps<typeof DialogContent>, "children"> & {
  /** Title area (DialogHeader), outside the scrolling body. */
  header?: React.ReactNode;
  /** The action buttons — never scrolled away, never under the keyboard. */
  footer: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
};

export function KeyboardSafeDialogContent({ className, header, footer, children, bodyClassName, style, ...props }: Props) {
  const viewport = useVisualViewport();
  const fit = keyboardSafeDialogStyle(viewport);
  const [typing, setTyping] = React.useState(false);

  return (
    <DialogContent
      {...props}
      className={cn("flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0", className)}
      style={fit ? { ...(typeof style === "object" ? style : {}), ...fit } : style}
      // Blur fires before the next field's focus, so moving between fields
      // keeps `typing` true and closing the keyboard sets it false.
      onFocusCapture={(e) => setTyping(isTextField(e.target))}
      onBlurCapture={() => setTyping(false)}
    >
      {header && <div className="shrink-0 px-4 pt-4 pb-3 pr-10">{header}</div>}
      <div
        data-slot="keyboard-safe-body"
        className={cn(
          "min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-4",
          "max-md:[&_input]:text-base max-md:[&_textarea]:text-base",
          !header && "pt-4",
          bodyClassName,
        )}
        // A tap anywhere that is not itself a text field puts the keyboard away.
        onPointerDown={(e) => {
          const active = document.activeElement;
          if (isTextField(active) && !active.contains(e.target as Node) && !isTextField(e.target)) active.blur();
        }}
        // A drag of the form (not of the field's own text) does too. Touch
        // only — iOS scrolls the focused field into view by itself, and a
        // `scroll` listener would take that for the user and close the keyboard
        // the moment it opened.
        onTouchMove={(e) => {
          const active = document.activeElement;
          if (isTextField(active) && !active.contains(e.target as Node)) active.blur();
        }}
      >
        {children}
      </div>
      <div data-slot="keyboard-safe-footer" className="shrink-0 rounded-b-xl border-t bg-muted/50 px-4 py-3">
        {typing && (
          <div className="flex justify-end pb-2 md:hidden">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              // Keep focus where it is until the click lands, then blur it.
              onPointerDown={(e) => e.preventDefault()}
              onClick={blurActiveField}
            >
              Done
            </Button>
          </div>
        )}
        {footer}
      </div>
    </DialogContent>
  );
}
