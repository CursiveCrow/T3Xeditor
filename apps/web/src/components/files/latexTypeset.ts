import type { FigureImage, FigureImages } from "./latexDocument";
import { alignmentParts, argument, inlineAt, inlinePattern, type Labels } from "./latexSyntax";
import katex from "katex";
import "katex/dist/katex.min.css";
export type Macros = Record<string, string>;

const textBrackets: Record<string, string> = { FEFF27E6: "\\llbracket", FEFF27E7: "\\rrbracket" };

const doubleStruck = "t3-double-struck";
const boldDoubleStruck = "t3-double-struck-bold";

function doubleStruckMacros(preamble: string): Macros {
  const packages = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\]\s*)?\{([^{}]+)\}/g;
  let selected = false;
  let bold = false;
  for (const match of preamble.matchAll(packages)) {
    const options = (match[1] ?? "").replace(/\s/g, "").split(",");
    for (const name of match[2]!.split(",").map((part) => part.trim())) {
      if (name === "dsserif") {
        selected = true;
      } else if (name === "mathalpha" || name === "mathalfa") {
        const bb = options.findLast((option) => option.startsWith("bb="));
        if (!bb) continue;
        selected = bb === "bb=dsserif";
      } else {
        continue;
      }
      bold = options.includes("bfbb");
    }
  }
  if (!selected) return {};
  // KaTeX's AMS alphabet drops most lowercase glyphs. Use a complete upright
  // alphabet for HTML layout and retain KaTeX's double-struck MathML semantics.
  const alphabet = (css: string) => `\\html@mathml{\\htmlClass{${css}}{\\mathsf{#1}}}{\\Bbb{#1}}`;
  return {
    "\\mathbb": alphabet(bold ? boldDoubleStruck : doubleStruck),
    "\\mathbfbb": alphabet(boldDoubleStruck),
    "\\mathbbb": "\\mathbfbb",
  };
}

export function macrosIn(source: string): Macros {
  const clean = source.replace(/(?<!\\)%[^\n]*/g, "");
  const macros: Macros = Object.assign(Object.create(null), doubleStruckMacros(clean));
  const copies = new Map(
    [...clean.matchAll(/\\(?:NewCommandCopy|LetLtxMacro)\s*\{(\\[\w@]+)\}\s*\{(\\[\w@]+)\}/g)].map(
      (m) => [m[1]!, m[2]!],
    ),
  );
  const wrappers = new Set<string>();
  const accessible = new Map<string, string>();
  const declarations =
    /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator)\*?\s*\{(\\[A-Za-z@]+)\}\s*(?:\[\d\]\s*)?\{/g;
  for (const match of clean.matchAll(declarations)) {
    const name = match[2]!;
    const body = argument(clean, match.index + match[0].length - 1);
    if (!body) continue;
    if (
      body.value.includes("\\pdfliteral") &&
      body.value.includes("/ActualText") &&
      body.value.includes("#2")
    ) {
      wrappers.add(name);
      continue;
    }
    let value = body.value;
    // Marked PDF content wraps its painted argument in accessibility metadata.
    for (const wrapper of wrappers) {
      let at = value.indexOf(wrapper + "{");
      while (at >= 0) {
        const metadata = argument(value, at + wrapper.length);
        const painted = metadata && argument(value, metadata.end);
        if (!metadata || !painted) break;
        if (/^FEFF(?:[\dA-F]{4})+$/i.test(metadata.value)) {
          const text = String.fromCharCode(
            ...metadata.value
              .slice(4)
              .match(/.{4}/g)!
              .map((hex) => Number.parseInt(hex, 16)),
          );
          accessible.set(name, text);
        }
        value =
          value.slice(0, at) +
          (textBrackets[metadata.value.toUpperCase()] ?? painted.value) +
          value.slice(painted.end);
        at = value.indexOf(wrapper + "{", at + painted.value.length);
      }
    }
    // A decorated copy of an existing symbol keeps KaTeX's native definition.
    if ([...copies].some(([copy, original]) => original === name && value.includes(copy))) continue;
    macros[name] =
      match[1] === "DeclareMathOperator"
        ? `\\operatorname${match[0].startsWith("\\DeclareMathOperator*") ? "*" : ""}{${value}}`
        : value;
  }
  for (const [name, text] of accessible) {
    if (!macros[name] || macros[name]!.includes("#")) continue;
    try {
      katex.renderToString(name, {
        output: "mathml",
        macros: { ...macros },
        trust: false,
        maxExpand: 1000,
      });
    } catch {
      // A PDF drawing can still carry a usable Unicode representation.
      if (!/[\\{}%$&#^_]/.test(text)) {
        // Preserve a drawn subscript when ActualText provides its base and glyph separately.
        const glyphs = Array.from(text, (glyph) =>
          glyph === "○" ? '\\html@mathml{\\circ}{\\char"25CB}' : glyph,
        );
        macros[name] =
          glyphs.length === 2 && macros[name]!.includes("_{")
            ? `${glyphs[0]}_{${glyphs[1]}}`
            : glyphs.join("");
      }
    }
  }
  return macros;
}

// KaTeX adds an ordinary math atom around untagged arrays. Restrict measurement
// to the outer table in either shape so nested matrices keep their own spacing.
const outerTable = ":scope > .katex-base > .mtable, :scope > .katex-base > .mord > .mtable";

export function formula(node: HTMLElement, value: string, display: boolean, macros: Macros) {
  try {
    katex.render(value, node, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: (ctx) =>
        ctx.command === "\\htmlClass" &&
        (ctx.class === doubleStruck || ctx.class === boldDoubleStruck),
      strict: (code) => (code === "htmlExtension" ? "ignore" : "warn"),
      maxExpand: 1000,
      maxSize: 12,
      macros: { ...macros },
    });
    if (!display) {
      // Each end of the formula gets a parent the stylesheet keeps from wrapping, which holds it
      // to the adjoining text. The boxes between keep KaTeX's own line breaks.
      const html = node.querySelector(".katex-html");
      for (const edge of new Set([html?.firstElementChild, html?.lastElementChild])) {
        if (!edge) continue;
        const hold = document.createElement("span");
        hold.className = "t3-tex-hold";
        edge.replaceWith(hold);
        hold.append(edge);
      }
      return true;
    }
    const html = node.querySelector<HTMLElement>(".katex-html")!;
    const tag = html.querySelector(":scope > .katex-tag");
    // Only a top-level AMS align stretches the space between alignment pairs.
    // Embedded aligned groups and arrays keep their natural column spacing.
    const spacedAlign =
      /^\\begin\{align\*?\}/.test(value) &&
      !!html.querySelector(outerTable)?.querySelector(":scope > .arraycolsep");
    if (tag || spacedAlign) {
      node.toggleAttribute("data-tex-align-pairs", spacedAlign);
      const body = document.createElement("span");
      body.className = "t3-tex-equation-body";
      for (const child of Array.from(html.children)) if (child !== tag) body.append(child);
      html.prepend(body);
    }
    return true;
  } catch {
    return false;
  }
}

