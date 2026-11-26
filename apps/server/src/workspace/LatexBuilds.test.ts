import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as LatexBuilds from "./LatexBuilds.ts";
import { bibliographyNames, parseBibEntries, parseSynctex } from "./LatexBuilds.ts";

const layerHost = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerTest = LatexBuilds.layer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(layerHost),
);

const writeProject = Effect.fn("writeProject")(function* (files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-latex-test-" });
  const cwd = path.join(dir, "project with spaces");
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(cwd, name);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, contents);
  }
  return { dir, cwd };
});

const MAIN = String.raw`\documentclass{article}
\usepackage{symbols}
\begin{document}
\input{parts/chapter}
\newpage
Another page with a reference to Section~\ref{sec:energy} and a citation~\cite{einstein}.
\bibliographystyle{plain}
\bibliography{library}
\end{document}`;

const CHAPTER = String.raw`\section{Energy}\label{sec:energy}
Mass and energy (\blueDot).
\[E=mc^2\]
\begin{center}
\begin{tikzpicture}
\fill[blue] (0,0) rectangle (2cm,1cm);
\end{tikzpicture}
\end{center}`;

const MANUSCRIPT = {
  "paper.tex": MAIN,
  "parts/chapter.tex": CHAPTER,
  "symbols.sty": String.raw`\RequirePackage{tikz}
\DeclareRobustCommand{\blueDot}{\tikz[baseline=-0.5ex]{\fill[blue] (0,0) circle(2pt);}}`,
  "library.bib":
    "@article{einstein,\n author={Albert Einstein},\n title={Energy},\n journal={Annalen},\n year={1905}\n}",
  "paper.pdf": "existing export",
};

