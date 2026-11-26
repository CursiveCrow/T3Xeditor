import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { FigureImage } from "./latexDocument";
import { LatexSource } from "./LatexSource";
import { EditorView, runScopeHandlers } from "@codemirror/view";

function paper(props: Partial<Parameters<typeof LatexSource>[0]> & { contents: string }) {
  return (
    <LatexSource
      preamble=""
      labels={{}}
      live
      readOnly={false}
      citations={[]}
      target={null}
      onChange={() => {}}
      onBuild={() => {}}
      onForward={() => {}}
      onSelection={() => {}}
      {...props}
    />
  );
}
// One row per editor line. `innerText` would also break at CodeMirror's out-of-flow caret images.
const shown = (content: HTMLElement) =>
  Array.from(content.querySelectorAll(".cm-line"), (line) => line.textContent).join("\n");

it("uses the manuscript's double-struck font for named gestalts in inline and displayed math", async () => {
  const contents = String.raw`
Local $a$ and named $\AccG$.
\[\mathbb{kawsroiZU019}_{\AccG}'\]`;
  const macro = String.raw`\newcommand{\AccG}{\mathbb{a}}`;
  await using result = await render(
    paper({ contents, preamble: String.raw`\usepackage[bb=dsserif]{mathalpha}` + "\n" + macro }),
  );
  const root = result.container;
  const fontOf = (node: Element | null) => node && getComputedStyle(node).fontFamily;
  const visibleLetter = (container: Element, text: string) =>
    [...container.querySelectorAll(".katex-html .mord")].find(
      (el) => !el.childElementCount && el.textContent === text,
    )!;
  await vi.waitFor(() => expect(root.querySelector(".t3-tex-display math")).not.toBeNull());
  const [ordinary, named] = root.querySelectorAll(".t3-tex-math");
  expect(fontOf(visibleLetter(named!, "a"))).toContain("T3 Double Struck");
  expect(fontOf(visibleLetter(ordinary!, "a"))).not.toContain("T3 Double Struck");
  const display = root.querySelector(".t3-tex-display")!;
  expect(fontOf(visibleLetter(display, "a"))).toContain("T3 Double Struck");
  const alphabet = [...display.querySelectorAll(".katex-html .mathsf")];
  expect(alphabet.map((letter) => letter.textContent).join("")).toContain("kawsroiZU019");
  for (const letter of alphabet) expect(fontOf(letter)).toContain("T3 Double Struck");
  expect(named!.querySelector("mi")?.getAttribute("mathvariant")).toBe("double-struck");
  expect((await document.fonts.load('20px "T3 Double Struck"', "a")).length).toBe(1);
});