// amsmath places a tag below its own row when the formula fits the measure but its tag does not.
// Keep KaTeX's math boxes and MathML intact, including their baseline and optional row spacing.
export function layoutEquation(display: HTMLElement) {
  const body = display.querySelector<HTMLElement>(".t3-tex-equation-body");
  const tag = body?.nextElementSibling;
  if (!body) return;
  const rowPath = ":scope > .vlist-t > .vlist-r:first-child > .vlist > span";
  const table = body.querySelector(outerTable);
  const fields = Array.from(table?.children ?? []).filter(
    (col) => !col.classList.contains("arraycolsep"),
  );
  const width = display.getBoundingClientRect().width;
  const em = parseFloat(getComputedStyle(body).fontSize);
  if (width && display.hasAttribute("data-tex-align-pairs") && table) {
    const separators = table.querySelectorAll<HTMLElement>(":scope > .arraycolsep");
    const natural = fields.reduce((total, col) => total + col.getBoundingClientRect().width, 0);
    // amsmath shares the spare measure between both margins and all inter-pair gaps.
    // Convert viewport lengths back to CSS pixels for editors with a scaled ancestor.
    const scale = width / parseFloat(getComputedStyle(display).width);
    const gap = Math.max(em, (width - natural) / (separators.length + 2) / scale);
    for (const separator of separators) separator.style.width = `${gap}px`;
  }
  if (!(tag instanceof HTMLElement)) return;
  const columns = fields.map((col) => Array.from(col.querySelectorAll<HTMLElement>(rowPath)));
  const numbers = Array.from(tag.querySelectorAll<HTMLElement>(rowPath));
  if (!numbers.length || !columns.length || columns.some((col) => col.length !== numbers.length))
    return;
  const box = body.getBoundingClientRect();
  const tagWidth = tag.getBoundingClientRect().width;
  const compact = box.width <= width && box.width + tagWidth + 1.55 * em > width;
  const right = box.left + (width + box.width) / 2;
  let shift = 0;
  numbers.forEach((number, i) => {
    const cells = columns.map((col) => col[i]!);
    for (const cell of cells) cell.style.transform = shift ? `translateY(${shift}em)` : "";
    if (
      compact &&
      number.textContent &&
      cells.some((cell) => {
        const end = cell.lastElementChild?.getBoundingClientRect().right;
        return end !== undefined && end + em * 0.65 > right - tagWidth;
      })
    )
      shift += 1.2;
    number.style.transform = shift ? `translateY(${shift}em)` : "";
  });
  display.toggleAttribute("data-tex-stacked-tags", compact);
  const html = body.parentElement!;
  html.style.paddingBottom = shift ? `${shift}em` : "";
}

