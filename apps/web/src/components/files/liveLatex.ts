import {
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { observeResize } from "~/lib/observeResize";
import { scanPaper, type FigureImages, type Paper, type Token } from "./latexDocument";
import {
  drawGlyph,
  formula,
  layoutEquation,
  macrosIn,
  renderInline,
  renderTabular,
  type Macros,
} from "./latexTypeset";
import type { Labels } from "./latexSyntax";

export type PaperContext = {
  preamble: string;
  labels: Labels;
  figures?: FigureImages | undefined;
};

const noContext: PaperContext = { preamble: "", labels: {} };
const paperContext = Facet.define<PaperContext, PaperContext>({
  combine: (values) => values[0] ?? noContext,
});
const setFocused = StateEffect.define<boolean>();
const equationObservers = new WeakMap<HTMLElement, () => void>();

class Typeset extends WidgetType {
  constructor(
    readonly token: Token,
    readonly paper: Paper,
    readonly macros: Macros,
    readonly raw: string,
    readonly editing: boolean,
  ) {
    super();
  }
  override eq(other: Typeset) {
    const t = this.token,
      u = other.token;
    return (
      this.raw === other.raw &&
      t.kind === u.kind &&
      t.value === u.value &&
      t.prefix === u.prefix &&
      t.image === u.image &&
      this.macros === other.macros &&
      this.editing === other.editing &&
      (t.kind !== "title" || this.paper.titles === other.paper.titles) &&
      this.paper.figures === other.paper.figures &&
      this.paper.labels === other.paper.labels
    );
  }
  override destroy(dom: HTMLElement) {
    equationObservers.get(dom)?.();
    equationObservers.delete(dom);
  }
  toDOM(view: EditorView) {
    const t = this.token;
    const node = document.createElement("span");
    node.className = "t3-tex-" + t.kind;
    if (this.editing) node.classList.add("t3-tex-edit-preview");
    const inline = (parent: HTMLElement, value = t.value, offset = t.offset ?? 0) =>
      renderInline(parent, value, offset, this.macros, this.paper.labels, this.paper.figures);
    if (t.kind === "math" || t.kind === "display") {
      if (!formula(node, t.value, t.kind === "display", this.macros))
        node.textContent = this.editing ? "" : this.raw;
      const body = t.kind === "display" && node.querySelector(".t3-tex-equation-body");
      if (body) {
        // Font loading can resize the formula without resizing the editor column.
        equationObservers.set(
          node,
          observeResize([node, body], () => layoutEquation(node)),
        );
      }
    } else if (t.kind === "glyph") drawGlyph(node, t.value, this.paper.figures?.get(t.value));
    else if (t.kind === "figure" && t.image) {
      const img = document.createElement("img");
      img.alt = "TikZ figure";
      img.src = t.image.url;
      img.width = Math.ceil(t.image.width);
      img.height = Math.ceil(t.image.height);
      const size = /\\documentclass\s*\[[^\]]*?\b(10|11|12)pt\b/.exec(this.paper.preamble)?.[1];
      const fontSize = size === "11" ? 10.95 : size === "12" ? 12 : 10;
      img.style.width = `${(t.image.width * 72.27) / 72 / fontSize}em`;
      node.append(img);
    } else if (t.kind === "table")
      renderTabular(
        node,
        t.value,
        t.spec!,
        t.offset!,
        this.macros,
        this.paper.labels,
        this.paper.figures,
      );
    else if (t.kind === "title") {
      this.paper.titles.forEach((entry, i) => {
        const line = document.createElement("span");
        line.className = i === 0 ? "t3-tex-title-main" : "t3-tex-byline";
        inline(line, entry.value, 0);
        if (this.paper.localTitle) line.dataset.texTarget = String(entry.start);
        node.append(line);
      });
    } else if (t.kind === "theorem") {
      const strong = document.createElement("strong");
      strong.textContent = t.prefix!;
      node.append(strong);
      if (t.value) {
        node.append(" (");
        inline(node);
        node.append(")");
      }
      node.append(". ");
    } else if (t.kind === "section" || t.kind === "subsection" || t.kind === "caption") {
      const text = t.kind === "caption" ? document.createElement("span") : node;
      if (text !== node) {
        text.className = "t3-tex-caption-inner";
        node.append(text);
      }
      if (t.prefix) {
        const num = document.createElement("span");
        num.className = "t3-tex-number";
        num.textContent = t.kind === "caption" ? t.prefix : t.prefix + " ";
        text.append(num);
      }
      inline(text);
    } else if (["bold", "italic", "plain", "marker"].includes(t.kind)) inline(node);
    else if (t.kind === "break") node.append(document.createElement("br"));
    else node.textContent = t.value;
    node.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || view.state.readOnly || !(event.target instanceof Element)) return;
      event.preventDefault();
      const replacement = view.posAtDOM(node);
      const mapped = event.target.closest<HTMLElement>("[data-tex-offset]");
      const title = event.target.closest<HTMLElement>("[data-tex-target]");
      let offset = mapped ? Number(mapped.dataset.texOffset) : (t.offset ?? 1);
      if (mapped?.hasAttribute("data-tex-literal")) {
        const range = view.dom.ownerDocument.caretRangeFromPoint(event.clientX, event.clientY);
        if (range && mapped.contains(range.startContainer)) offset += range.startOffset;
      }
      const head = title
        ? Number(title.dataset.texTarget) + offset
        : this.editing
          ? replacement
          : replacement + Math.min(Math.max(0, offset), this.raw.length - 1);
      view.dispatch({
        selection: { anchor: event.shiftKey ? view.state.selection.main.anchor : head, head },
      });
      view.focus();
    });
    return node;
  }
}

