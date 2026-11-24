import "./latexPaper.css";
import { liveLatex, finishLiveFormula } from "./liveLatex";
import { oneDark } from "@codemirror/theme-one-dark";
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
import { foldService, StreamLanguage } from "@codemirror/language";
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

export function LatexSource(props: {
  contents: string;
  readOnly: boolean;
  live: boolean;
  preamble: string;
  labels: Readonly<Record<string, string>>;
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
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.contents,
        extensions: [
          keymap.of([
            {
              key: "Mod-Enter",
              run: (view) => {
                if (finishLiveFormula(view)) return true;
                latest.current.onBuild();
                return true;
              },
            },
            {
              key: "Mod-Shift-j",
              run: () => {
                latest.current.onForward();
                return true;
              },
            },
          ]),
          rendering.of([]),
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
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { overflow: "auto", lineHeight: "1.55" },
            ".cm-content": { caretColor: "currentColor", paddingBlock: "8px" },
            ".cm-line": { paddingInline: "10px" },
            ".cm-gutters": {
              backgroundColor: "var(--muted)",
              color: "var(--muted-foreground)",
              border: "none",
            },
          }),
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reconfigure the mounted editor's typesetting layer without replacing its document or undo history.
  useEffect(() => {
    editor.current?.dispatch({
      effects: rendering.reconfigure(props.live ? liveLatex(props.preamble, props.labels) : []),
    });
  }, [props.live, props.preamble, props.labels, rendering]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply the app theme to CodeMirror without resetting the document or undo history.
  useEffect(() => {
    editor.current?.dispatch({
      effects: theme.reconfigure(!props.live && resolvedTheme === "dark" ? oneDark : []),
    });
  }, [props.live, resolvedTheme, theme]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply document changes and navigation requests to the live CodeMirror view.
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.contents)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.contents },
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