it.layer(layerTest)("LatexBuilds", (it) => {
  it.effect("rejects a main file outside the workspace", () =>
    Effect.gen(function* () {
      const builds = yield* LatexBuilds.LatexBuilds;
      const { cwd } = yield* writeProject({
        "paper.tex": MAIN,
        "../outside.tex": "\\documentclass{article}",
      });
      const error = yield* builds
        .compile({ cwd, relativePath: "../outside.tex", engine: "pdflatex" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "LatexMainFileInvalidError",
        problem: "outside_workspace",
      });
    }),
  );

  it.effect("reads the including document's preamble and labels from a chapter", () =>
    Effect.gen(function* () {
      const builds = yield* LatexBuilds.LatexBuilds;
      const { cwd } = yield* writeProject({
        ...MANUSCRIPT,
        "paper.aux": "\\newlabel{sec:energy}{{1}{1}{Energy}{section.1}{}}\n",
      });
      const context = yield* builds.context({ cwd, relativePath: "parts/chapter.tex" });
      expect(context).toEqual({
        mainFile: "paper.tex",
        preamble: "\\documentclass{article}\n\\usepackage{symbols}\n",
        labels: { "sec:energy": "1", "page:sec:energy": "1" },
      });
    }),
  );

  it.effect("names each document that includes the chapter when there are several", () =>
    Effect.gen(function* () {
      const builds = yield* LatexBuilds.LatexBuilds;
      const { cwd } = yield* writeProject({
        "draft.tex": "\\documentclass{article}\\begin{document}\\include{parts/chapter}",
        "paper.tex": MAIN,
        "parts/chapter.tex": CHAPTER,
      });
      const error = yield* builds
        .compile({ cwd, relativePath: "parts/chapter.tex", engine: "pdflatex" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("LatexMainFileAmbiguousError");
      expect(error._tag === "LatexMainFileAmbiguousError" && [...error.candidates].sort()).toEqual([
        "draft.tex",
        "paper.tex",
      ]);
    }),
  );

  it.effect("reports a missing compiler when latexmk is not on PATH", () =>
    Effect.gen(function* () {
      const builds = yield* LatexBuilds.LatexBuilds;
      const { dir, cwd } = yield* writeProject(MANUSCRIPT);
      const error = yield* builds
        .compile({ cwd, relativePath: "paper.tex", engine: "pdflatex" })
        .pipe(Effect.provideService(HostProcess.Environment, { PATH: dir }), Effect.flip);
      expect(error._tag).toBe("LatexCompilerNotInstalledError");
    }),
  );
});

const SYNCTEX = `SyncTeX Version:1
Input:1:./paper.tex
Input:2:./parts/chapter.tex
Input:3:./symbols.sty
Input:4:../outside/notes.tex
Output:pdf
Magnification:1000
Unit:2
X Offset:0
Y Offset:0
Content:
{1
[2,1:2368143,500000:11304960,0,0
(2,5:2368143,1000000:1864680,932340,0
h2,2:2500000,1250000:0,0,0
h4,1:0,1300000:0,0,0
]
}1
{2
h1,6:2368143,1500000:0,0,0
}2
`;

it.layer(layerHost)("LatexBuilds parsing", (it) => {
  it.effect("reads SyncTeX points and TikZ figure boxes in PDF points", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = path.resolve("workspace");
      const result = parseSynctex(path, SYNCTEX, root, root, {
        path: "parts/chapter.tex",
        lines: new Set([5]),
      });
      expect(result.points.map(({ path, page, line }) => [path, page, line])).toEqual([
        ["parts/chapter.tex", 1, 1],
        ["parts/chapter.tex", 1, 5],
        ["parts/chapter.tex", 1, 2],
        ["paper.tex", 2, 6],
      ]);
      expect(result.points[0]!.y).toBeCloseTo(15.2018, 3);
      expect(result.points[3]!.y).toBeCloseTo(45.6053, 3);
      expect(result.figures).toHaveLength(1);
      const [figure] = result.figures;
      expect(figure).toMatchObject({ line: 5, page: 1 });
      // A 2 cm by 1 cm picture, one inch from the left edge.
      expect(figure!.x).toBeCloseTo(72, 3);
      expect(figure!.y).toBeCloseTo(2.0571, 3);
      expect(figure!.width).toBeCloseTo((72 / 2.54) * 2, 3);
      expect(figure!.height).toBeCloseTo(72 / 2.54, 3);
      expect([...result.packages]).toEqual([path.join(root, "symbols.sty")]);
    }),
  );

  it("reads citation keys from the bibliographies a build names", () => {
    expect(
      bibliographyNames(
        "\\addbibresource{refs.bib}\n% \\addbibresource{old.bib}\n",
        "\\bibdata{library, extra}",
      ),
    ).toEqual(new Set(["refs.bib", "library.bib", "extra.bib"]));
    expect(
      parseBibEntries(
        '@article{einstein,\n author={Albert Einstein},\n title={Energy},\n year={1905}\n}\n@book{knuth, title="The TeXbook"}',
      ),
    ).toEqual([
      ["einstein", "Albert Einstein ? Energy"],
      ["knuth", "The TeXbook"],
    ]);
  });
});

/** Records which document each latexmk run compiled. */
const makeRecordingBuilds = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const compiled: string[] = [];
  const recordingRunner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => compiled.push(input.args.at(-1)!)).pipe(Effect.andThen(runner.run(input))),
  });
  const builds = yield* LatexBuilds.LatexBuilds.pipe(
    Effect.provide(
      LatexBuilds.layer.pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, recordingRunner)),
      ),
    ),
  );
  return { builds, compiled };
});

const readText = Effect.fn("readText")(function* (file: string) {
  return yield* (yield* FileSystem.FileSystem).readFileString(file);
});

const projectFiles = Effect.fn("projectFiles")(function* (cwd: string) {
  return [...(yield* (yield* FileSystem.FileSystem).readDirectory(cwd))].sort();
});

const PROJECT_FILES = ["library.bib", "paper.pdf", "paper.tex", "parts", "symbols.sty"];

// Runs the host's TeX distribution; hosts without latexmk skip these.
const NEEDS_LATEXMK = "Needs latexmk on PATH.";

