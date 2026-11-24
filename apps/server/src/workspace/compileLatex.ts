// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns native compiler invocation and temporary build files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const flags = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" };
type Point = { path: string; page: number; line: number; y: number };
const inside = (root: string, file: string) => {
  const rel = NodePath.relative(root, file);
  return rel !== ".." && !rel.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(rel);
};

function syncPoints(data: string, root: string, cwd: string): Point[] {
  const files = new Map<string, string>();
  const points = new Map<string, Point>();
  let page = 0;
  let unit = 1;
  let offset = 0;
  let magnification = 1000;
  let previousY = 0;
  for (const row of data.split(/\r?\n/)) {
    if (row.startsWith("Unit:")) unit = Number(row.slice(5));
    if (row.startsWith("Y Offset:")) offset = Number(row.slice(9));
    if (row.startsWith("Magnification:")) magnification = Number(row.slice(14));
    const input = /^Input:(\d+):(.+)$/.exec(row);
    if (input) {
      const file = NodePath.resolve(cwd, input[2]!);
      if (inside(root, file) && /\.tex$/i.test(file))
        files.set(input[1]!, NodePath.relative(root, file).split(NodePath.sep).join("/"));
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
    if (!points.has(key) && points.size < 100000)
      points.set(key, {
        path: file,
        page,
        line: Number(box[2]),
        y: ((previousY * unit + offset) * magnification) / 1000 / 65781.76,
      });
  }
  return [...points.values()];
}

async function runLatexmk(
  args: string[],
  cwd: string,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
) {
  // Some Windows installs expose MiKTeX before a self-contained TeX Live install.
  // Retry a different distribution only when the launcher itself lacks Perl.
  const executable = platform === "win32" ? "latexmk.exe" : "latexmk";
  const tried = new Set<string>();
  let lastFailure: unknown = new Error("Install latexmk on the T3 workspace host to build PDFs.");
  for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter)) {
    if (!NodePath.isAbsolute(directory)) continue;
    const candidate = NodePath.join(directory, executable);
    if (tried.has(candidate) || !(await NodeFSP.stat(candidate).catch(() => null))?.isFile())
      continue;
    tried.add(candidate);
    try {
      return await run(candidate, args, {
        cwd,
        signal,
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PATH: directory + NodePath.delimiter + (process.env.PATH ?? "") },
      });
    } catch (error) {
      lastFailure = error;
      if (!String(error).includes("could not find the script engine 'perl'")) throw error;
    }
  }
  throw lastFailure;
}

// Prefer the nearest project. Archived drafts often reuse chapter and master filenames.
async function findMainFile(workspace: string, chapter: string): Promise<string> {
  const stripComments = (text: string) => text.replace(/(?<!\\)%[^\n]*/g, "");
  const isDocument = (text: string) => /\\(?:documentclass|documentstyle)\s*(?:\[|\{)/.test(text);
  if (isDocument(stripComments(await NodeFSP.readFile(chapter, "utf8")))) return chapter;
  const includes = new Map<string, string[]>();
  const documents = new Set<string>();
  for (let dir = NodePath.dirname(chapter); inside(workspace, dir); dir = NodePath.dirname(dir)) {
    for (const item of await NodeFSP.readdir(dir, { withFileTypes: true })) {
      if (!item.isFile() || !/\.tex$/i.test(item.name)) continue;
      const file = NodePath.join(dir, item.name);
      if ((await NodeFSP.stat(file)).size > 4 * 1024 * 1024) continue;
      const source = stripComments(await NodeFSP.readFile(file, "utf8"));
      if (isDocument(source)) documents.add(file);
      includes.set(
        file,
        [...source.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)]
          .map((match) => match[1]!.trim())
          .filter(Boolean),
      );
    }
    const containsChapter = (main: string) => {
      const seen = new Set<string>();
      const pending = [main];
      while (pending.length) {
        const file = pending.pop()!;
        if (file === chapter) return true;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const name of includes.get(file) ?? []) {
          pending.push(
            NodePath.resolve(NodePath.dirname(main), /\.tex$/i.test(name) ? name : name + ".tex"),
          );
        }
      }
      return false;
    };
    const matches = [...documents].filter(containsChapter);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new Error(
        "Choose a main file: " +
          matches.map((file) => NodePath.relative(workspace, file)).join(", "),
      );
    if (dir === workspace || dir === NodePath.dirname(dir)) break;
  }
  return chapter;
}

