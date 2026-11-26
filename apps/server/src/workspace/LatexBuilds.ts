import type {
  ProjectCompileLatexInput,
  ProjectCompileLatexResult,
  ProjectLatexContext,
  ProjectLatexContextInput,
  ProjectLatexEngine,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPaths } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";

const BUILD_TIMEOUT_MS = 90_000;
const LOG_TAIL_CHARS = 32_000;
const PDF_MAX_BYTES = 12 * 1024 * 1024;
const SYNCTEX_MAX_BYTES = 32 * 1024 * 1024;
const SOURCE_MAX_BYTES = 4 * 1024 * 1024;
const AUX_MAX_BYTES = 2 * 1024 * 1024;
const COMPILER_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const POINTS_MAX = 100_000;
const CITATIONS_MAX = 5_000;
const GLYPH_COMMANDS_MAX = 64;
const GLYPH_PACKAGES_MAX = 64;
const GLYPH_PACKAGE_BUDGET_BYTES = 2 * 1024 * 1024;
const SYMBOL_SHEET_PDF_MAX_BYTES = 1024 * 1024;
const SYMBOL_SHEET_CACHE_ENTRIES = 8;
const PREAMBLE_MAX_CHARS = 128 * 1024;

const ENGINE_FLAGS = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" } as const;

export class LatexCompilerNotInstalledError extends Schema.TaggedError<LatexCompilerNotInstalledError>()(
  "LatexCompilerNotInstalledError",
  {
    // latexmk launchers on PATH that could not start because Perl was missing.
    launchersWithoutPerl: Schema.Number,
  },
) {
  override get message(): string {
    return "Install latexmk on the T3 workspace host to build PDFs.";
  }
}