it("keeps the default AMS alphabet when DSSerif is only mentioned in a comment", async () => {
  await using result = await render(
    paper({
      contents: String.raw`Named $\mathbb{N}$.`,
      preamble: String.raw`% \usepackage[bb=dsserif]{mathalpha}
\usepackage{amsfonts}`,
    }),
  );
  await vi.waitFor(() => expect(result.container.querySelector(".mathbb")).not.toBeNull());
  expect(getComputedStyle(result.container.querySelector(".mathbb")!).fontFamily).toContain(
    "KaTeX_AMS",
  );
});
const sample = {
  preamble: String.raw`\DeclareRobustCommand{\marked}[2]{\pdfliteral{/ActualText <#1>}#2\pdfliteral{EMC}}
\DeclareRobustCommand{\point}[1]{p_{#1}}
\DeclareRobustCommand{\ring}{\mathord{\marked{FEFF25CB}{\tikz\draw circle(1);}}}`,
  source: String.raw`\emph{A point $\point{x}$} and a ring $\ring$ in Definition~\ref{def:sample}.
\begin{gather}
\point{x} = \ring \label{eq:first} \\
\point{y} = \ring
\end{gather}`,
};
it("displays a paper with accessible symbols, references and gathered math", async () => {
  document.documentElement.classList.add("dark");
  try {
    await using result = await render(
      paper({
        contents: sample.source,
        preamble: sample.preamble,
        labels: { "def:sample": "1.4" },
      }),
    );
    const page = result.container.querySelector<HTMLElement>(".t3-latex-paper")!;
    expect(getComputedStyle(page).backgroundColor).toBe("rgb(255, 255, 255)");
    expect(getComputedStyle(page).color).toBe("rgb(0, 0, 0)");
    expect(getComputedStyle(page.querySelector(".cm-gutters")!).display).toBe("none");
    const view = EditorView.findFromDOM(page)!;
    const from = view.state.doc.toString().indexOf("\\begin{gather}");
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
    await vi.waitFor(() =>
      expect(page.querySelector(".t3-tex-display math mtable")).not.toBeNull(),
    );
    expect(
      [...page.querySelectorAll(".t3-tex-math,.t3-tex-display")]
        .filter((node) => !node.querySelector("math"))
        .map((n) => n.textContent),
    ).toEqual([]);
    view.dispatch({ effects: EditorView.scrollIntoView(1, { y: "start" }) });
    await vi.waitFor(() => expect(page.querySelector(".t3-tex-italic math")).not.toBeNull());
    const reference = page.querySelector<HTMLElement>(".t3-tex-reference")!;
    expect(reference.textContent).toBe("1.4");
    expect(getComputedStyle(reference).color).toBe("rgb(0, 0, 0)");
    expect(view.state.doc.toString()).toBe(sample.source);
    view.dispatch({ selection: { anchor: 12 } });
    await result.rerender(
      paper({ contents: sample.source + "\nMore.", preamble: sample.preamble }),
    );
    expect(view.state.doc.toString()).toBe(sample.source + "\nMore.");
    expect(view.state.selection.main.head).toBe(12);
  } finally {
    document.documentElement.classList.remove("dark");
  }
});

const excerpt = String.raw`\documentclass{article}
\usepackage[colorlinks,linkcolor=red]{hyperref}
\hypersetup{linkcolor=blue!55!black}
\theoremstyle{definition}
\newtheorem{definition}{Definition}[section]
\title{\vspace{-1em}\textbf{Test manuscript}\\[.3em]\large A subtitle}
\author{}\date{}
\begin{document}
\maketitle
\vspace{-1em}
\begin{abstract}
\noindent A summary.
\end{abstract}
% separator
\section{Contact (\texorpdfstring{$a\bowtie b$}{bowtie})}
\label{sec:contact}
\begin{definition}[Ownership]\label{def:scope}
See Definition~\ref{def:scope}---the \emph{\textbf{same} scope}.
\begin{enumerate}[label=(\arabic*),start=0,leftmargin=2.4em]
  \item outer text repeats long enough to wrap across multiple lines in a narrow column.
  \begin{itemize}
    \item nested text
  \end{itemize}
\end{enumerate}
\end{definition}
\noindent\begin{minipage}{\linewidth}
\small\centering
\begin{tabular}{@{}lc>{\raggedright\arraybackslash}p{0.47\textwidth}@{}}
\toprule
Symbol & Role & Meaning \\
\midrule
$x$ & A\&B & \emph{Text} \\
\bottomrule
\end{tabular}
\makeatletter\def\@captype{table}\makeatother
\caption{Notation}\label{tab:sample}
\end{minipage}
Wrapped
text flows.
\end{document}`;