export async function latexContext(input: { cwd: string; relativePath: string }) {
  const fallback = { mainFile: input.relativePath, preamble: "" };
  try {
    const root = await NodeFSP.realpath(input.cwd);
    const source = await NodeFSP.realpath(NodePath.resolve(root, input.relativePath));
    if (!inside(root, source) || !/\.tex$/i.test(source)) return fallback;
    const file = await findMainFile(root, source);
    const text = await NodeFSP.readFile(file, "utf8");
    const labels: Record<string, string> = Object.create(null);
    const aux = await NodeFSP.realpath(file.replace(/\.tex$/i, ".aux")).catch(() => null);
    if (aux && inside(root, aux) && (await NodeFSP.stat(aux)).size <= 2 * 1024 * 1024) {
      const data = await NodeFSP.readFile(aux, "utf8");
      for (const match of data.matchAll(/^\\newlabel\{([^}]+)\}\{\{([^{}]*)\}\{([^{}]*)\}/gm)) {
        labels[match[1]!] = match[2]!;
        labels["page:" + match[1]!] = match[3]!;
      }
    }
    return {
      labels,
      mainFile: NodePath.relative(root, file).split(NodePath.sep).join("/"),
      preamble: (text.split(/\\begin\s*\{document\}/, 1)[0] ?? "").slice(0, 128 * 1024),
    };
  } catch {
    return fallback;
  }
}

export async function compileLatex(
  input: { cwd: string; relativePath: string; engine: keyof typeof flags },
  platform: NodeJS.Platform,
  signal?: AbortSignal,
) {
  const empty = { pdf: null, points: [], citations: [] };
  let mainFile = input.relativePath;
  let temp: string | undefined;
  try {
    const root = await NodeFSP.realpath(input.cwd);
    const requested = await NodeFSP.realpath(NodePath.resolve(root, input.relativePath));
    if (
      !inside(root, requested) ||
      !/\.tex$/i.test(requested) ||
      !(await NodeFSP.stat(requested)).isFile()
    )
      throw new Error("Choose a .tex file inside this workspace.");
    const file = await findMainFile(root, requested);
    mainFile = NodePath.relative(root, file).split(NodePath.sep).join("/");
    const cwd = NodePath.dirname(file);
    temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3latex-"));
    const stem = NodePath.parse(file).name;
    // No shell, project .latexmkrc, or TeX shell escape. Never replace a user's PDF.
    const args = [
      "-norc",
      flags[input.engine],
      "-no-shell-escape",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      "-synctex=-1",
      "-outdir=" + temp,
      "./" + NodePath.basename(file),
    ];
    const { stdout, stderr } = await runLatexmk(args, cwd, platform, signal);
    const output = NodePath.join(temp, stem + ".pdf");
    if ((await NodeFSP.stat(output)).size > 12 * 1024 * 1024)
      throw new Error("PDF exceeds the 12 MiB preview limit.");
    const sync = NodePath.join(temp, stem + ".synctex");
    const index = await NodeFSP.stat(sync).catch(() => null);
    const points =
      index && index.size <= 32 * 1024 * 1024
        ? syncPoints(await NodeFSP.readFile(sync, "utf8"), root, cwd)
        : [];
    const aux = await NodeFSP.readFile(NodePath.join(temp, stem + ".aux"), "utf8").catch(() => "");
    const citations = new Map<string, string>();
    const bibliography = new Set<string>();
    const tex = await NodeFSP.readFile(file, "utf8");
    for (const match of tex.matchAll(/^[^%\n]*?\\addbibresource(?:\[[^\]]*\])?\{([^}]+)\}/gm))
      bibliography.add(match[1]!);
    for (const match of aux.matchAll(/\\bibdata\{([^}]+)\}/g)) {
      for (const name of match[1]!.split(",")) {
        bibliography.add(name.trim() + ".bib");
      }
    }
    for (const name of bibliography) {
      const bib = await NodeFSP.realpath(NodePath.resolve(cwd, name)).catch(() => "");
      if (!bib || !inside(root, bib) || (await NodeFSP.stat(bib)).size > 4 * 1024 * 1024) continue;
      const entries = await NodeFSP.readFile(bib, "utf8");
      for (const entry of entries.matchAll(/@\w+\s*[{(]\s*([^\s,]+),([\s\S]*?)(?=\n\s*@|$)/g)) {
        const key = entry[1]!;
        const fields = [...entry[2]!.matchAll(/\b(?:author|title)\s*=\s*[{"]([^\n"]+)/gi)]
          .map((field) => field[1]!.replace(/[{},]+$/g, "").trim())
          .join(" ? ");
        citations.set(key, fields.slice(0, 300));
      }
    }
    return {
      mainFile,
      pdf: (await NodeFSP.readFile(output)).toString("base64"),
      points,
      citations: [...citations].slice(0, 5000).map(([key, detail]) => ({ key, detail })),
      log: (stdout + stderr).slice(-32000),
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return {
      ...empty,
      mainFile,
      log: [failure.stdout, failure.stderr, failure.message]
        .filter(Boolean)
        .join("\n")
        .slice(-32000),
    };
  } finally {
    if (temp)
      await NodeFSP.rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
