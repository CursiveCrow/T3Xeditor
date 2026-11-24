import katex from "katex";
import { EditorState, StateField, StateEffect, Facet, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

type Token = {
  from: number;
  to: number;
  kind:
    | "math"
    | "display"
    | "section"
    | "subsection"
    | "bold"
    | "italic"
    | "marker"
    | "label"
    | "reference";
  value: string;
};
type Macros = Record<string, string>;

function argument(source: string, open: number) {
  if (source[open] !== "{") return null;
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return { value: source.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

function macrosIn(source: string): Macros {
  const macros: Macros = Object.create(null);
  const clean = source.replace(/(?<!\\)%[^\n]*/g, "");
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
        value = value.slice(0, at) + painted.value + value.slice(painted.end);
        at = value.indexOf(wrapper + "{", at + painted.value.length);
      }
    }
    // A decorated copy of an existing symbol keeps KaTeX's native definition.
    if ([...copies].some(([copy, original]) => original === name && value.includes(copy))) continue;
    macros[name] = match[1] === "DeclareMathOperator" ? "\\operatorname{" + value + "}" : value;
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
      if (!/[\\{}%$&#^_]/.test(text)) macros[name] = text;
    }
  }
  return macros;
}

// Consume matched spans once. Comments, verbatim text and the document preamble keep their source.
function scan(source: string, labels: Readonly<Record<string, string>>) {
  const tokens: Token[] = [];
  const start = source.search(/^[ \t]*\\begin\{document\}/m);
  if (start > 0) tokens.push({ from: 0, to: start, kind: "marker", value: "Document preamble" });
  const pattern =
    /%|\\verb\*?[^a-zA-Z\s]|\\begin\{(?:verbatim\*?|lstlisting|minted)\}|\\begin\{(?:equation|align|gather|multline)\*?\}|\$\$?|\\\[|\\\(|\\(?:part|chapter|section|subsection|subsubsection|textbf|emph|textit|eqref|pageref|ref|label)\*?\s*\{|\\(?:begin|end)\{(?:enumerate|itemize|document|definition|theorem|lemma|proof|corollary|proposition)\}(?:\[[^\]\n]*\])?|\\item\b(?:\[[^\]\n]*\])?|\\./g;
  pattern.lastIndex = Math.max(0, start);
  const lists: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const command = match[0],
      from = match.index,
      after = pattern.lastIndex;
    let to = after,
      kind: Token["kind"] = "marker",
      value = "";
    if (command === "%") {
      const next = source.indexOf("\n", after);
      pattern.lastIndex = next < 0 ? source.length : next;
      continue;
    }
    if (command.startsWith("\\verb") || /^\\begin\{(?:verbatim|lstlisting|minted)/.test(command)) {
      const end = command.startsWith("\\verb")
        ? command.slice(-1)
        : command.replace("begin", "end");
      const at = source.indexOf(end, after);
      pattern.lastIndex = at < 0 ? source.length : at + end.length;
      continue;
    }
    if (
      command[0] === "$" ||
      command === "\\[" ||
      command === "\\(" ||
      /^\\begin\{(?:equation|align|gather|multline)/.test(command)
    ) {
      const close =
        command === "\\["
          ? "\\]"
          : command === "\\("
            ? "\\)"
            : command.startsWith("\\begin")
              ? command.replace("begin", "end")
              : command;
      let at = after;
      while ((at = source.indexOf(close, at)) >= 0 && source[at - 1] === "\\") at += close.length;
      if (at < 0 || (command === "$" && /\n\s*\n/.test(source.slice(after, at)))) continue;
      value = source.slice(after, at);
      kind = command === "$" || command === "\\(" ? "math" : "display";
      if (/^\\begin\{(?:align|gather|multline)/.test(command)) {
        const env = command.includes("align") ? "aligned" : "gathered";
        value = "\\begin{" + env + "}" + value + "\\end{" + env + "}";
      }
      value = value.replace(/\\label\{[^}]*\}/g, "");
      to = at + close.length;
    } else if (command.endsWith("{")) {
      const body = argument(source, after - 1);
      if (!body) continue;
      value = body.value;
      to = body.end;
      if (/^\\(?:eqref|ref|pageref)/.test(command)) {
        const resolved = labels[(command.startsWith("\\pageref") ? "page:" : "") + value] ?? value;
        value = command.startsWith("\\eqref") ? "(" + resolved + ")" : resolved;
        kind = "reference";
      } else
        kind = command.startsWith("\\label")
          ? "label"
          : command.startsWith("\\textbf")
            ? "bold"
            : /^\\(?:emph|textit)/.test(command)
              ? "italic"
              : command.startsWith("\\sub")
                ? "subsection"
                : "section";
    } else if (command.startsWith("\\item")) {
      const n = lists.at(-1);
      value = command.includes("[")
        ? command.slice(command.indexOf("[") + 1, -1)
        : n === undefined || n < 0
          ? "•"
          : String(n + 1) + ".";
      if (n !== undefined && n >= 0) lists[lists.length - 1] = n + 1;
    } else if (command.startsWith("\\begin") || command.startsWith("\\end")) {
      const env = /\{(\w+)\}/.exec(command)?.[1] ?? "";
      if (env === "enumerate" || env === "itemize") {
        if (command.startsWith("\\begin")) lists.push(env === "enumerate" ? 0 : -1);
        else lists.pop();
      } else if (command.startsWith("\\begin") && env !== "document")
        value =
          env.charAt(0).toUpperCase() +
          env.slice(1) +
          (command.includes("[") ? " (" + command.slice(command.indexOf("[") + 1, -1) + ")" : "") +
          ". ";
      kind = value ? "bold" : "label";
    } else continue;
    if (kind === "label" && (from === 0 || source[from - 1] === "\n") && source[to] === "\n") to++;
    tokens.push({ from, to, kind, value });
    pattern.lastIndex = to;
  }
  return tokens;
}

function formula(node: HTMLElement, value: string, display: boolean, macros: Macros) {
  try {
    katex.render(value, node, {
      displayMode: display,
      output: "mathml",
      throwOnError: true,
      trust: false,
      maxExpand: 1000,
      maxSize: 12,
      macros: { ...macros },
    });
    return true;
  } catch {
    return false;
  }
}

class Typeset extends WidgetType {
  constructor(
    readonly token: Token,
    readonly macros: Macros,
    readonly raw: string,
    readonly editing: boolean,
  ) {
    super();
  }
  override eq(other: Typeset) {
    return (
      this.raw === other.raw &&
      this.token.value === other.token.value &&
      this.macros === other.macros &&
      this.editing === other.editing
    );
  }
  toDOM(view: EditorView) {
    const { kind, value } = this.token;
    const node = document.createElement("span");
    node.className = "t3-tex-" + kind;
    if (this.editing) node.classList.add("t3-tex-edit-preview");
    if (kind === "math" || kind === "display") {
      if (!formula(node, value, kind === "display", this.macros))
        node.textContent = this.editing ? "" : this.raw;
    } else if (kind !== "label") {
      for (const part of value.split(/(\$[^$\n]+\$)/g)) {
        const child = document.createElement("span");
        if (!part.startsWith("$") || !formula(child, part.slice(1, -1), false, this.macros))
          child.textContent = part;
        node.appendChild(child);
      }
    }
    node.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const pos = view.posAtDOM(node);
      view.dispatch({
        selection: { anchor: Math.min(view.state.doc.length, pos + (this.editing ? 0 : 1)) },
      });
      view.focus();
    });
    return node;
  }
}

function decorate(state: EditorState, tokens: Token[], macros: Macros, focused: boolean) {
  const ranges = [];
  for (const token of tokens) {
    const editing =
      focused &&
      state.selection.ranges.some((r) => r.empty && token.from <= r.head && r.head < token.to);
    if (editing && token.kind !== "math" && token.kind !== "display") continue;
    const widget = new Typeset(token, macros, state.sliceDoc(token.from, token.to), editing);
    ranges.push(
      editing
        ? Decoration.widget({ widget, side: 1 }).range(token.to)
        : Decoration.replace({ widget }).range(token.from, token.to),
    );
  }
  return Decoration.set(ranges, true);
}

const currentFormulaEnd = Facet.define<number | null, number | null>({
  combine: (values) => values[0] ?? null,
});
export function finishLiveFormula(view: EditorView) {
  const end = view.state.facet(currentFormulaEnd);
  if (end === null) return false;
  view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
  return true;
}

export function liveLatex(
  preamble: string,
  labels: Readonly<Record<string, string>> = {},
): Extension {
  const focus = StateEffect.define<boolean>();
  const inherited = macrosIn(preamble);
  const parse = (state: EditorState, focused = false, prior?: Macros) => {
    const source = state.doc.toString();
    const next = { ...inherited, ...macrosIn(source) };
    const macros =
      prior &&
      Object.keys(next).length === Object.keys(prior).length &&
      Object.keys(next).every((key) => next[key] === prior[key])
        ? prior
        : next;
    const tokens = scan(source, labels);
    return { tokens, macros, focused, decorations: decorate(state, tokens, macros, focused) };
  };
  const field = StateField.define<{
    focused: boolean;
    tokens: Token[];
    macros: Macros;
    decorations: DecorationSet;
  }>({
    create: parse,
    update(old, tr) {
      const focused = tr.effects.find((e) => e.is(focus))?.value ?? old.focused;
      if (tr.docChanged) return parse(tr.state, focused, old.macros);
      if (!tr.selection && focused === old.focused) return old;
      return { ...old, focused, decorations: decorate(tr.state, old.tokens, old.macros, focused) };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (value) => value.decorations),
      currentFormulaEnd.compute([f, "selection"], (state) => {
        const { head, empty } = state.selection.main;
        if (!empty) return null;
        return (
          state
            .field(f)
            .tokens.find(
              (t) => (t.kind === "display" || t.kind === "math") && t.from <= head && head < t.to,
            )?.to ?? null
        );
      }),
    ],
  });
  return [
    field,
    EditorView.focusChangeEffect.of((_state, focused) => focus.of(focused)),
    EditorView.editorAttributes.of({ class: "t3-latex-paper" }),
    EditorView.theme({
      ".cm-content": {
        fontFamily: "Georgia, Cambria, serif",
        fontSize: "1.08rem",
        lineHeight: "1.65",
      },
      ".t3-tex-section,.t3-tex-subsection": { fontWeight: "bold" },
      ".t3-tex-section": { fontSize: "1.55em" },
      ".t3-tex-subsection": { fontSize: "1.23em" },
      ".t3-tex-bold,.t3-tex-marker": { fontWeight: "bold" },
      ".t3-tex-italic": { fontStyle: "italic" },
      ".t3-tex-display": {
        display: "inline-block",
        width: "100%",
        textAlign: "center",
        overflowX: "auto",
        verticalAlign: "middle",
      },
      ".t3-tex-math,.t3-tex-display,.t3-tex-bold,.t3-tex-italic,.t3-tex-marker": {
        color: "inherit",
      },
      ".t3-tex-edit-preview": {
        marginInlineStart: ".6em",
        paddingInline: ".4em",
        borderInlineStart: "2px solid var(--border)",
      },
    }),
  ];
}