export function drawGlyph(parent: HTMLElement, command: string, image?: FigureImage) {
  if (!image?.baseline) {
    parent.textContent = command;
    return;
  }
  const { em, depth } = image.baseline;
  const glyph = document.createElement("img");
  glyph.alt = command;
  glyph.src = image.url;
  glyph.style.width = `${image.width / em}em`;
  glyph.style.height = `${image.height / em}em`;
  glyph.style.verticalAlign = `${-depth / em}em`;
  parent.append(glyph);
}

function mappedText(parent: HTMLElement, value: string, offset: number) {
  if (!value) return;
  const span = document.createElement("span");
  span.dataset.texOffset = String(offset);
  span.dataset.texLiteral = "";
  span.textContent = value;
  parent.append(span);
}

// Offsets are relative to the replacement, so an unchanged widget can move after an edit above it.
export function renderInline(
  parent: HTMLElement,
  source: string,
  offset: number,
  macros: Macros,
  labels: Labels,
  figures?: FigureImages,
  depth = 0,
) {
  if (depth > 32) {
    mappedText(parent, source, offset);
    return;
  }
  const pattern = inlinePattern();
  let previous = 0;
  for (let m; (m = pattern.exec(source));) {
    const t = inlineAt(source, m[0], pattern.lastIndex, labels, figures);
    if (!t) continue;
    mappedText(parent, source.slice(previous, m.index), offset + previous);
    if (t.kind !== "hidden") {
      const child = document.createElement(t.kind === "break" ? "br" : "span");
      child.className = "t3-tex-" + t.kind;
      child.dataset.texOffset = String(offset + t.start);
      if (t.kind === "math") {
        if (!formula(child, t.value, false, macros))
          child.textContent = source.slice(m.index, t.end);
      } else if (t.kind === "glyph") drawGlyph(child, t.value, figures?.get(t.value));
      else if (["bold", "italic", "plain"].includes(t.kind))
        renderInline(child, t.value, offset + t.start, macros, labels, figures, depth + 1);
      else child.textContent = t.value;
      parent.append(child);
    }
    previous = pattern.lastIndex = t.end;
  }
  mappedText(parent, source.slice(previous), offset + previous);
}

function tableColumns(spec: string) {
  const columns: { align: string; natural?: boolean; width?: number | undefined }[] = [];
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i]!;
    const group = argument(spec, i + 1);
    if (/[pmb]/.test(ch) && group) {
      const fraction = /^(\d*\.?\d+)\\(?:textwidth|linewidth|columnwidth)$/.exec(
        group.value.trim(),
      );
      columns.push({
        align: "left",
        width: fraction ? Math.min(100, Number(fraction[1]) * 100) : undefined,
      });
    } else if (/[lcr]/.test(ch))
      columns.push({ natural: true, align: ch === "r" ? "right" : ch === "c" ? "center" : "left" });
    if (group) i = group.end - 1;
  }
  return columns;
}

export function renderTabular(
  parent: HTMLElement,
  body: string,
  spec: string,
  offset: number,
  macros: Macros,
  labels: Labels,
  figures?: FigureImages,
) {
  const table = document.createElement("table");
  const columns = tableColumns(spec);
  const tbody = table.createTBody();
  let row: HTMLTableRowElement | undefined;
  let rule = "";
  for (const part of alignmentParts(body, true)) {
    let from = part.from;
    while (from < part.to) {
      const lead = /\s+|%[^\n]*|\\(toprule|midrule|bottomrule|hline)\b/y;
      lead.lastIndex = from;
      const prefix = lead.exec(body);
      if (!prefix) break;
      if (prefix[1]) rule = prefix[1];
      from = lead.lastIndex;
    }
    if (from >= part.to && !row && part.from === part.to && part.to === body.length) break;
    if (from >= part.to && !row && part.rowEnd && part.to === body.length) break;
    if (!row) {
      row = tbody.insertRow();
      if (rule) row.dataset.rule = rule;
      rule = "";
    }
    const column = columns[row.cells.length];
    const cell = row.insertCell();
    if (column?.natural) cell.dataset.naturalWidth = "";
    // TeX paragraph column widths use the enclosing text measure, excluding tabcolsep.
    if (column?.width !== undefined) cell.style.width = column.width + "cqw";
    cell.style.textAlign = column?.align ?? "left";
    cell.dataset.texOffset = String(offset + from);
    renderInline(cell, body.slice(from, part.to).trimEnd(), offset + from, macros, labels, figures);
    if (part.rowEnd) row = undefined;
  }
  if (rule && tbody.lastElementChild)
    (tbody.lastElementChild as HTMLElement).dataset.bottomRule = rule;
  parent.append(table);
}