export class LatexMainFileInvalidError extends Schema.TaggedError<LatexMainFileInvalidError>()(
  "LatexMainFileInvalidError",
  {
    relativePath: Schema.String,
    problem: Schema.Literals(["missing", "outside_workspace", "not_tex", "not_file"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Choose a .tex file inside this workspace.";
  }
}

export class LatexMainFileAmbiguousError extends Schema.TaggedError<LatexMainFileAmbiguousError>()(
  "LatexMainFileAmbiguousError",
  {
    relativePath: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Choose a main file: ${this.candidates.join(", ")}`;
  }
}

export class LatexBuildTimeoutError extends Schema.TaggedError<LatexBuildTimeoutError>()(
  "LatexBuildTimeoutError",
  {
    mainFile: Schema.String,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The LaTeX build of '${this.mainFile}' did not finish within ${this.timeoutMs / 1000} seconds.`;
  }
}

export class LatexPdfTooLargeError extends Schema.TaggedError<LatexPdfTooLargeError>()(
  "LatexPdfTooLargeError",
  {
    mainFile: Schema.String,
    byteLength: Schema.Number,
    limitBytes: Schema.Number,
  },
) {
  override get message(): string {
    return "PDF exceeds the 12 MiB preview limit.";
  }
}

export class LatexBuildOperationError extends Schema.TaggedError<LatexBuildOperationError>()(
  "LatexBuildOperationError",
  {
    operation: Schema.Literals([
      "resolve-workspace",
      "find-main-file",
      "create-build-directory",
      "run-compiler",
      "read-output",
    ]),
    relativePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `LaTeX build step '${this.operation}' failed for '${this.relativePath}'.`;
  }
}

export const LatexBuildError = Schema.Union([
  LatexCompilerNotInstalledError,
  LatexMainFileInvalidError,
  LatexMainFileAmbiguousError,
  LatexBuildTimeoutError,
  LatexPdfTooLargeError,
  LatexBuildOperationError,
]);
export type LatexBuildError = typeof LatexBuildError.Type;

type SymbolSheet = NonNullable<ProjectCompileLatexResult["symbolSheet"]>;

export class LatexBuilds extends Context.Service<
  LatexBuilds,
  {
    /** Best-effort editor context: unreadable files fall back to the requested path and no labels. */
    readonly context: (input: ProjectLatexContextInput) => Effect.Effect<ProjectLatexContext>;
    /** Builds into a temporary directory; a build that runs and fails returns `pdf: null` and its log. */
    readonly compile: (
      input: ProjectCompileLatexInput,
    ) => Effect.Effect<ProjectCompileLatexResult, LatexBuildError>;
  }
>()("t3/workspace/LatexBuilds") {}

const isTexPath = (file: string) => /\.tex$/i.test(file);

const workspaceRelative = (path: Path.Path, root: string, file: string) =>
  path.relative(root, file).split(path.sep).join("/");

const stripLineComments = (text: string) => text.replace(/(?<!\\)%[^\n]*/g, "");

const isLatexDocument = (text: string) =>
  /\\(?:documentclass|documentstyle)\s*(?:\[|\{)/.test(text);

/** Names passed to `\input`, `\include` and `\subfile`, as written. */
const includedNames = (source: string) =>
  [...source.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);

/** Includes resolve against the main document's directory, as TeX runs from there. */
const documentIncludes = (
  path: Path.Path,
  includes: ReadonlyMap<string, ReadonlyArray<string>>,
  main: string,
  target: string,
) => {
  const seen = new Set<string>();
  const pending = [main];
  while (pending.length) {
    const file = pending.pop()!;
    if (file === target) return true;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const name of includes.get(file) ?? []) {
      pending.push(path.resolve(path.dirname(main), isTexPath(name) ? name : name + ".tex"));
    }
  }
  return false;
};

/** `\newlabel{name}{{number}{page}...}` rows; `page:name` holds the page. */
const parseAuxLabels = (aux: string) => {
  const labels: Record<string, string> = Object.create(null);
  for (const match of aux.matchAll(/^\\newlabel\{([^}]+)\}\{\{([^{}]*)\}\{([^{}]*)\}/gm)) {
    labels[match[1]!] = match[2]!;
    labels["page:" + match[1]!] = match[3]!;
  }
  return labels;
};

/** Bibliography files named by biblatex in the main source or by BibTeX in the build's .aux. */
export const bibliographyNames = (mainSource: string, aux: string) => {
  const names = new Set<string>();
  for (const match of mainSource.matchAll(
    /^[^%\n]*?\\addbibresource(?:\[[^\]]*\])?\{([^}]+)\}/gm,
  )) {
    names.add(match[1]!);
  }
  for (const match of aux.matchAll(/\\bibdata\{([^}]+)\}/g)) {
    for (const name of match[1]!.split(",")) names.add(name.trim() + ".bib");
  }
  return names;
};

