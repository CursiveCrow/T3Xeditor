import { openPdf } from "./pdfDocument";
import { mathEnd } from "./latexSyntax";
import type { FigureImage } from "./latexDocument";

type Box = { line: number; page: number; x: number; y: number; width: number; height: number };

type SymbolSheet = {
  pdf: string;
  glyphs: readonly { command: string; depth: number; em: number }[];
};

async function readGlyphs(
  sheet: SymbolSheet,
  images: Map<string, FigureImage>,
  signal: AbortSignal,
) {
  if (signal.aborted || sheet.glyphs.length > 64) return;
  const doc = openPdf(Uint8Array.from(atob(sheet.pdf), (ch) => ch.charCodeAt(0)).buffer);
  const cancel = () => {
    void doc.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const pdf = await doc.promise;
    if (pdf.numPages !== sheet.glyphs.length) return;
    for (const [i, glyph] of sheet.glyphs.entries()) {
      if (signal.aborted) break;
      const page = await pdf.getPage(i + 1);
      const { width, height } = page.getViewport({ scale: 1 });
      if (!(glyph.em > 0 && width > 0 && height > 0 && width <= 128 && height <= 128)) continue;
      const canvas = document.createElement("canvas");
      try {
        const viewport = page.getViewport({ scale: 6 });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport, background: "white" }).promise;
        images.set(glyph.command, {
          url: canvas.toDataURL(),
          width,
          height,
          baseline: { em: glyph.em, depth: glyph.depth },
        });
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await doc.destroy();
  }
}

// The hash ties SyncTeX line numbers to the saved source. The complete picture then
// keys the decoration, so editing another paragraph can move it without breaking it.
export async function cropFigures(
  bytes: ArrayBuffer,
  contents: string,
  hash: string,
  boxes: readonly Box[],
  signal: AbortSignal,
  sheet?: SymbolSheet,
) {
  const source = contents.replace(/\r\n?/g, "\n");
  const images = new Map<string, FigureImage>();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  if (Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("") !== hash)
    return images;
  if (sheet) await readGlyphs(sheet, images, signal).catch(() => undefined);
  if (!boxes.length || signal.aborted) return images;
  const sources = new Map<number, string>();
  const unique = new Set<string>();
  const ambiguous = new Set<string>();
  const syntax = /\\begin\{tikzpicture\}|\\[^\n]|%[^\n]*/g;
  const close = "\\end{tikzpicture}";
  let prior = 0,
    line = 1;
  for (let m; (m = syntax.exec(source));) {
    if (m[0] !== "\\begin{tikzpicture}") continue;
    const end = mathEnd(source, syntax.lastIndex, close);
    if (end < 0) break;
    syntax.lastIndex = end + close.length;
    const raw = source.slice(m.index, syntax.lastIndex);
    for (; prior < end; prior++) if (source[prior] === "\n") line++;
    if (unique.has(raw)) ambiguous.add(raw);
    unique.add(raw);
    sources.set(line, raw);
  }
  // Multiple page placements of the same input can expand with different parameters.
  const usedLines = new Set<number>();
  for (const box of boxes) {
    if (usedLines.has(box.line)) ambiguous.add(sources.get(box.line) ?? "");
    usedLines.add(box.line);
  }
  if (signal.aborted || !sources.size) return images;
  const doc = openPdf(bytes);
  const cancel = () => {
    void doc.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  let budget = 24_000_000;
  try {
    const pdf = await doc.promise;
    for (const box of boxes) {
      const raw = sources.get(box.line);
      if (signal.aborted || budget < 1 || images.size >= 128) break;
      if (!raw || ambiguous.has(raw) || box.page < 1 || box.page > pdf.numPages) continue;
      const page = await pdf.getPage(box.page);
      const view = page.getViewport({ scale: 1 });
      if (view.rotation || view.viewBox[0] !== 0 || view.viewBox[1] !== 0 || page.userUnit !== 1)
        continue;
      const x = Math.max(0, box.x - 0.6),
        y = Math.max(0, box.y - 0.6);
      const width = Math.min(view.width, box.x + box.width + 0.6) - x;
      const height = Math.min(view.height, box.y + box.height + 0.6) - y;
      if (!(width > 0 && height > 0)) continue;
      const scale = Math.min(
        3,
        4096 / width,
        4096 / height,
        Math.sqrt(Math.min(budget, 4_000_000) / (width * height)),
      );
      if (scale < 1) continue;
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      try {
        await page.render({
          canvas,
          viewport: page.getViewport({ scale }),
          transform: [1, 0, 0, 1, -x * scale, -y * scale],
          background: "white",
        }).promise;
        images.set(raw, { url: canvas.toDataURL("image/png"), width, height });
        budget -= canvas.width * canvas.height;
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await doc.destroy();
  }
  return images;
}
