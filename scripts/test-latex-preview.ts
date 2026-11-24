import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { compileLatex as compileOnHost } from "../apps/server/src/workspace/compileLatex.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone host integration test runs the installed platform compiler.
const platform = process.platform;
const compileLatex = (input: Parameters<typeof compileOnHost>[0]) => compileOnHost(input, platform);

// Run with node scripts/test-latex-preview.ts on a workspace host with TeX Live or MiKTeX.
const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3latex-check-"));
try {
  const cwd = NodePath.join(dir, "project with spaces");
  await NodeFSP.mkdir(cwd);
  await NodeFSP.mkdir(NodePath.join(cwd, "parts"));
  const file = NodePath.join(cwd, "paper.tex");
  await NodeFSP.writeFile(
    file,
    String.raw`\documentclass{article}
\begin{document}
\input{parts/chapter}
\newpage
Another page with a reference to Section~\ref{sec:energy} and a citation~\cite{einstein}.
\bibliographystyle{plain}
\bibliography{library}
\end{document}`,
  );
  await NodeFSP.writeFile(
    NodePath.join(cwd, "parts/chapter.tex"),
    String.raw`\section{Energy}\label{sec:energy}
Mass and energy.
\[E=mc^2\]`,
  );
  await NodeFSP.writeFile(
    NodePath.join(cwd, "library.bib"),
    "@article{einstein,\n author={Albert Einstein},\n title={Energy},\n journal={Annalen},\n year={1905}\n}",
  );
  await NodeFSP.writeFile(NodePath.join(cwd, "paper.pdf"), "existing export");
  for (const engine of ["pdflatex", "xelatex", "lualatex"] as const) {
    const result = await compileLatex({ cwd, relativePath: "parts/chapter.tex", engine });
    NodeAssert.equal(result.mainFile, "paper.tex");
    NodeAssert.ok(result.pdf, result.log);
    NodeAssert.equal(Buffer.from(result.pdf, "base64").subarray(0, 5).toString(), "%PDF-");
    NodeAssert.ok(result.points.some((p) => p.path === "parts/chapter.tex" && p.page === 1));
    NodeAssert.ok(result.points.some((p) => p.path === "paper.tex" && p.page === 2));
    NodeAssert.ok(
      result.citations.some((c) => c.key === "einstein" && c.detail.includes("Einstein")),
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(cwd, "paper.pdf"), "utf8"),
      "existing export",
    );
    console.log(engine + " passed PDF, include, bibliography, SyncTeX and output isolation checks");
  }
  await NodeFSP.writeFile(
    file,
    "\\documentclass{article}\n\\begin{document}\n\\undefinedExample\n\\end{document}",
  );
  const failed = await compileLatex({ cwd, relativePath: "paper.tex", engine: "pdflatex" });
  NodeAssert.equal(failed.pdf, null);
  NodeAssert.match(failed.log, /Undefined control sequence/i);
  await NodeFSP.writeFile(NodePath.join(dir, "outside.tex"), "outside");
  const outside = await compileLatex({ cwd, relativePath: "../outside.tex", engine: "pdflatex" });
  NodeAssert.equal(outside.pdf, null);
  NodeAssert.match(outside.log, /inside this workspace/);
  NodeAssert.deepEqual((await NodeFSP.readdir(cwd)).sort(), [
    "library.bib",
    "paper.pdf",
    "paper.tex",
    "parts",
  ]);
  console.log("Failed build, workspace boundary and cleanup checks passed");
} finally {
  await NodeFSP.rm(dir, { recursive: true, force: true });
}