it("renders the manuscript's front matter, numbered structures and booktabs on editable paper", async () => {
  await using result = await render(
    paper({
      contents: excerpt,
      labels: { "sec:contact": "1", "def:scope": "1.1", "tab:sample": "1" },
    }),
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  await vi.waitFor(() => expect(shown(content)).toContain("Test manuscript"));
  expect(view.scrollDOM.scrollTop).toBe(0);
  expect(shown(content)).not.toMatch(
    /Document preamble|\\maketitle|\\vspace|\\noindent|\\begin\{abstract\}|% separator|texorpdfstring/,
  );
  expect(shown(content)).toContain("Abstract");
  expect(shown(content)).toContain("Definition 1.1 (Ownership)");
  expect(shown(content)).toContain("Definition\u00a01.1\u2060—");
  expect(shown(content)).toContain("(0)");
  expect(shown(content)).toContain("\u2022");
  expect(content.querySelector(".t3-tex-section .katex-html")).not.toBeNull();
  expect(getComputedStyle(content.querySelector(".t3-tex-reference")!).color).toBe(
    "rgb(0, 0, 140)",
  );
  const rows = content.querySelectorAll("tr");
  expect(rows).toHaveLength(2);
  expect(rows[1]?.cells[1]?.textContent).toBe("A&B");
  expect(shown(content)).toContain("Table 1");
  function clickLiteral(text: string) {
    const target = [...content.querySelectorAll<HTMLElement>("[data-tex-literal]")].find(
      (node) => node.textContent === text,
    )!;
    target.scrollIntoView({ block: "center" });
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 0.1,
        clientY: box.top + box.height / 2,
      }),
    );
    expect(view.state.selection.main.head).toBe(excerpt.indexOf(text));
  }
  clickLiteral("Test manuscript");
  await vi.waitFor(() => expect(shown(content)).toContain("\\title{"));
  expect(shown(content)).not.toContain("\\documentclass");
  view.dispatch({
    effects: EditorView.scrollIntoView(excerpt.indexOf("\\begin{tabular}"), { y: "center" }),
  });
  await vi.waitFor(() => expect(content.querySelector("td .t3-tex-italic")).not.toBeNull());
  clickLiteral("Text");
  view.dispatch(view.state.replaceSelection("New "));
  expect(view.state.doc.toString()).toContain("\\emph{New Text}");
  expect(
    runScopeHandlers(
      view,
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: !/Mac/.test(navigator.platform),
        metaKey: /Mac/.test(navigator.platform),
      }),
      "editor",
    ),
  ).toBe(true);
  expect(view.state.doc.toString()).toBe(excerpt);
  const match = excerpt.indexOf("same");
  view.dispatch({ selection: { anchor: match, head: match + 4 } });
  await vi.waitFor(() => expect(shown(content)).toContain("\\textbf{same}"));
  view.dispatch({ selection: { anchor: 0 } });
  await vi.waitFor(() => expect(shown(content)).not.toContain("\\textbf{same}"));
  expect(shown(content)).not.toContain("\\documentclass");
  view.dispatch({ changes: { from: 0, insert: "%" }, selection: { anchor: 1 } });
  await vi.waitFor(() => expect(shown(content)).toContain("\\documentclass"));
  const wrapped = view.state.doc.toString().indexOf("Wrapped");
  view.dispatch({ effects: EditorView.scrollIntoView(wrapped, { y: "center" }) });
  await vi.waitFor(() => expect(shown(content)).toContain("Wrapped text flows."));
  view.dispatch({ selection: { anchor: wrapped } });
  await vi.waitFor(() => expect(shown(content)).toContain("Wrapped\ntext flows."));
});

const pixel = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

