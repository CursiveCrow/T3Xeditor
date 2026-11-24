import { randomUUID } from "~/lib/utils";
import { useGT } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  AuthTerminalOperateScope,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useEnvironmentScope } from "~/state/session";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  changeFileSaveSession,
  useFileSaveSession,
  type FilePendingListener,
} from "./fileSaveSessions";
import { getUnsavedProjectFileQueryData, setProjectFileQueryData } from "./projectFilesQueryState";
import { LatexSource } from "./LatexSource";
import PdfViewer from "./PdfViewer";

type Engine = "pdflatex" | "xelatex" | "lualatex";
type Point = { path: string; page: number; line: number; y: number };
type Quote = { text: string; location: string };
const button = "rounded border px-2 py-1 hover:bg-muted disabled:opacity-50";
const pendingJumps = new Map<string, number>();
const keyFor = (env: string, cwd: string, file: string) => JSON.stringify([env, cwd, file]);

function buildDiagnostics(log: string, root: string, cwd: string) {
  const entries = new Map<string, { file: string; line: number; text: string }>();
  const rootDirectory = root.replaceAll("\\", "/").replace(/[^/]*$/, "");
  for (const row of log.split(/\r?\n/)) {
    const match = /^(.+?\.tex):(\d+):\s*(.+)$/.exec(row);
    if (!match || /fatal error occurred, no output/i.test(match[3]!)) continue;
    const name = match[1]!.replaceAll("\\", "/").replace(/^\.\//, "");
    const workspace = cwd.replaceAll("\\", "/").replace(/\/$/, "") + "/";
    const file = name.startsWith(workspace) ? name.slice(workspace.length) : rootDirectory + name;
    if (/^(?:[A-Za-z]:|\/)/.test(file) || file.split("/").includes("..")) continue;
    entries.set(row, { file, line: Number(match[2]), text: match[3]! });
  }
  return [...entries.values()].slice(0, 100);
}

export default function LatexWorkbench(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  contents: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  readOnly: boolean;
  onPendingChange: FilePendingListener;
  onOpenFile: (path: string) => void;
  revision: string | null;
}) {
  const gt = useGT();
  const { environmentId, cwd, relativePath, contents } = props;
  const session = { environmentId, cwd, relativePath };
  useFileSaveSession(session, props.onPendingChange);
  const allowed = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const compile = useAtomCommand(projectEnvironment.compileLatex, { reportFailure: false });
  const [live, setLive] = useState(true);
  const [showPdf, setShowPdf] = useState(false);
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({});
  const [preamble, setPreamble] = useState("");
  const [engine, setEngine] = useState<Engine>(() => {
    const hint = /^%\s*!\s*TeX\s+program\s*=\s*(xelatex|lualatex)/im
      .exec(contents)?.[1]
      ?.toLowerCase();
    return hint === "xelatex" || hint === "lualatex" ? hint : "pdflatex";
  });
  const [root, setRoot] = useState(() => {
    const hint = /^%\s*!\s*TeX\s+root\s*=\s*(.+)$/im.exec(contents)?.[1]?.trim();
    return hint ? relativePath.replace(/[^/\\]+$/, "") + hint : relativePath;
  });
  const context = useAtomCommand(projectEnvironment.latexContext, { reportFailure: false });
  const getContext = useEffectEvent(
    async (environmentId: EnvironmentId, cwd: string, root: string, signal: AbortSignal) => {
      const result = await context(
        { environmentId, input: { cwd, relativePath: root } },
        { signal },
      );
      if (signal.aborted || result._tag !== "Success" || !result.value) return;
      setPreamble(result.value.preamble);
      setLabels(result.value.labels ?? {});
      if (result.value.mainFile !== root)
        setRoot((current) => (current === root ? result.value.mainFile : current));
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the selected document's preamble from the workspace for live math macros.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => void getContext(environmentId, cwd, root, controller.signal),
      200,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [environmentId, cwd, root]);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [failed, setFailed] = useState(false);
  const [logRoot, setLogRoot] = useState(root);
  const [settings, setSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [pdfRoot, setPdfRoot] = useState(root);
  const [clip, setClip] = useState(false);
  const [pdf, setPdf] = useState<string | null>(null);
  const [points, setPoints] = useState<readonly Point[]>([]);
  const [citations, setCitations] = useState<readonly { key: string; detail: string }[]>([]);
  const [target, setTarget] = useState<{ line: number } | null>(() => {
    const line = pendingJumps.get(keyFor(environmentId, cwd, relativePath));
    return line ? { line } : null;
  });
  const [position, setPosition] = useState<Point | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [message, setMessage] = useState("");
  const cursor = useRef(1);
  const active = useRef<AbortController | null>(null);
  const lastBuild = useRef("");
  const version = JSON.stringify([contents, root, engine, props.revision]);
  const outline = contents.split("\n").flatMap((row, i) => {
    const match = /^\s*\\(?:part|chapter|(?:sub)*section)\*?(?:\[[^\]]*\])?\{([^}]+)\}/.exec(row);
    return match ? [{ line: i + 1, name: match[1] }] : [];
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release this editor's pending navigation and abort its active RPC on unmount.
  useEffect(() => {
    pendingJumps.delete(keyFor(environmentId, cwd, relativePath));
    return () => {
      active.current?.abort();
    };
  }, [environmentId, cwd, relativePath]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the prior PDF object URL when its viewer is replaced.
  useEffect(
    () => () => {
      if (pdf) URL.revokeObjectURL(pdf);
    },
    [pdf],
  );

  async function build() {
    if (!allowed || active.current || !root.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    lastBuild.current = version;
    setBusy(true);
    setShowPdf(true);
    setMessage(gt("Building PDF…"));
    try {
      for (
        let i = 0;
        i < 50 && getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.signal.throwIfAborted();
      }
      if (getUnsavedProjectFileQueryData(environmentId, cwd, relativePath))
        throw new Error(gt("The source still has unsaved changes. Build again after it saves."));
      const result = await compile(
        { environmentId, input: { cwd, relativePath: root.trim(), engine } },
        { signal: controller.signal },
      );
      controller.signal.throwIfAborted();
      if (result._tag !== "Success")
        throw new Error(
          gt(
            "The workspace could not run the LaTeX build. Check the connection and terminal permission.",
          ),
        );
      const builtRoot = result.value.mainFile ?? root.trim();
      setLogRoot(builtRoot);
      if (builtRoot !== root.trim())
        lastBuild.current = JSON.stringify([contents, builtRoot, engine, props.revision]);
      if (builtRoot !== root.trim()) setRoot((current) => (current === root ? builtRoot : current));
      setFailed(!result.value.pdf);
      setLog(result.value.log);
      if (!result.value.pdf) {
        setMessage(gt("Build failed"));
        setShowLog(false);
        return;
      }
      const bytes = Uint8Array.from(atob(result.value.pdf), (char) => char.charCodeAt(0));
      setPdfRoot(builtRoot);
      setPosition(null);
      setPdf(URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })));
      setPoints(result.value.points);
      setCitations(result.value.citations);
      setQuote(null);
      setMessage(gt("PDF ready"));
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const autoBuild = useEffectEvent(build);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Schedule a single debounced build for the latest source revision.
  useEffect(() => {
    if (!auto || busy || !allowed || lastBuild.current === version) return;
    const timer = setTimeout(() => void autoBuild(), 1000);
    return () => clearTimeout(timer);
  }, [auto, busy, allowed, version]);
  const diagnostics = buildDiagnostics(log, logRoot, cwd);
  const forward = () => {
    const candidates = points.filter((p) => p.path === relativePath.replaceAll("\\", "/"));
    const point = candidates.reduce<Point | undefined>(
      (best, p) =>
        !best || Math.abs(p.line - cursor.current) < Math.abs(best.line - cursor.current)
          ? p
          : best,
      undefined,
    );
    if (point) setPosition({ ...point });
    else setMessage(gt("Build the document to find this source in the PDF."));
  };
  const jump = (file: string, line: number) => {
    if (file === relativePath.replaceAll("\\", "/")) setTarget({ line });
    else {
      pendingJumps.set(keyFor(environmentId, cwd, file), line);
      props.onOpenFile(file);
    }
  };
  async function attachClip(blob: Blob, page: number) {
    setClip(false);
    try {
      const { compressImageToByteLimit, readFileAsDataUrl } =
        await import("~/lib/imageCompression");
      const name = (pdfRoot.split(/[/\\]/).at(-1) ?? "document") + "-page-" + page + ".png";
      const result = await compressImageToByteLimit(
        new File([blob], name, { type: "image/png" }),
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      );
      if (!result.ok) throw new Error(gt("The selected region is too large to attach."));
      const file = result.file;
      const dataUrl = await readFileAsDataUrl(file);
      const image = {
        type: "image" as const,
        id: randomUUID(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: dataUrl,
        file,
      };
      const store = useComposerDraftStore.getState();
      if (!store.addImages(props.composerDraftTarget, [image]).includes(image.id))
        throw new Error(gt("Remove an attachment, then try this capture again."));
      await store.appendPersistedAttachments(
        props.composerDraftTarget,
        [image],
        [
          {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          },
        ],
      );
      setMessage(gt("Selection added to chat draft"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }
  const attach = () => {
    if (!quote) return;
    const store = useComposerDraftStore.getState();
    const prior = store.getComposerDraft(props.composerDraftTarget)?.prompt ?? "";
    store.setPrompt(
      props.composerDraftTarget,
      [
        prior,
        quote.location +
          "\n" +
          quote.text
            .split("\n")
            .map((line) => "> " + line)
            .join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    setMessage(gt("Selection added to chat draft"));
    setQuote(null);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
        <button className={button} aria-pressed={live} onClick={() => setLive(!live)}>
          {gt("Live rendering")}
        </button>
        <button className={button} aria-pressed={showPdf} onClick={() => setShowPdf(!showPdf)}>
          {gt("PDF preview")}
        </button>
        <button
          className={button}
          disabled={busy || !allowed || !root.trim()}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          onClick={() => void build()}
        >
          {gt("Build PDF")}
        </button>
        <label>
          <input
            type="checkbox"
            disabled={!allowed}
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />{" "}
          {gt("Auto-build")}
        </label>
        <button
          className={button + " max-w-52 truncate"}
          aria-expanded={settings}
          onClick={() => setSettings(!settings)}
        >
          {gt("Main file")} {"/"} {root.split(/[/\\]/).at(-1)}
        </button>
        <select
          aria-label={gt("Document outline")}
          className={button + " w-24 min-w-0 truncate"}
          value=""
          onChange={(e) => setTarget({ line: Number(e.target.value) })}
        >
          <option value="">{gt("Outline")}</option>
          {outline.map((s) => (
            <option key={s.line} value={s.line}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          className={button}
          disabled={!points.length}
          onClick={forward}
          aria-keyshortcuts="Control+Shift+J Meta+Shift+J"
        >
          {gt("Go to PDF")}
        </button>
        <button className={button} disabled={!quote} onClick={attach}>
          {gt("Add selection to chat")}
        </button>
        <button
          className={button}
          disabled={!log}
          aria-expanded={showLog}
          onClick={() => setShowLog(!showLog)}
        >
          {gt("Build log")}
        </button>
        {pdf && (
          <button
            className={button}
            aria-pressed={clip}
            onClick={() => {
              setClip(!clip);
              if (!clip) setMessage(gt("Drag over a figure or equation to attach it to chat."));
            }}
          >
            {gt("Clip PDF to chat")}
          </button>
        )}
        {pdf && (
          <a
            className={button}
            href={pdf}
            download={pdfRoot
              .split(/[/\\]/)
              .at(-1)
              ?.replace(/\.tex$/i, ".pdf")}
          >
            {gt("Save PDF")}
          </a>
        )}
        <span role="status">{allowed ? message : gt("Building requires terminal access.")}</span>
      </div>
      {settings && (
        <div className="flex shrink-0 items-center gap-3 border-b p-2 text-xs">
          <select
            aria-label={gt("Typesetting engine")}
            className={button}
            value={engine}
            onChange={(e) => setEngine(e.target.value as Engine)}
          >
            <option value="pdflatex">pdfLaTeX</option>
            <option value="xelatex">XeLaTeX</option>
            <option value="lualatex">LuaLaTeX</option>
          </select>
          <label className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
            {gt("Main file")}{" "}
            <input
              className="w-full min-w-0 rounded border bg-background px-2 py-1"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
            />
          </label>
        </div>
      )}
      <div
        className={
          "grid min-h-0 flex-1 " +
          (showPdf ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]")
        }
      >
        <LatexSource
          live={live}
          preamble={preamble}
          labels={labels}
          contents={contents}
          readOnly={props.readOnly}
          citations={citations}
          target={target}
          onBuild={() => void build()}
          onForward={forward}
          onChange={(value) => {
            setProjectFileQueryData(environmentId, cwd, relativePath, value);
            changeFileSaveSession(session, value);
          }}
          onSelection={(text, line, end) => {
            cursor.current = line;
            setQuote(text ? { text, location: relativePath + " lines " + line + "–" + end } : null);
          }}
        />
        <div
          className={showPdf ? "flex min-h-0 min-w-0 flex-col border-l" : "hidden"}
          aria-label={gt("PDF preview. Double-click a line to show its source.")}
          onPointerUp={(e) => {
            const selection = window.getSelection();
            if (
              !selection?.anchorNode ||
              !selection.focusNode ||
              !e.currentTarget.contains(selection.anchorNode) ||
              !e.currentTarget.contains(selection.focusNode)
            )
              return;
            const text = selection.toString().trim();
            const page = selection.anchorNode.parentElement
              ?.closest("[data-pdf-page]")
              ?.getAttribute("data-pdf-page");
            if (page)
              setQuote(text ? { text, location: pdfRoot + " (PDF page " + page + ")" } : null);
          }}
        >
          {pdf ? (
            <PdfViewer
              src={pdf}
              key={pdf}
              title={pdfRoot}
              positionKey={keyFor(environmentId, cwd, pdfRoot)}
              onClip={clip ? attachClip : undefined}
              sourcePosition={position}
              onSourceJump={(page, y) => {
                const hit = points
                  .filter((p) => p.page === page)
                  .reduce<Point | undefined>(
                    (best, p) => (!best || Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best),
                    undefined,
                  );
                if (hit) jump(hit.path, hit.line);
              }}
            />
          ) : (
            <p className="m-auto p-4 text-center text-sm text-muted-foreground">
              {failed
                ? (diagnostics[0]?.text ?? log.trim().split("\n").find(Boolean) ?? message)
                : busy
                  ? message
                  : gt("Build the main .tex file to preview its PDF.")}
            </p>
          )}
        </div>
      </div>
      {failed && diagnostics.length > 0 && (
        <div
          aria-label={gt("Build errors")}
          className="max-h-24 overflow-auto border-t p-1 text-xs"
        >
          {diagnostics.map((d) => (
            <button
              className="block text-left text-destructive underline"
              key={d.file + d.line + d.text}
              onClick={() => jump(d.file, d.line)}
            >
              {d.file}:{d.line} {d.text}
            </button>
          ))}
        </div>
      )}
      {showLog && (
        <pre tabIndex={0} className="max-h-48 overflow-auto border-t p-2 text-xs select-text">
          {log}
        </pre>
      )}
    </div>
  );
}
