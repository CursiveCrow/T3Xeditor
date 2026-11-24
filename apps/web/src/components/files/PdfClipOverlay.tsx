import { useState, type PointerEvent } from "react";

type Position = { x: number; y: number };
function point(event: PointerEvent<HTMLDivElement>): Position {
  const box = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
    y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
  };
}

// Coordinates are fractions of the visible page, independent of device DPI and zoom.
export function PdfClipOverlay({ onClip }: { onClip: (blob: Blob) => void }) {
  const [drag, setDrag] = useState<{ origin: Position; end: Position } | null>(null);
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none select-none"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const origin = point(event);
        setDrag({ origin, end: origin });
      }}
      onPointerMove={(event) => {
        if (drag && event.currentTarget.hasPointerCapture(event.pointerId))
          setDrag({ origin: drag.origin, end: point(event) });
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerUp={(event) => {
        if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const end = point(event);
        setDrag(null);
        const source = event.currentTarget.parentElement?.querySelector("canvas");
        if (!source) return;
        const x = Math.round(Math.min(drag.origin.x, end.x) * source.width);
        const y = Math.round(Math.min(drag.origin.y, end.y) * source.height);
        const width = Math.round(Math.abs(drag.origin.x - end.x) * source.width);
        const height = Math.round(Math.abs(drag.origin.y - end.y) * source.height);
        if (width < 3 || height < 3) return;
        const crop = document.createElement("canvas");
        crop.width = width;
        crop.height = height;
        const context = crop.getContext("2d");
        if (!context) return;
        context.drawImage(source, x, y, width, height, 0, 0, width, height);
        crop.toBlob((blob) => {
          if (blob) onClip(blob);
        }, "image/png");
      }}
    >
      {drag && (
        <div
          className="pointer-events-none absolute border border-primary bg-primary/20"
          style={{
            left: Math.min(drag.origin.x, drag.end.x) * 100 + "%",
            top: Math.min(drag.origin.y, drag.end.y) * 100 + "%",
            width: Math.abs(drag.origin.x - drag.end.x) * 100 + "%",
            height: Math.abs(drag.origin.y - drag.end.y) * 100 + "%",
          }}
        />
      )}
    </div>
  );
}