class Space extends WidgetType {
  override eq() {
    return true;
  }
  override ignoreEvent() {
    return false;
  }
  toDOM() {
    const node = document.createElement("span");
    node.textContent = " ";
    return node;
  }
}

const sourceMark = Decoration.mark({ class: "t3-tex-source" });
const sourceLine = Decoration.line({ class: "t3-tex-source-line" });
const lineJoin = Decoration.replace({ widget: new Space() });
const tightJoin = Decoration.replace({});
const multiline = new Set<Token["kind"]>(["preamble", "display", "table", "figure"]);

// A token shows its source while the selection sits inside it, so a caret, a double-click and a
// search match all reveal what they would change. The preamble stays typeset at the opening caret.
function sourceRange(state: EditorState, token: Token) {
  return state.selection.ranges.find(
    (r) =>
      token.from <= r.from &&
      r.to <= token.to &&
      r.from < token.to &&
      (token.kind !== "preamble" || r.from > token.from),
  );
}

function decorate(state: EditorState, paper: Paper, macros: Macros, focused: boolean) {
  const ranges: Range<Decoration>[] = [];
  for (const line of paper.lines) {
    ranges.push(
      Decoration.line({
        attributes: {
          class: [
            line.abstract && "t3-tex-abstract-line",
            line.indent && "t3-tex-list-line",
            line.item && "t3-tex-item-line",
            line.paragraph && "t3-tex-paragraph",
            line.blank && "t3-tex-blank",
            line.italic && "t3-tex-theorem-body",
          ]
            .filter(Boolean)
            .join(" "),
          style: `--tex-indent:${line.indent}em`,
        },
      }).range(line.from),
    );
  }
  const reveal = (from: number, to: number, block: boolean) => {
    if (from < to) ranges.push(sourceMark.range(from, to));
    if (!block) return;
    for (let pos = from; pos < to;) {
      const line = state.doc.lineAt(pos);
      ranges.push(sourceLine.range(line.from));
      pos = line.to + 1;
    }
  };
  for (const token of paper.tokens) {
    const selection = focused && !state.readOnly ? sourceRange(state, token) : undefined;
    if (!selection) {
      const invisible = token.kind === "hidden" || token.kind === "preamble";
      const widget = invisible
        ? undefined
        : new Typeset(token, paper, macros, state.sliceDoc(token.from, token.to), false);
      ranges.push(Decoration.replace(widget ? { widget } : {}).range(token.from, token.to));
      continue;
    }
    // A title click reveals only its declaration; anywhere else shows the whole preamble.
    const title =
      token.kind === "preamble"
        ? paper.titles.find((field) => field.start <= selection.from && selection.to <= field.end)
        : undefined;
    if (title) {
      const start = state.doc.lineAt(title.start).from;
      if (start > token.from) ranges.push(Decoration.replace({}).range(token.from, start));
      if (title.end < token.to) ranges.push(Decoration.replace({}).range(title.end, token.to));
      reveal(start, title.end, false);
      continue;
    }
    reveal(token.from, token.to, multiline.has(token.kind));
    if (token.kind === "math" || token.kind === "display")
      ranges.push(
        Decoration.widget({
          widget: new Typeset(token, paper, macros, state.sliceDoc(token.from, token.to), true),
          side: 1,
        }).range(token.to),
      );
  }
  // A paragraph flows as TeX sets it, except the one being written, which keeps its source lines
  // so Enter and Backspace act on what is shown. Following the anchor keeps a drag from reflowing.
  const anchors =
    focused && !state.readOnly ? state.selection.ranges.map((range) => range.anchor) : [];
  for (const join of paper.joins) {
    if (anchors.some((anchor) => join.first <= anchor && anchor <= join.last)) continue;
    ranges.push((join.tight ? tightJoin : lineJoin).range(join.from, join.to));
  }
  return Decoration.set(ranges, true);
}