/** Entry keys with their author and title, for citation completion. */
export const parseBibEntries = (bib: string) =>
  [...bib.matchAll(/@\w+\s*[{(]\s*([^\s,]+),([\s\S]*?)(?=\n\s*@|$)/g)].map((entry) => {
    const detail = [...entry[2]!.matchAll(/\b(?:author|title)\s*=\s*[{"]([^\n"]+)/gi)]
      .map((field) => field[1]!.replace(/[{},]+$/g, "").trim())
      .join(" ? ");
    return [entry[1]!, detail.slice(0, 300)] as const;
  });

/** The figure source whose `\end{tikzpicture}` lines mark SyncTeX boxes to measure. */
interface FigureSource {
  readonly path: string;
  readonly lines: ReadonlySet<number>;
}

// One sp is 1/65536 pt and 72.27 pt make 72 bp: SyncTeX units scale by unit and magnification.
const SP_PER_BP = 65781.76;

/**
 * Reads a SyncTeX file into the first box per source line and page, and the largest box that ends
 * each TikZ picture in `source`. Coordinates are PDF points from the page's top left.
 */
export const parseSynctex = (
  path: Path.Path,
  data: string,
  root: string,
  cwd: string,
  source: FigureSource | undefined,
) => {
  const boxes = new Map<string, ProjectCompileLatexResult["figures"][number]>();
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const points = new Map<string, ProjectCompileLatexResult["points"][number]>();
  let page = 0;
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  let magnification = 1000;
  let previousY = 0;
  for (const row of data.split(/\r?\n/)) {
    if (row.startsWith("Unit:")) unit = Number(row.slice(5));
    if (row.startsWith("X Offset:")) xOffset = Number(row.slice(9));
    if (row.startsWith("Y Offset:")) yOffset = Number(row.slice(9));
    if (row.startsWith("Magnification:")) magnification = Number(row.slice(14));
    const input = /^Input:(\d+):(.+)$/.exec(row);
    if (input) {
      const file = path.resolve(cwd, input[2]!);
      const inside = isWithinRoot(path, file, root);
      if (inside && /\.sty$/i.test(file) && packages.size < GLYPH_PACKAGES_MAX) packages.add(file);
      if (inside && isTexPath(file)) files.set(input[1]!, workspaceRelative(path, root, file));
      continue;
    }
    if (row.startsWith("{")) {
      page = Number(row.slice(1));
      continue;
    }
    const box = /^[[(hvxkg$](\d+),(\d+)(?:,\d+)?:-?\d+,(-?\d+|=)/.exec(row);
    if (!box) continue;
    if (box[3] !== "=") previousY = Number(box[3]);
    const file = files.get(box[1]!);
    if (!file || !page) continue;
    const key = [file, page, box[2]].join("\0");
    const line = Number(box[2]);
    const scale = magnification / 1000 / SP_PER_BP;
    if (row[0] === "(" && source?.path === file && source.lines.has(line)) {
      const size = /^\(\d+,\d+(?:,\d+)?:([\d-]+),(?:[\d-]+|=):([\d-]+),([\d-]+),([\d-]+)/.exec(row);
      if (size) {
        const [x, width, height, depth] = size.slice(1).map(Number) as [
          number,
          number,
          number,
          number,
        ];
        const w = width * unit * scale;
        const h = (height + depth) * unit * scale;
        const old = boxes.get(key);
        if (w > 0 && h > 0 && (!old || w * h > old.width * old.height)) {
          boxes.set(key, {
            line,
            page,
            x: (x * unit + xOffset) * scale,
            y: ((previousY - height) * unit + yOffset) * scale,
            width: w,
            height: h,
          });
        }
      }
    }
    if (!points.has(key) && points.size < POINTS_MAX) {
      points.set(key, { path: file, page, line, y: (previousY * unit + yOffset) * scale });
    }
  }
  return { points: [...points.values()], figures: [...boxes.values()], packages };
};

const uncomment = (text: string) =>
  text.replace(/\\.|%[^\n]*/g, (value) => (value.startsWith("%") ? "" : value));

const TIKZ_COMMAND_DEFINITION =
  /\\(?:DeclareRobustCommand|newcommand|providecommand)\*?\s*\{(\\[A-Za-z]+)\}\s*\{\s*\\tikz\b/g;

/** Zero-argument `\tikz` macros defined in `text` that the figure source uses. */
const collectTikzCommands = (text: string, used: ReadonlySet<string>, commands: Set<string>) => {
  for (const match of uncomment(text).matchAll(TIKZ_COMMAND_DEFINITION)) {
    if (used.has(match[1]!) && commands.size < GLYPH_COMMANDS_MAX) commands.add(match[1]!);
  }
};

/**
 * One tight preview page per glyph, using the main document's preamble so fonts, colors and engine
 * match. Each glyph's depth and the font's em are logged so the editor can sit it on its baseline.
 */
const symbolSheetDocument = (preamble: string, commands: Iterable<string>) =>
  [
    preamble,
    String.raw`\usepackage[active,tightpage]{preview}\setlength\PreviewBorder{0.35bp}\begin{document}`,
    ...Array.from(
      commands,
      (command, i) =>
        String.raw`\setbox0=\hbox{${command}}\typeout{T3GLYPH:${i}:\the\dp0:\the\fontdimen6\font}\begin{preview}\copy0\end{preview}`,
    ),
    String.raw`\end{document}`,
  ].join("\n");

const parseGlyphMetrics = (log: string) =>
  new Map(
    [...log.matchAll(/^T3GLYPH:(\d+):(-?[\d.]+)pt:([\d.]+)pt\r?$/gm)].map(
      (match) =>
        [
          Number(match[1]),
          {
            depth: (Number(match[2]) * 72) / 72.27 + 0.35,
            em: (Number(match[3]) * 72) / 72.27,
          },
        ] as const,
    ),
  );

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const digest = yield* Digest.Digest;
  // A sheet only changes with the preamble or its packages, so a few entries cover open documents.
  const symbolSheets = new Map<string, SymbolSheet>();

  const sha256 = (text: string) => digest.digestHex(Digest.sha256, new TextEncoder().encode(text));

  const fileSize = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? Number(info.size) : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  /** A real path inside `root`, or nothing when it is missing or escapes. */
  const realPathWithin = (root: string, file: string) =>
    fileSystem
      .realPath(file)
      .pipe(Effect.option, Effect.map(Option.filter((real) => isWithinRoot(path, real, root))));

  // Prefer the nearest project. Archived drafts often reuse chapter and master filenames.
  const findMainFile = Effect.fn("LatexBuilds.findMainFile")(function* (
    root: string,
    chapter: string,
    relativePath: string,
  ) {
    const toOperationError = (cause: unknown) =>
      new LatexBuildOperationError({ operation: "find-main-file", relativePath, cause });
    const chapterSource = yield* fileSystem
      .readFileString(chapter)
      .pipe(Effect.mapError(toOperationError));
    if (isLatexDocument(stripLineComments(chapterSource))) return chapter;
    const includes = new Map<string, ReadonlyArray<string>>();
    const documents = new Set<string>();
    for (let dir = path.dirname(chapter); isWithinRoot(path, dir, root); dir = path.dirname(dir)) {
      const entries = yield* fileSystem
        .readDirectoryEntries(dir)
        .pipe(Effect.mapError(toOperationError));
      for (const entry of entries) {
        if (entry.type !== "File" || !isTexPath(entry.name)) continue;
        const file = path.join(dir, entry.name);
        const size = yield* fileSize(file);
        if (size === undefined || size > SOURCE_MAX_BYTES) continue;
        const source = stripLineComments(
          yield* fileSystem.readFileString(file).pipe(Effect.mapError(toOperationError)),
        );
        if (isLatexDocument(source)) documents.add(file);
        includes.set(file, includedNames(source));
      }
      const matches = [...documents].filter((main) =>
        documentIncludes(path, includes, main, chapter),
      );
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        return yield* new LatexMainFileAmbiguousError({
          relativePath,
          candidates: matches.map((file) => workspaceRelative(path, root, file)),
        });
      }
      if (dir === root || dir === path.dirname(dir)) break;
    }
    return chapter;
  });

  const resolveMainFile = Effect.fn("LatexBuilds.resolveMainFile")(function* (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) {
    const relativePath = input.relativePath;
    const root = yield* fileSystem
      .realPath(input.cwd)
      .pipe(
        Effect.mapError(
          (cause) =>
            new LatexBuildOperationError({ operation: "resolve-workspace", relativePath, cause }),
        ),
      );
    const requested = yield* fileSystem
      .realPath(path.resolve(root, relativePath))
      .pipe(
        Effect.mapError(
          (cause) => new LatexMainFileInvalidError({ relativePath, problem: "missing", cause }),
        ),
      );
    if (!isWithinRoot(path, requested, root)) {
      return yield* new LatexMainFileInvalidError({ relativePath, problem: "outside_workspace" });
    }
    if (!isTexPath(requested)) {
      return yield* new LatexMainFileInvalidError({ relativePath, problem: "not_tex" });
    }
    if ((yield* fileSize(requested)) === undefined) {
      return yield* new LatexMainFileInvalidError({ relativePath, problem: "not_file" });
    }
    const file = yield* findMainFile(root, requested, relativePath);
    return { root, file, mainFile: workspaceRelative(path, root, file) };
  });

  // Some Windows installs put MiKTeX before a self-contained TeX Live. Try the next latexmk on
  // PATH only when this launcher cannot find Perl; any other failure is the build's own result.
  const runLatexmk = Effect.fn("LatexBuilds.runLatexmk")(function* (input: {
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly mainFile: string;
  }) {
    const env = yield* HostProcess.Environment;
    const delimiter = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const launchers = yield* resolveCommandPaths("latexmk", { env, until: () => false }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    let launchersWithoutPerl = 0;
    for (const launcher of launchers.filter((candidate) => path.isAbsolute(candidate))) {
      const output = yield* processRunner
        .run({
          command: launcher,
          args: input.args,
          cwd: input.cwd,
          timeout: BUILD_TIMEOUT_MS,
          // Engines from the same distribution as this launcher come first.
          env: { [pathKey]: path.dirname(launcher) + delimiter + (env[pathKey] ?? "") },
          maxOutputBytes: COMPILER_OUTPUT_MAX_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProcessTimeoutError"
              ? new LatexBuildTimeoutError({
                  mainFile: input.mainFile,
                  timeoutMs: BUILD_TIMEOUT_MS,
                  cause,
                })
              : new LatexBuildOperationError({
                  operation: "run-compiler",
                  relativePath: input.mainFile,
                  cause,
                }),
          ),
        );
      const log = [output.stdout, output.stderr].filter(Boolean).join("\n");
      const succeeded = output.code !== null && Number(output.code) === 0;
      if (!succeeded && log.includes("could not find the script engine 'perl'")) {
        launchersWithoutPerl++;
        continue;
      }
      return { succeeded, log };
    }
    return yield* new LatexCompilerNotInstalledError({ launchersWithoutPerl });
  });

  const readFigureSource = Effect.fn("LatexBuilds.readFigureSource")(function* (
    root: string,
    relativePath: string,
  ) {
    const file = yield* realPathWithin(root, path.resolve(root, relativePath));
    if (Option.isNone(file) || !isTexPath(file.value)) return undefined;
    const info = yield* fileSystem.stat(file.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return undefined;
    if (Number(info.value.size) > SOURCE_MAX_BYTES) return undefined;
    const text = (yield* fileSystem.readFileString(file.value).pipe(Effect.option)).pipe(
      Option.map((value) => value.replace(/\r\n?/g, "\n")),
    );
    if (Option.isNone(text)) return undefined;
    const lines = new Set<number>();
    text.value.split("\n").forEach((line, i) => {
      if (/^\s*\\end\{tikzpicture\}\s*(?:%.*)?$/.test(line)) lines.add(i + 1);
    });
    return {
      path: workspaceRelative(path, root, file.value),
      lines,
      text: text.value,
      hash: yield* sha256(text.value),
      file: file.value,
      mtime: Option.getOrUndefined(info.value.mtime)?.getTime(),
    };
  });

  const modifiedAt = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
      Effect.option,
    );

  /** Measures zero-argument inline `\tikz` macros the figure source uses; nothing when none. */
  const buildSymbolSheet = Effect.fn("LatexBuilds.buildSymbolSheet")(function* (input: {
    readonly mainSource: string;
    readonly figureSource: string;
    readonly packages: ReadonlySet<string>;
    readonly root: string;
    readonly cwd: string;
    readonly buildDirectory: string;
    readonly engine: ProjectLatexEngine;
    readonly mainFile: string;
  }) {
    const masked = input.mainSource.replace(/\\.|%[^\n]*/g, (value) =>
      value.startsWith("%") ? " ".repeat(value.length) : value,
    );
    const start = /^[ \t]*\\begin\s*\{document\}/m.exec(masked);
    if (!start) return undefined;
    const preamble = input.mainSource.slice(0, start.index);
    const body = uncomment(input.figureSource)
      .split(/^[ \t]*\\begin\s*\{document\}/m)
      .at(-1)!;
    const used = new Set(body.match(/\\[A-Za-z]+/g));
    const commands = new Set<string>();
    collectTikzCommands(preamble, used, commands);
    const packageSources: string[] = [];
    let budget = GLYPH_PACKAGE_BUDGET_BYTES;
    for (const pkg of input.packages) {
      const file = yield* realPathWithin(input.root, pkg);
      if (Option.isNone(file)) continue;
      const size = yield* fileSize(file.value);
      if (size === undefined || size > budget) continue;
      budget -= size;
      const text = yield* fileSystem.readFileString(file.value);
      packageSources.push(text);
      collectTikzCommands(text, used, commands);
    }
    if (!commands.size) return undefined;
    const document = symbolSheetDocument(preamble, commands);
    const key = yield* sha256([input.engine, input.cwd, document, ...packageSources].join("\0"));
    const cached = symbolSheets.get(key);
    if (cached) return cached;

    const dir = path.join(input.buildDirectory, "symbols");
    yield* fileSystem.makeDirectory(dir);
    const source = path.join(dir, "symbols.tex");
    yield* fileSystem.writeFileString(source, document);
    const run = yield* runLatexmk({
      args: [
        "-norc",
        ENGINE_FLAGS[input.engine],
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-outdir=" + dir,
        source,
      ],
      cwd: input.cwd,
      mainFile: input.mainFile,
    });
    if (!run.succeeded) return undefined;
    const metrics = parseGlyphMetrics(
      yield* fileSystem.readFileString(path.join(dir, "symbols.log")),
    );
    const pdf = path.join(dir, "symbols.pdf");
    const pdfSize = yield* fileSize(pdf);
    if (metrics.size !== commands.size || pdfSize === undefined) return undefined;
    if (pdfSize > SYMBOL_SHEET_PDF_MAX_BYTES) return undefined;
    const sheet: SymbolSheet = {
      pdf: Buffer.from(yield* fileSystem.readFile(pdf)).toString("base64"),
      glyphs: Array.from(commands, (command, i) => ({ command, ...metrics.get(i)! })),
    };
    if (symbolSheets.size >= SYMBOL_SHEET_CACHE_ENTRIES) {
      symbolSheets.delete(symbolSheets.keys().next().value!);
    }
    symbolSheets.set(key, sheet);
    return sheet;
  });

  const readCitations = Effect.fn("LatexBuilds.readCitations")(function* (
    root: string,
    cwd: string,
    names: ReadonlySet<string>,
  ) {
    const citations = new Map<string, string>();
    for (const name of names) {
      const bib = yield* realPathWithin(root, path.resolve(cwd, name));
      if (Option.isNone(bib)) continue;
      const size = yield* fileSize(bib.value);
      if (size === undefined || size > SOURCE_MAX_BYTES) continue;
      const text = yield* fileSystem.readFileString(bib.value).pipe(Effect.option);
      if (Option.isNone(text)) continue;
      for (const [key, detail] of parseBibEntries(text.value)) citations.set(key, detail);
    }
    return [...citations].slice(0, CITATIONS_MAX).map(([key, detail]) => ({ key, detail }));
  });

  const context: LatexBuilds["Service"]["context"] = Effect.fn("LatexBuilds.context")(
    function* (input) {
      const { root, file, mainFile } = yield* resolveMainFile(input);
      const text = yield* fileSystem.readFileString(file);
      const aux = yield* realPathWithin(root, file.replace(/\.tex$/i, ".aux"));
      let labels: Record<string, string> = {};
      if (Option.isSome(aux)) {
        const size = yield* fileSize(aux.value);
        if (size !== undefined && size <= AUX_MAX_BYTES) {
          labels = parseAuxLabels(yield* fileSystem.readFileString(aux.value));
        }
      }
      return {
        labels,
        mainFile,
        preamble: (text.split(/\\begin\s*\{document\}/, 1)[0] ?? "").slice(0, PREAMBLE_MAX_CHARS),
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.orElseSucceed(() => ({ mainFile: input.relativePath, preamble: "", labels: {} })),
      ),
  );

  const compile: LatexBuilds["Service"]["compile"] = Effect.fn("LatexBuilds.compile")(function* (
    input,
  ) {
    const { root, file, mainFile } = yield* resolveMainFile(input);
    const cwd = path.dirname(file);
    const stem = path.basename(file, path.extname(file));
    const readOutputError = (cause: unknown) =>
      new LatexBuildOperationError({ operation: "read-output", relativePath: mainFile, cause });
    // Output goes to a fresh directory so a user's own PDF and aux files are never replaced.
    const buildDirectory = yield* Effect.acquireRelease(
      fileSystem.makeTempDirectory({ prefix: "t3latex-" }).pipe(
        Effect.mapError(
          (cause) =>
            new LatexBuildOperationError({
              operation: "create-build-directory",
              relativePath: mainFile,
              cause,
            }),
        ),
      ),
      // Windows can hold a just-killed compiler's files open briefly.
      (dir) =>
        fileSystem
          .remove(dir, { recursive: true, force: true })
          .pipe(Effect.retry({ times: 3, schedule: Schedule.spaced("100 millis") }), Effect.ignore),
    );
    const figureSource = yield* readFigureSource(root, input.figurePath ?? input.relativePath);
    // No shell, project .latexmkrc, or TeX shell escape.
    const run = yield* runLatexmk({
      args: [
        "-norc",
        ENGINE_FLAGS[input.engine],
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "-synctex=-1",
        "-outdir=" + buildDirectory,
        "./" + path.basename(file),
      ],
      cwd,
      mainFile,
    });
    const log = run.log.slice(-LOG_TAIL_CHARS);
    const output = path.join(buildDirectory, stem + ".pdf");
    const pdfSize = run.succeeded ? yield* fileSize(output) : undefined;
    if (pdfSize === undefined) {
      return { mainFile, pdf: null, log, points: [], figures: [], citations: [], labels: {} };
    }
    if (pdfSize > PDF_MAX_BYTES) {
      return yield* new LatexPdfTooLargeError({
        mainFile,
        byteLength: pdfSize,
        limitBytes: PDF_MAX_BYTES,
      });
    }
    // Figure boxes and the symbol sheet are only valid for the source this build compiled.
    const modified = figureSource ? yield* modifiedAt(figureSource.file) : Option.none();
    const unchanged =
      figureSource !== undefined &&
      Option.isSome(modified) &&
      modified.value === figureSource.mtime;
    const synctex = path.join(buildDirectory, stem + ".synctex");
    const synctexSize = yield* fileSize(synctex);
    const { points, figures, packages } =
      synctexSize !== undefined && synctexSize <= SYNCTEX_MAX_BYTES
        ? parseSynctex(
            path,
            yield* fileSystem.readFileString(synctex).pipe(Effect.mapError(readOutputError)),
            root,
            cwd,
            unchanged ? figureSource : undefined,
          )
        : { points: [], figures: [], packages: new Set<string>() };
    const aux = yield* fileSystem
      .readFileString(path.join(buildDirectory, stem + ".aux"))
      .pipe(Effect.orElseSucceed(() => ""));
    const mainSource = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.mapError(readOutputError));
    const symbolSheet = unchanged
      ? yield* buildSymbolSheet({
          mainSource,
          figureSource: figureSource.text,
          packages,
          root,
          cwd,
          buildDirectory,
          engine: input.engine,
          mainFile,
        }).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    const citations = yield* readCitations(root, cwd, bibliographyNames(mainSource, aux));
    const pdf = yield* fileSystem.readFile(output).pipe(Effect.mapError(readOutputError));
    return {
      mainFile,
      pdf: Buffer.from(pdf).toString("base64"),
      points,
      figures,
      ...(symbolSheet ? { symbolSheet } : {}),
      ...((figures.length || symbolSheet) && figureSource
        ? { figureSourceHash: figureSource.hash }
        : {}),
      citations,
      labels: parseAuxLabels(aux),
      log,
    };
  }, Effect.scoped);

  return LatexBuilds.of({ context, compile });
});

export const layer = Layer.effect(LatexBuilds, make);