describe("LatexBuilds with TeX installed", () => {
  it.layer(ProcessRunner.layer.pipe(Layer.provideMerge(layerHost)), { excludeTestServices: true })(
    "latexmk",
    (it) => {
      it.effect.each(["pdflatex", "xelatex", "lualatex"] as const)(
        "builds a chapter through its main document with %s",
        (engine, ctx) =>
          Effect.gen(function* () {
            if (!(yield* isCommandAvailable("latexmk"))) return ctx.skip(NEEDS_LATEXMK);
            const path = yield* Path.Path;
            const { builds } = yield* makeRecordingBuilds;
            const { cwd } = yield* writeProject(MANUSCRIPT);
            const result = yield* builds.compile({
              cwd,
              relativePath: "parts/chapter.tex",
              engine,
            });
            expect(result.mainFile).toBe("paper.tex");
            expect(result.pdf, result.log).not.toBeNull();
            expect(Buffer.from(result.pdf!, "base64").subarray(0, 5).toString()).toBe("%PDF-");
            expect(result.points.some((p) => p.path === "parts/chapter.tex" && p.page === 1)).toBe(
              true,
            );
            expect(result.points.some((p) => p.path === "paper.tex" && p.page === 2)).toBe(true);
            expect(result.symbolSheet?.glyphs.map((glyph) => glyph.command)).toEqual(["\\blueDot"]);
            expect(result.symbolSheet!.glyphs[0]!.depth).toBeGreaterThan(0);
            expect(result.figures).toHaveLength(1);
            const [box] = result.figures;
            expect(box).toMatchObject({ page: 1, line: 7 });
            expect(box!.x).toBeGreaterThan(0);
            expect(box!.y).toBeGreaterThan(0);
            expect(Math.abs(box!.width - (72 / 2.54) * 2)).toBeLessThan(0.25);
            expect(Math.abs(box!.height - 72 / 2.54)).toBeLessThan(0.25);
            expect(
              result.citations.some((c) => c.key === "einstein" && c.detail.includes("Einstein")),
            ).toBe(true);
            expect(result.labels).toMatchObject({ "sec:energy": "1", "page:sec:energy": "1" });
            expect(yield* readText(path.join(cwd, "paper.pdf"))).toBe("existing export");
            expect(yield* projectFiles(cwd)).toEqual(PROJECT_FILES);
          }),
      );

      it.effect("reuses the symbol sheet while the preamble and packages are unchanged", (ctx) =>
        Effect.gen(function* () {
          if (!(yield* isCommandAvailable("latexmk"))) return ctx.skip(NEEDS_LATEXMK);
          const { builds, compiled } = yield* makeRecordingBuilds;
          const { cwd } = yield* writeProject(MANUSCRIPT);
          const input = { cwd, relativePath: "parts/chapter.tex", engine: "pdflatex" } as const;
          // Runs are counted per launcher, so a MiKTeX launcher without Perl adds one to each.
          const sheetRuns = () =>
            compiled.filter((document) => document.endsWith("symbols.tex")).length;
          const first = yield* builds.compile(input);
          const runsAfterFirst = compiled.length;
          const sheetRunsAfterFirst = sheetRuns();
          expect(sheetRunsAfterFirst).toBeGreaterThan(0);
          const second = yield* builds.compile(input);
          expect(compiled.length).toBeGreaterThan(runsAfterFirst);
          expect(sheetRuns()).toBe(sheetRunsAfterFirst);
          expect(second.symbolSheet).toBeDefined();
          expect(second.symbolSheet).toEqual(first.symbolSheet);
        }),
      );

      it.effect("returns the log of a failed build and leaves the project untouched", (ctx) =>
        Effect.gen(function* () {
          if (!(yield* isCommandAvailable("latexmk"))) return ctx.skip(NEEDS_LATEXMK);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { builds } = yield* makeRecordingBuilds;
          const { cwd } = yield* writeProject(MANUSCRIPT);
          yield* fileSystem.writeFileString(
            path.join(cwd, "paper.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\undefinedExample\n\\end{document}",
          );
          const failed = yield* builds.compile({
            cwd,
            relativePath: "paper.tex",
            engine: "pdflatex",
          });
          expect(failed.pdf).toBeNull();
          expect(failed.log).toMatch(/Undefined control sequence/i);
          expect(yield* readText(path.join(cwd, "paper.pdf"))).toBe("existing export");
          expect(yield* projectFiles(cwd)).toEqual(PROJECT_FILES);
        }),
      );
    },
  );
});