it("breaks a line only where TeX would around ties, formulas, symbols, dashes and thin spaces", async () => {
  const source =
    "Some words lead up to Clause~(2) and the value f($x$), then the $n$th pause---dash at 12\\,km, where $a+b=c+d$ holds for g(\\blueDot); here.";
  const figures = new Map<string, FigureImage>([
    ["\\blueDot", { url: pixel, width: 6, height: 8, baseline: { em: 10, depth: 2 } }],
  ]);
  await using result = await render(
    <div data-paper-host="" style={{ width: 400, height: 300 }}>
      {paper({ contents: source, figures })}
    </div>,
  );
  const host = result.container.querySelector<HTMLElement>("[data-paper-host]")!;
  await vi.waitFor(() => expect(host.querySelectorAll(".t3-tex-math math")).toHaveLength(3));
  await document.fonts.ready;
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-content")!)!;
  // Boxes on one line share a vertical center to within a few pixels; a line apart is about 20.
  const center = (box: { top: number; bottom: number }) => (box.top + box.bottom) / 2;
  const text = (part: string) => center(view.coordsAtPos(source.indexOf(part) + 1)!);
  const boxes = (selector: string) =>
    Array.from(host.querySelectorAll(selector), (node) => center(node.getBoundingClientRect()));
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  let wrapsInside = false;
  for (let width = 160; width <= 400; width += 2) {
    host.style.width = `${width}px`;
    const bases = boxes(".katex-base");
    const joints = {
      tie: [text("Clause"), text("(2)")],
      "formula in parentheses": [text("f("), bases[0]!, text("),")],
      "formula before letters": [bases[1]!, text("th pause")],
      dash: [text("pause"), boxes(".t3-tex-text")[1]!],
      "symbol in parentheses": [text("g("), boxes(".t3-tex-glyph img")[0]!, text(");")],
      "thin space": [text("12"), text("km")],
    };
    for (const [name, joint] of Object.entries(joints))
      expect(spread(joint), `${name} at ${width}px`).toBeLessThan(8);
    wrapsInside ||= spread(bases.slice(2)) > 8;
  }
  // KaTeX's own breaks after a relation or an operator survive.
  expect(wrapsInside).toBe(true);
});

const numberedMath = String.raw`\documentclass{article}
\DeclareRobustCommand{\marked}[2]{\pdfliteral{/Span << /ActualText <#1> >> BDC}#2\pdfliteral{EMC}}
\DeclareRobustCommand{\leftbr}{\mathopen{\marked{FEFF27E6}{[\![}}}
\DeclareRobustCommand{\rightbr}{\mathclose{\marked{FEFF27E7}{]\!]}}}
\DeclareRobustCommand{\io}{\mathord{\marked{FEFF03B925CB}{\iota_{\tikz\draw circle(1);}}}}
\begin{document}
\newcommand{\scope}[1]{\leftbr #1 \rightbr}
\begin{gather}
 P ::= \scope{D;\;I},\qquad D ::= \varepsilon\;\text{or}\; w \doteq B\,P\,D,\qquad I ::= E\;\text{or}\;u \label{first}\\[1em]
 B ::= u \triangleright v \;\text{or}\; \iota_{x}\;\text{or}\; \io \tag{B}\label{manual}\\
 I ::= E \;\text{or}\; u \label{last}
\end{gather}
See \eqref{first}, \eqref{manual} and \eqref{last}.
\end{document}`;

