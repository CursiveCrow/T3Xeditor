import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { LatexSource } from "./LatexSource";
import { EditorView } from "@codemirror/view";
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
      <LatexSource
        contents={sample.source}
        preamble={sample.preamble}
        labels={{ "def:sample": "1.4" }}
        live
        readOnly={false}
        citations={[]}
        onChange={() => {}}
        onBuild={() => {}}
        onForward={() => {}}
        onSelection={() => {}}
        target={null}
      />,
    );
    const page = result.container.querySelector<HTMLElement>(".t3-latex-paper")!;
    expect(getComputedStyle(page).backgroundColor).toBe("rgb(255, 255, 255)");
    expect(getComputedStyle(page).color).toBe("rgb(20, 20, 20)");
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
    expect(page.querySelector(".t3-tex-reference")?.textContent).toBe("1.4");
    expect(view.state.doc.toString()).toBe(sample.source);
  } finally {
    document.documentElement.classList.remove("dark");
  }
});
