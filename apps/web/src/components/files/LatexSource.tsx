import type { FigureImages } from "./latexDocument";
import "./latexPaper.css";
import { leaveLiveSource, liveLatex } from "./liveLatex";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { useTheme } from "~/hooks/useTheme";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { basicSetup } from "codemirror";
import {
  autocompletion,
  snippetCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { foldService, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const snippets = [
  ["section", "\\section{${title}}"],
  ["subsection", "\\subsection{${title}}"],
  ["equation", "\\begin{equation}\n  ${expression}\n\\end{equation}"],
  ["align", "\\begin{align}\n  ${a} &= ${b}\n\\end{align}"],
  [
    "figure",
    "\\begin{figure}\n  \\centering\n  \\includegraphics{${file}}\n  \\caption{${caption}}\n  \\label{fig:${name}}\n\\end{figure}",
  ],
  ["itemize", "\\begin{itemize}\n  \\item ${item}\n\\end{itemize}"],
  ["frac", "\\frac{${numerator}}{${denominator}}"],
  ["label", "\\label{${key}}"],
  ["ref", "\\ref{${key}}"],
  ["cite", "\\cite{${key}}"],
  ["textbf", "\\textbf{${text}}"],
].map(([name, text]) => snippetCompletion(text!, { label: "\\" + name, type: "keyword" }));

// Panels and the source view follow the app theme. The paper sets its own colors in latexPaper.css.
const chrome = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.55" },
  ".cm-content": { caretColor: "currentColor", paddingBlock: "8px" },
  ".cm-line": { paddingInline: "10px" },
  ".cm-panels": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "6px 28px 6px 8px" },
  ".cm-panel.cm-search label": { fontSize: "inherit" },
  ".cm-textfield": {
    backgroundColor: "transparent",
    border: "1px solid var(--input)",
    borderRadius: "6px",
    color: "inherit",
    fontSize: "inherit",
    padding: "3px 8px",
  },
  ".cm-button": {
    backgroundColor: "var(--popover)",
    backgroundImage: "none",
    border: "1px solid var(--input)",
    borderRadius: "6px",
    color: "inherit",
    fontSize: "inherit",
    padding: "3px 8px",
  },
  ".cm-button:active": { backgroundColor: "var(--accent)", backgroundImage: "none" },
  ".cm-panel.cm-search [name=close]": { color: "inherit", fontSize: "16px", padding: "2px 8px" },
});

function sourceTheme(dark: boolean) {
  return [
    EditorView.theme(
      {
        "&": { backgroundColor: "var(--code-background)", color: "var(--code-foreground)" },
        ".cm-gutters": {
          backgroundColor: "var(--code-background)",
          color: "var(--muted-foreground)",
          border: "none",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          backgroundColor: "color-mix(in srgb, var(--foreground) 5%, transparent)",
        },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
          { backgroundColor: "color-mix(in srgb, var(--primary) 30%, transparent)" },
      },
      { dark },
    ),
    dark ? syntaxHighlighting(oneDarkHighlightStyle) : [],
  ];
}

function complete(
  context: CompletionContext,
  citations: readonly { key: string; detail: string }[],
) {
  const argument = context.matchBefore(/\\(?:cite\w*|(?:eq|auto|page)?ref)\{[^{}\n]*$/);
  if (argument) {
    const text = context.state.doc.toString();
    const options = argument.text.startsWith("\\cite")
      ? citations.map((entry) => ({
          label: entry.key + " " + entry.detail,
          displayLabel: entry.key,
          detail: entry.detail,
          apply: entry.key,
          type: "reference",
        }))
      : [...text.matchAll(/\\label\{([^}]+)\}/g)].map((match) => ({
          label: match[1]!,
          type: "reference",
        }));
    return {
      from:
        argument.from +
        Math.max(argument.text.lastIndexOf("{"), argument.text.lastIndexOf(",")) +
        1,
      options,
    };
  }
  const command = context.matchBefore(/\\[a-zA-Z]*$/);
  return command ? { from: command.from, options: snippets } : null;
}

// Where each file was left, so returning to its tab resumes at the same text.
const places = new Map<
  string,
  {
    contents: string;
    selection: EditorState["selection"];
    scroll: ReturnType<EditorView["scrollSnapshot"]>;
  }
>();