it("keeps custom symbols, row spacing and equation tags legible across paper widths", async () => {
  await using result = await render(
    <div data-paper-host="" style={{ width: 720, height: 430 }}>
      {paper({ contents: numberedMath })}
    </div>,
  );
  const host = result.container.querySelector<HTMLElement>("[data-paper-host]")!;
  await vi.waitFor(() => expect(host.querySelector(".t3-tex-equation-body")).not.toBeNull());
  await document.fonts.ready;
  const display = host.querySelector<HTMLElement>(".t3-tex-display")!;
  const body = display.querySelector<HTMLElement>(".t3-tex-equation-body")!;
  const tag = display.querySelector<HTMLElement>(".katex-tag")!;
  const scroller = host.querySelector<HTMLElement>(".cm-scroller")!;
  const bounds = (node: Element) => node.getBoundingClientRect();
  expect(display.querySelector("math annotation")?.textContent).toContain(String.raw`\\[1em]`);
  expect(tag.textContent.replaceAll("\u200b", "")).toBe("(1)(B)(2)");
  expect([...host.querySelectorAll(".t3-tex-reference")].map((n) => n.textContent)).toEqual([
    "(1)",
    "(B)",
    "(2)",
  ]);
  const glyph = (text: string) =>
    [...body.querySelectorAll("span")].find(
      (node) => !node.childElementCount && node.textContent === text,
    )!;
  expect([...display.querySelectorAll("math mo")].map((n) => n.textContent)).toEqual(
    expect.arrayContaining(["⟦", "⟧"]),
  );
  const open = bounds(glyph("["));
  const close = bounds(glyph("]"));
  expect(body.querySelectorAll(".mopen:not(:has(*))")).toHaveLength(2);
  expect(body.querySelectorAll(".mclose:not(:has(*))")).toHaveLength(2);
  expect(open.top).toBeLessThan(bounds(glyph("I")).top + 1);
  expect(open.height).toBeGreaterThan(0);
  expect(open.top).toBeCloseTo(close.top, 1);
  expect(open.bottom).toBeCloseTo(close.bottom, 1);
  const ring = glyph("∘");
  expect([...display.querySelectorAll("math msub")].some((node) => node.textContent === "ι○")).toBe(
    true,
  );
  expect(ring.closest(".mtight")).not.toBeNull();
  const base = [...body.querySelectorAll(".mathnormal")].findLast(
    (node) => node.textContent === "ι",
  )!;
  expect(bounds(ring).bottom).toBeGreaterThan(bounds(base).bottom);
  for (const width of [720, 277]) {
    host.style.width = width + "px";
    await vi.waitFor(() => expect(scroller.clientWidth).toBeLessThanOrEqual(width));
    expect(bounds(tag).left - bounds(body).right).toBeGreaterThan(4);
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
    if (width === 277) expect(display.scrollWidth).toBeGreaterThan(display.clientWidth);
    else expect(display.scrollWidth).toBeLessThanOrEqual(display.clientWidth + 1);
    display.scrollLeft = display.scrollWidth;
    expect(bounds(tag).right).toBeLessThanOrEqual(bounds(display).right + 1);
    expect(bounds(tag).left).toBeGreaterThanOrEqual(bounds(display).left);
  }
});

it("moves only a colliding align tag below its row and restores its baseline at a wider measure", async () => {
  const source = String.raw`\begin{align}
  a &= b \\
  x &= a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 \\
  z &= c
\end{align}`;
  await using result = await render(
    <div data-width-test="" style={{ width: 800, height: 380 }}>
      {paper({ contents: source })}
    </div>,
  );
  const host = result.container.querySelector<HTMLElement>("[data-width-test]")!;
  await vi.waitFor(() => expect(host.querySelector(".t3-tex-equation-body")).not.toBeNull());
  await document.fonts.ready;
  const display = host.querySelector<HTMLElement>(".t3-tex-display")!;
  const body = display.querySelector<HTMLElement>(".t3-tex-equation-body")!;
  const tag = display.querySelector<HTMLElement>(".katex-tag")!;
  const cells = Array.from(
    body.querySelectorAll<HTMLElement>(
      ".mtable > .col-align-l > .vlist-t > .vlist-r:first-child > .vlist > span > :last-child",
    ),
  );
  const nums = Array.from(
    tag.querySelectorAll<HTMLElement>(
      ":scope > .vlist-t > .vlist-r:first-child > .vlist > span > :last-child",
    ),
  );
  const top = (e: HTMLElement) => e.getBoundingClientRect().top;
  const baselineOffset = top(nums[1]!) - top(cells[1]!);
  const before = top(nums[2]!) - top(nums[0]!);
  display.style.width = `${Math.round(body.getBoundingClientRect().width + 10)}px`;
  await vi.waitFor(() =>
    expect(top(nums[1]!) - top(cells[1]!)).toBeGreaterThan(baselineOffset + 12),
  );
  expect(top(nums[2]!) - top(nums[0]!)).toBeGreaterThan(before + 12);
  expect(top(nums[2]!) - top(cells[2]!)).toBeLessThan(5);
  expect(nums[1]!.getBoundingClientRect().right).toBeLessThanOrEqual(
    display.getBoundingClientRect().right + 1,
  );
  expect(display.scrollWidth).toBeLessThanOrEqual(display.clientWidth + 1);
  display.style.width = "";
  await vi.waitFor(() => expect(top(nums[1]!) - top(cells[1]!)).toBeCloseTo(baselineOffset, 0));
  expect(top(nums[2]!) - top(nums[0]!)).toBeCloseTo(before, 0);
});

