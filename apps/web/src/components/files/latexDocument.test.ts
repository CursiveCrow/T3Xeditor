import { describe, expect, it } from "vite-plus/test";

import { scanPaper } from "./latexDocument";

/** The source as the paper flows it: each joined line break becomes a space, or nothing. */
function flow(source: string) {
  let text = source;
  for (const join of scanPaper(source, "", {}).joins.toReversed())
    text = text.slice(0, join.from) + (join.tight ? "" : " ") + text.slice(join.to);
  return text;
}

describe("paragraph joins", () => {
  it.each([
    ["a hard-wrapped paragraph", "one\ntwo\n  three\n\nnext", "one two three\n\nnext"],
    [
      "an item continued on the next line",
      "\\begin{itemize}\n\\item first\n  more\n\\item second\n\\end{itemize}",
      "\\begin{itemize}\n\\item first more\n\\item second\n\\end{itemize}",
    ],
    ["a forced break", "a \\\\\nb", "a \\\\b"],
    ["a line ending in a comment", "a%\nb", "a%b"],
    ["text around a display", "text\n\\[\nx\n\\]\nmore\nwords", "text\n\\[\nx\n\\]\nmore words"],
    [
      "verbatim text",
      "a\n\\begin{verbatim}\nx\ny\n\\end{verbatim}\nb\nc",
      "a\n\\begin{verbatim}\nx\ny\n\\end{verbatim}\nb c",
    ],
    [
      "an environment the paper does not typeset",
      "\\begin{tikzpicture}\n\\draw (0,0);\n\\node {x};\n\\end{tikzpicture}",
      "\\begin{tikzpicture}\n\\draw (0,0);\n\\node {x};\n\\end{tikzpicture}",
    ],
    ["an environment still being typed", "\\begin{quote}\none\ntwo", "\\begin{quote}\none two"],
    [
      "commands on their own lines",
      "\\newpage\nText one\ntext two\n\\bibliography{refs}",
      "\\newpage\nText one text two\n\\bibliography{refs}",
    ],
    ["a heading", "\\chapter{A}\ntext\n\\textbf{bold}", "\\chapter{A}\ntext \\textbf{bold}"],
  ])("flows %s", (_name, source, flowed) => {
    expect(flow(source)).toBe(flowed);
  });

  it("spans a paragraph from its first line through the blank line that ends it", () => {
    expect(scanPaper("one\ntwo\n\nthree\nfour", "", {}).joins).toEqual([
      { from: 3, to: 4, tight: false, first: 0, last: 8 },
      { from: 14, to: 15, tight: false, first: 9, last: 19 },
    ]);
  });
});
