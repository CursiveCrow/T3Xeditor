import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileLatex as compileOnHost } from "../apps/server/src/workspace/compileLatex.ts";

const compileLatex = (input: Parameters<typeof compileOnHost>[0]) =>
  compileOnHost(input, process.platform);

// Run with node scripts/test-latex-preview.ts on a workspace host with TeX Live or MiKTeX.
const dir = await mkdtemp(path.join(os.tmpdir(), "t3latex-check-"));
try {
  const cwd = path.join(dir, "project with spaces");
  await mkdir(cwd);
  await mkdir(path.join(cwd, "parts"));
  const file = path.join(cwd, "paper.tex");
  await writeFile(
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
  await writeFile(
    path.join(cwd, "parts/chapter.tex"),
    String.raw`\section{Energy}\label{sec:energy}
Mass and energy.
\[E=mc^2\]`,
  );
  await writeFile(
    path.join(cwd, "library.bib"),
    "@article{einstein,\n author={Albert Einstein},\n title={Energy},\n journal={Annalen},\n year={1905}\n}",
  );
  await writeFile(path.join(cwd, "paper.pdf"), "existing export");
  for (const engine of ["pdflatex", "xelatex", "lualatex"] as const) {
    const result = await compileLatex({ cwd, relativePath: "paper.tex", engine });
    assert.ok(result.pdf, result.log);
    assert.equal(Buffer.from(result.pdf, "base64").subarray(0, 5).toString(), "%PDF-");
    assert.ok(result.points.some((p) => p.path === "parts/chapter.tex" && p.page === 1));
    assert.ok(result.points.some((p) => p.path === "paper.tex" && p.page === 2));
    assert.ok(result.citations.some((c) => c.key === "einstein" && c.detail.includes("Einstein")));
    assert.equal(await readFile(path.join(cwd, "paper.pdf"), "utf8"), "existing export");
    console.log(engine + " passed PDF, include, bibliography, SyncTeX and output isolation checks");
  }
  await writeFile(
    file,
    "\\documentclass{article}\n\\begin{document}\n\\undefinedExample\n\\end{document}",
  );
  const failed = await compileLatex({ cwd, relativePath: "paper.tex", engine: "pdflatex" });
  assert.equal(failed.pdf, null);
  assert.match(failed.log, /Undefined control sequence/i);
  await writeFile(path.join(dir, "outside.tex"), "outside");
  const outside = await compileLatex({ cwd, relativePath: "../outside.tex", engine: "pdflatex" });
  assert.equal(outside.pdf, null);
  assert.match(outside.log, /inside this workspace/);
  assert.deepEqual((await readdir(cwd)).sort(), ["library.bib", "paper.pdf", "paper.tex", "parts"]);
  console.log("Failed build, workspace boundary and cleanup checks passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