it.each(["align", "align*"])(
  "distributes %s pairs between equal margins when the paper resizes",
  async (env) => {
    const source = String.raw`\begin{${env}}
 I(\alpha) &= \int_0^{\infty} x^{\alpha-1}e^{-x}\,dx = \Gamma(\alpha), && \alpha>0, \\
 S_n &= \sum_{k=1}^{n}\frac{(-1)^{k+1}}{k^2}, && n\in\mathbb{N}.
\end{${env}}`;
    await using result = await render(paper({ contents: source }));
    await vi.waitFor(() =>
      expect(result.container.querySelector(".t3-tex-display .arraycolsep")).not.toBeNull(),
    );
    await document.fonts.ready;
    const display = result.container.querySelector<HTMLElement>(".t3-tex-display")!;
    const separator = display.querySelector<HTMLElement>(".mtable > .arraycolsep")!;
    const table = separator.parentElement!;
    for (const width of [620, 410, 620]) {
      display.style.width = `${width}px`;
      await vi.waitFor(() => {
        const outer = display.getBoundingClientRect();
        const inner = table.getBoundingClientRect();
        const gap = separator.getBoundingClientRect().width;
        expect(Math.abs(inner.left - outer.left - gap)).toBeLessThan(2);
        expect(Math.abs(outer.right - inner.right - gap)).toBeLessThan(2);
        expect(display.scrollWidth).toBeLessThanOrEqual(display.clientWidth + 1);
      });
    }
    const tag = display.querySelector(".katex-tag");
    if (env === "align") expect(tag?.textContent.replaceAll("\u200b", "")).toBe("(1)(2)");
    else expect(tag).toBeNull();
  },
);

it("reveals a compiled TikZ picture for editing and restores it on undo", async () => {
  const drawing = String.raw`\begin{tikzpicture}
\fill (0,0) rectangle (1,1);
\end{tikzpicture}`;
  const contents = `Start (\\blueDot).\n${drawing}\nAfter.\n\\textit{A symbol \\blueDot}`;
  const figures = new Map<string, FigureImage>([
    [drawing, { url: pixel, width: 28.4, height: 28.4 }],
    ["\\blueDot", { url: pixel, width: 6, height: 8, baseline: { em: 10, depth: 2 } }],
  ]);
  await using result = await render(paper({ contents, figures }));
  const content = result.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  const image = () => content.querySelector(".t3-tex-figure img");
  await vi.waitFor(() => expect(image()).not.toBeNull());
  const glyphs = content.querySelectorAll<HTMLImageElement>(".t3-tex-glyph img");
  expect(glyphs.length).toBe(2);
  expect(glyphs[0]!.style.verticalAlign).toBe("-0.2em");
  expect(glyphs[1]!.closest(".t3-tex-italic")).not.toBeNull();
  image()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(image()).toBeNull());
  await result.rerender(paper({ contents, figures: new Map(figures) }));
  expect(content.querySelectorAll(".t3-tex-glyph img")).toHaveLength(2);
  expect(image()).toBeNull();
  const at = contents.indexOf("rectangle");
  view.dispatch({ changes: { from: at, to: at + 9, insert: "grid" } });
  view.contentDOM.blur();
  await vi.waitFor(() => expect(shown(content)).toContain("grid"));
  expect(image()).toBeNull();
  view.focus();
  runScopeHandlers(
    view,
    new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: !/Mac/.test(navigator.platform),
      metaKey: /Mac/.test(navigator.platform),
    }),
    "editor",
  );
  view.contentDOM.blur();
  await vi.waitFor(() => expect(image()).not.toBeNull());
  expect(view.state.doc.toString()).toBe(contents);
});