type Layout = { paper: Paper; macros: Macros; focused: boolean; decorations: DecorationSet };

function parse(state: EditorState, focused: boolean, prior?: Layout): Layout {
  const context = state.facet(paperContext);
  const paper = scanPaper(state.doc.toString(), context.preamble, context.labels, context.figures);
  const macros =
    prior && prior.paper.preamble === paper.preamble ? prior.macros : macrosIn(paper.preamble);
  if (
    prior &&
    Object.keys(paper.labels).length === Object.keys(prior.paper.labels).length &&
    Object.keys(paper.labels).every((key) => paper.labels[key] === prior.paper.labels[key])
  )
    paper.labels = prior.paper.labels;
  return { paper, macros, focused, decorations: decorate(state, paper, macros, focused) };
}

// One field for every editor, so new build output re-typesets without forgetting focus.
const paperField = StateField.define<Layout>({
  create: (state) => parse(state, false),
  update(old, tr) {
    const focused = tr.effects.find((e) => e.is(setFocused))?.value ?? old.focused;
    if (tr.docChanged || tr.state.facet(paperContext) !== tr.startState.facet(paperContext))
      return parse(tr.state, focused, old);
    if (!tr.selection && focused === old.focused && tr.state.readOnly === tr.startState.readOnly)
      return old;
    return { ...old, focused, decorations: decorate(tr.state, old.paper, old.macros, focused) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (value) => value.decorations),
    EditorView.contentAttributes.from(f, ({ paper }) => ({
      style: `--tex-link-color:${paper.linkColor}`,
    })),
  ],
});

/** Moves the caret past the source it is editing, which typesets it again. */
export function leaveLiveSource(view: EditorView) {
  const layout = view.state.field(paperField, false);
  const token =
    layout?.focused && !view.state.readOnly
      ? layout.paper.tokens.find((t) => sourceRange(view.state, t) === view.state.selection.main)
      : undefined;
  if (!token) return false;
  view.dispatch({ selection: { anchor: token.to }, scrollIntoView: true });
  return true;
}

export function liveLatex(context: PaperContext): Extension {
  return [
    paperContext.of(context),
    paperField,
    EditorView.focusChangeEffect.of((_state, focused) => setFocused.of(focused)),
    EditorView.editorAttributes.of({ class: "t3-latex-paper" }),
  ];
}