export function LatexSource(props: {
  contents: string;
  /** Identifies the file whose caret and scroll position outlive this editor. */
  placeKey?: string;
  readOnly: boolean;
  live: boolean;
  preamble: string;
  labels: Readonly<Record<string, string>>;
  figures?: FigureImages | undefined;
  citations: readonly { key: string; detail: string }[];
  onChange: (text: string) => void;
  onBuild: () => void;
  onForward: () => void;
  onSelection: (text: string, line: number, end: number) => void;
  target: { line: number } | null;
}) {
  const { resolvedTheme } = useTheme();
  const [writable] = useState(() => new Compartment());
  const [rendering] = useState(() => new Compartment());
  const [theme] = useState(() => new Compartment());
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the mounted CodeMirror callbacks aligned with the latest committed props.
  useLayoutEffect(() => {
    latest.current = props;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Create and dispose the CodeMirror view for the current edit permission.
  useEffect(() => {
    if (!host.current) return;
    const { contents, placeKey } = latest.current;
    const saved = placeKey === undefined ? undefined : places.get(placeKey);
    // Positions only mean the same thing in the same text.
    const place = saved?.contents === contents ? saved : undefined;
    const view = new EditorView({
      parent: host.current,
      ...(place ? { scrollTo: place.scroll } : {}),
      state: EditorState.create({
        doc: contents,
        ...(place ? { selection: place.selection } : {}),
        extensions: [
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                latest.current.onBuild();
                return true;
              },
            },
            { key: "Escape", run: leaveLiveSource },
            {
              key: "Mod-Shift-j",
              run: () => {
                latest.current.onForward();
                return true;
              },
            },
          ]),
          // Typeset before the first paint so a restored scroll position lands on the paper.
          rendering.of(
            latest.current.live
              ? liveLatex({
                  preamble: latest.current.preamble,
                  labels: latest.current.labels,
                  figures: latest.current.figures,
                })
              : [],
          ),
          theme.of([]),
          basicSetup,
          StreamLanguage.define(stex),
          EditorView.lineWrapping,
          foldService.of((state, start, end) => {
            const first = state.doc.lineAt(start);
            const env = /^\s*\\begin\{([^}]+)\}/.exec(first.text)?.[1];
            if (!env) return null;
            let depth = 1;
            for (let number = first.number + 1; number <= state.doc.lines; number++) {
              const line = state.doc.line(number);
              for (const tag of line.text.split("%")[0]!.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
                if (tag[2] === env) depth += tag[1] === "begin" ? 1 : -1;
                if (depth === 0) return { from: end, to: line.from };
              }
            }
            return null;
          }),
          writable.of(EditorState.readOnly.of(latest.current.readOnly)),
          EditorView.contentAttributes.of({ "aria-label": m(msg("LaTeX source")) }),
          autocompletion({ override: [(context) => complete(context, latest.current.citations)] }),
          chrome,
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((t) => t.annotation(Transaction.remote))
            )
              latest.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const { from, to } = update.state.selection.main;
              latest.current.onSelection(
                update.state.sliceDoc(from, to),
                update.state.doc.lineAt(from).number,
                update.state.doc.lineAt(Math.max(from, to - 1)).number,
              );
            }
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      if (placeKey !== undefined)
        places.set(placeKey, {
          contents: view.state.doc.toString(),
          selection: view.state.selection,
          scroll: view.scrollSnapshot(),
        });
      view.destroy();
      editor.current = null;
    };
  }, [theme, rendering, writable]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Update CodeMirror permissions on the existing view.
  useEffect(() => {
    editor.current?.dispatch({
      effects: writable.reconfigure(EditorState.readOnly.of(props.readOnly)),
    });
  }, [writable, props.readOnly]);
  const shownLive = useRef(props.live);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reconfigure the mounted editor's typesetting layer without replacing its document or undo history.
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    const toggled = shownLive.current !== props.live;
    shownLive.current = props.live;
    // Source and paper lines differ in height, so keep the same text at the top across a switch.
    const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
    view.dispatch({
      effects: [
        rendering.reconfigure(
          props.live
            ? liveLatex({ preamble: props.preamble, labels: props.labels, figures: props.figures })
            : [],
        ),
        ...(toggled ? [EditorView.scrollIntoView(top, { y: "start" })] : []),
      ],
    });
  }, [props.live, props.preamble, props.labels, props.figures, rendering]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply the app theme to CodeMirror without resetting the document or undo history.
  useEffect(() => {
    editor.current?.dispatch({
      effects: theme.reconfigure(props.live ? [] : sourceTheme(resolvedTheme === "dark")),
    });
  }, [props.live, resolvedTheme, theme]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply document changes and navigation requests to the live CodeMirror view.
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const next = props.contents;
    if (current === next) return;
    // Replace only what differs so the caret and scroll position survive an outside edit.
    const shared = Math.min(current.length, next.length);
    let from = 0;
    while (from < shared && current.charCodeAt(from) === next.charCodeAt(from)) from++;
    let tail = 0;
    while (
      tail < shared - from &&
      current.charCodeAt(current.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
    )
      tail++;
    view.dispatch({
      changes: { from, to: current.length - tail, insert: next.slice(from, next.length - tail) },
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    });
  }, [props.contents]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply document changes and navigation requests to the live CodeMirror view.
  useEffect(() => {
    const view = editor.current;
    if (!view || !props.target) return;
    const pos = view.state.doc.line(
      Math.min(Math.max(1, props.target.line), view.state.doc.lines),
    ).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, [props.target]);
  return <div className="h-full min-h-0 overflow-hidden bg-background text-sm" ref={host} />;
}
