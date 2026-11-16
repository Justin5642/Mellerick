"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { PenLine } from "lucide-react";

// The on-screen signature box (mouse or finger), shared by the customer
// sign-off (job-signature.tsx) and the builder's Day Works sign-off
// (job-day-works.tsx). Draws on a 600×200 canvas scaled to its width.

export interface SignaturePadHandle {
  clear(): void;
  /** The drawing as a PNG, or null if the browser couldn't produce one. */
  toBlob(): Promise<Blob | null>;
}

interface Props {
  onChange?: (hasSignature: boolean) => void;
  placeholder?: string;
}

const BACKGROUND = "#f8fafc";

export const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad({ onChange, placeholder = "Sign here" }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [lastPos, setLastPos] = useState({ x: 0, y: 0 });
  const [hasSignature, setHasSignature] = useState(false);

  function paintBackground() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  useEffect(paintBackground, []);

  function mark(has: boolean) {
    setHasSignature(has);
    onChange?.(has);
  }

  useImperativeHandle(ref, () => ({
    clear() {
      paintBackground();
      mark(false);
    },
    toBlob() {
      const canvas = canvasRef.current;
      if (!canvas) return Promise.resolve(null);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    },
  }));

  function getPos(e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    setDrawing(true);
    if (!hasSignature) mark(true);
    setLastPos(getPos(e, canvas));
  }

  function draw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    if (!drawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const pos = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(lastPos.x, lastPos.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    setLastPos(pos);
  }

  function stopDraw() {
    setDrawing(false);
  }

  return (
    <div className="border-2 border-slate-200 rounded-xl overflow-hidden bg-slate-50 relative">
      <canvas
        ref={canvasRef}
        width={600}
        height={200}
        className="w-full touch-none cursor-crosshair"
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={stopDraw}
        onMouseLeave={stopDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={stopDraw}
      />
      {!hasSignature && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 text-slate-300">
            <PenLine className="w-5 h-5" />
            <span className="text-sm">{placeholder}</span>
          </div>
        </div>
      )}
    </div>
  );
});
