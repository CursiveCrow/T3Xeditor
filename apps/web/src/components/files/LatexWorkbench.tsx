import {
  AuthTerminalOperateScope,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectCompileLatexError,
  type EnvironmentId,
  type ProjectCompileLatexResult,
  type ProjectLatexEngine,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import {
  CropIcon,
  DownloadIcon,
  EyeIcon,
  ListTreeIcon,
  LocateFixedIcon,
  MessageSquareQuoteIcon,
  PanelRightIcon,
  PlayIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  Settings2Icon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { isMacPlatform, randomUUID } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  changeFileSaveSession,
  useFileSaveSession,
  type FilePendingListener,
} from "./fileSaveSessions";
import { FileSurfaceAction } from "./fileSurfaceChrome";
import type { FigureImages } from "./latexDocument";
import { LatexSource } from "./LatexSource";
import { argument, skipSpace, type Labels } from "./latexSyntax";
import PdfViewer from "./PdfViewer";
import { getUnsavedProjectFileQueryData, setProjectFileQueryData } from "./projectFilesQueryState";

type Point = ProjectCompileLatexResult["points"][number];
type Quote = { text: string; location: string };
type Choice = { engine: ProjectLatexEngine; root: string };
type Output = {
  url: string;
  root: string;
  points: readonly Point[];
  citations: ProjectCompileLatexResult["citations"];
};
type Report = { root: string; log: string; failed: boolean };

const engines = [
  { value: "pdflatex", label: "pdfLaTeX" },
  { value: "xelatex", label: "XeLaTeX" },
  { value: "lualatex", label: "LuaLaTeX" },
] as const;
const isCompileError = Schema.is(ProjectCompileLatexError);
const keyFor = (env: string, cwd: string, file: string) => JSON.stringify([env, cwd, file]);
const pendingJumps = new Map<string, number>();
const choices = new Map<string, Choice>();
// One PDF per main file. Its chapters share the build, and a tab switch keeps the preview.
const outputs = new Map<string, Output>();

function keepOutput(key: string, output: Output) {
  const replaced = outputs.get(key);
  outputs.delete(key);
  outputs.set(key, output);
  if (replaced) URL.revokeObjectURL(replaced.url);
  for (const [oldest, stale] of outputs) {
    if (outputs.size <= 4) break;
    outputs.delete(oldest);
    URL.revokeObjectURL(stale.url);
  }
}

function initialChoice(key: string, contents: string, relativePath: string): Choice {
  const kept = choices.get(key);
  if (kept) return kept;
  const program = /^%\s*!\s*TeX\s+program\s*=\s*(xelatex|lualatex)/im
    .exec(contents)?.[1]
    ?.toLowerCase();
  const hint = /^%\s*!\s*TeX\s+root\s*=\s*(.+)$/im.exec(contents)?.[1]?.trim();
  return {
    engine: program === "xelatex" || program === "lualatex" ? program : "pdflatex",
    root: hint ? relativePath.replace(/[^/\\]+$/, "") + hint : relativePath,
  };
}

function nearest<T>(items: readonly T[], distance: (item: T) => number) {
  return items.reduce<T | undefined>(
    (best, item) => (best === undefined || distance(item) < distance(best) ? item : best),
    undefined,
  );
}

function buildDiagnostics(report: Report, cwd: string) {
  const entries = new Map<string, { file: string; line: number; text: string }>();
  const rootDirectory = report.root.replaceAll("\\", "/").replace(/[^/]*$/, "");
  for (const row of report.log.split(/\r?\n/)) {
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

function Outline(props: { contents: string; onJump: (line: number) => void }) {
  const gt = useGT();
  const sections = props.contents.split("\n").flatMap((row, i) => {
    const match = /^\s*\\(part|chapter|(?:sub)*section)\*?\s*/.exec(row);
    if (!match) return [];
    const short = argument(row, match[0].length, true);
    const body = short ?? argument(row, skipSpace(row, match[0].length));
    if (!body) return [];
    const name = body.value;
    let plain = "",
      last = 0;
    for (const part of name.matchAll(/\\texorpdfstring\s*\{/g)) {
      const tex = argument(name, part.index + part[0].length - 1);
      const bookmark = tex && argument(name, skipSpace(name, tex.end));
      if (!bookmark || part.index < last) continue;
      plain += name.slice(last, part.index) + bookmark.value;
      last = bookmark.end;
    }
    return [
      { line: i + 1, name: plain + name.slice(last), depth: match[1]!.split("sub").length - 1 },
    ];
  });
  if (!sections.length) return <MenuItem disabled>{gt("No sections yet")}</MenuItem>;
  return sections.map((section) => (
    <MenuItem key={section.line} onClick={() => props.onJump(section.line)}>
      <span className={section.depth > 1 ? "ps-6" : section.depth === 1 ? "ps-3" : undefined}>
        {section.name}
      </span>
    </MenuItem>
  ));
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
  const file = relativePath.replaceAll("\\", "/");
  const fileKey = keyFor(environmentId, cwd, relativePath);
  useFileSaveSession(session, props.onPendingChange);
  const allowed = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const compile = useAtomCommand(projectEnvironment.compileLatex, { reportFailure: false });
  const readContext = useAtomCommand(projectEnvironment.latexContext, { reportFailure: false });
  const [live, setLive] = useLocalStorage("t3code.latexLiveRendering", true, Schema.Boolean);
  const [showPdf, setShowPdf] = useLocalStorage("t3code.latexPdfPreview", false, Schema.Boolean);
  const [auto, setAuto] = useLocalStorage("t3code.latexAutoBuild", false, Schema.Boolean);
  const [choice, setChoice] = useState(() => initialChoice(fileKey, contents, relativePath));
  const { engine } = choice;
  const root = choice.root.trim();
  const choose = (next: Choice) => {
    choices.set(fileKey, next);
    setChoice(next);
  };
  const [context, setContext] = useState<{ preamble: string; labels: Labels }>({
    preamble: "",
    labels: {},
  });
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<Output | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [candidates, setCandidates] = useState<readonly string[]>([]);
  const [figures, setFigures] = useState<FigureImages>();
  const [showLog, setShowLog] = useState(false);
  const [clip, setClip] = useState(false);
  const [target, setTarget] = useState<{ line: number } | null>(() => {
    const line = pendingJumps.get(fileKey);
    return line ? { line } : null;
  });
  const [position, setPosition] = useState<Point | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [message, setMessage] = useState("");
  const cursor = useRef(1);
  const active = useRef<AbortController | null>(null);
  const lastBuild = useRef<readonly unknown[]>([]);
  const output = built ?? outputs.get(keyFor(environmentId, cwd, root)) ?? null;
  const shortcut = (key: string) => (isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+") + key;

  const adoptRoot = (requested: string, mainFile: string) => {
    if (mainFile === requested) return;
    setChoice((current) => {
      if (current.root.trim() !== requested) return current;
      const next = { ...current, root: mainFile };
      choices.set(fileKey, next);
      return next;
    });
  };
  const loadContext = useEffectEvent(async (requested: string, signal: AbortSignal) => {
    const result = await readContext(
      { environmentId, input: { cwd, relativePath: requested } },
      { signal },
    );
    if (signal.aborted || result._tag !== "Success") return;
    setContext({ preamble: result.value.preamble, labels: result.value.labels });
    adoptRoot(requested, result.value.mainFile);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the main document's preamble and labels from the workspace for live typesetting.
  useEffect(() => {
    if (!root) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void loadContext(root, controller.signal), 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [root]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release this editor's pending navigation and abort its active RPC on unmount.
  useEffect(() => {
    pendingJumps.delete(fileKey);
    return () => active.current?.abort();
  }, [fileKey]);

  async function build(reveal = true) {
    if (!allowed || active.current || !root) return;
    const controller = new AbortController();
    const finish = (text: string) => {
      active.current = null;
      setBusy(false);
      setMessage(text);
    };
    active.current = controller;
    lastBuild.current = [contents, root, engine, props.revision];
    setBusy(true);
    setCandidates([]);
    if (reveal) setShowPdf(true);
    // The compiler reads the saved file, so let a pending save land first.
    for (
      let i = 0;
      i < 50 && getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (controller.signal.aborted) return finish(gt("Build stopped"));
    }
    if (getUnsavedProjectFileQueryData(environmentId, cwd, relativePath))
      return finish(gt("The source still has unsaved changes. Build again after it saves."));
    const result = await compile(
      { environmentId, input: { cwd, relativePath: root, figurePath: relativePath, engine } },
      { signal: controller.signal },
    );
    if (controller.signal.aborted) return finish(gt("Build stopped"));
    if (result._tag !== "Success") {
      const failure = Cause.squash(result.cause);
      const reason = isCompileError(failure) ? failure.reason : "operation_failed";
      if (isCompileError(failure)) setCandidates(failure.candidates ?? []);
      return finish(
        reason === "compiler_not_installed"
          ? gt("latexmk is not installed on this workspace's machine.")
          : reason === "invalid_main_file"
            ? gt("Choose a .tex file in this workspace as the main file.")
            : reason === "ambiguous_main_file"
              ? gt("More than one document includes this file. Choose the main file.")
              : reason === "timed_out"
                ? gt("The build did not finish within 90 seconds.")
                : reason === "pdf_too_large"
                  ? gt("The PDF is larger than the 12 MiB preview limit.")
                  : gt(
                      "The workspace could not run the LaTeX build. Check the connection and terminal permission.",
                    ),
      );
    }
    const { value } = result;
    adoptRoot(root, value.mainFile);
    if (value.mainFile !== root)
      lastBuild.current = [contents, value.mainFile, engine, props.revision];
    setReport({ root: value.mainFile, log: value.log, failed: value.pdf === null });
    if (value.pdf === null) {
      setShowLog(false);
      return finish(gt("Build failed"));
    }
    const bytes = Uint8Array.from(atob(value.pdf), (char) => char.charCodeAt(0));
    const next: Output = {
      url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })),
      root: value.mainFile,
      points: value.points,
      citations: value.citations,
    };
    keepOutput(keyFor(environmentId, cwd, value.mainFile), next);
    setBuilt(next);
    setContext((current) => ({ ...current, labels: value.labels }));
    setPosition(null);
    if (value.figureSourceHash && (value.figures.length || value.symbolSheet)) {
      const { cropFigures } = await import("./latexFigureCrops");
      const images = await cropFigures(
        bytes.buffer,
        contents,
        value.figureSourceHash,
        value.figures,
        controller.signal,
        value.symbolSheet,
      ).catch(() => undefined);
      if (images && !controller.signal.aborted) setFigures(images);
    }
    finish(gt("PDF ready"));
  }
  const autoBuild = useEffectEvent(() => void build(false));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Schedule a single debounced build for the latest source revision.
  useEffect(() => {
    const [text, main, program, revision] = lastBuild.current;
    const current =
      text === contents && main === root && program === engine && revision === props.revision;
    if (!auto || busy || !allowed || current) return;
    const timer = setTimeout(() => autoBuild(), 1000);
    return () => clearTimeout(timer);
  }, [auto, busy, allowed, contents, root, engine, props.revision]);

  const diagnostics = report?.failed ? buildDiagnostics(report, cwd) : [];
  const forward = () => {
    const point = nearest(output?.points.filter((p) => p.path === file) ?? [], (p) =>
      Math.abs(p.line - cursor.current),
    );
    if (!point) return setMessage(gt("Build the document to find this source in the PDF."));
    setShowPdf(true);
    setPosition({ ...point });
  };
  const jump = (path: string, line: number) => {
    if (path === file) return setTarget({ line });
    pendingJumps.set(keyFor(environmentId, cwd, path), line);
    props.onOpenFile(path);
  };
  async function attachClip(blob: Blob, page: number) {
    setClip(false);
    const { compressImageToByteLimit, readFileAsDataUrl } = await import("~/lib/imageCompression");
    const name = (output?.root.split(/[/\\]/).at(-1) ?? "document") + "-page-" + page + ".png";
    const result = await compressImageToByteLimit(
      new File([blob], name, { type: "image/png" }),
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    );
    if (!result.ok) return setMessage(gt("The selected region is too large to attach."));
    const dataUrl = await readFileAsDataUrl(result.file);
    const image = {
      type: "image" as const,
      id: randomUUID(),
      name: result.file.name,
      mimeType: result.file.type,
      sizeBytes: result.file.size,
      previewUrl: dataUrl,
      file: result.file,
    };
    const store = useComposerDraftStore.getState();
    if (!store.addImages(props.composerDraftTarget, [image]).includes(image.id))
      return setMessage(gt("Remove an attachment, then try this capture again."));
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
  }
  const attach = () => {
    if (!quote) return;
    const store = useComposerDraftStore.getState();
    const prior = store.getComposerDraft(props.composerDraftTarget)?.prompt ?? "";
    const quoted = quote.text
      .split("\n")
      .map((line) => "> " + line)
      .join("\n");
    store.setPrompt(
      props.composerDraftTarget,
      [prior, quote.location + "\n" + quoted].filter(Boolean).join("\n\n"),
    );
    setMessage(gt("Selection added to chat draft"));
    setQuote(null);
  };
  const status = !allowed
    ? gt("Building requires terminal access.")
    : busy
      ? gt("Building PDF…")
      : message;

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1 text-xs">
        {busy ? (
          <Button size="xs" variant="outline" onClick={() => active.current?.abort()}>
            <SquareIcon />
            {gt("Stop", { $context: "button that cancels the running PDF build" })}
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!allowed || !root}
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  onClick={() => void build()}
                />
              }
            >
              <PlayIcon />
              {gt("Build PDF")}
            </TooltipTrigger>
            <TooltipPopup>{shortcut("Enter")}</TooltipPopup>
          </Tooltip>
        )}
        <FileSurfaceAction
          label={gt("Auto-build")}
          pressed={auto}
          disabled={!allowed}
          onPress={() => setAuto(!auto)}
        >
          <RefreshCwIcon className="size-3.5" />
        </FileSurfaceAction>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={<Button size="icon-sm" variant="ghost" aria-label={gt("Outline")} />}
                />
              }
            >
              <ListTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>{gt("Outline")}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="start">
            <Outline contents={contents} onJump={(line) => setTarget({ line })} />
          </MenuPopup>
        </Menu>
        <Popover>
          <PopoverTrigger
            render={<Button size="xs" variant="ghost" aria-label={gt("Main file and engine")} />}
          >
            <Settings2Icon />
            <span className="max-w-40 truncate">{root.split(/[/\\]/).at(-1)}</span>
          </PopoverTrigger>
          <PopoverPopup align="start" width="md">
            <div className="flex flex-col gap-3">
              {/* oxlint-disable-next-line t3code/no-untranslated-copy -- Read the split wordmark as one product name. */}
              <PopoverTitle aria-label="T3Xeditor">
                <span data-latex-wordmark="" translate="no">
                  {/* oxlint-disable-next-line t3code/no-untranslated-copy -- The wordmark uses the same lettering in every locale. */}
                  T<span>3</span>Xeditor
                </span>
              </PopoverTitle>
              <Label className="flex-col items-stretch">
                {gt("Main file")}
                <Input
                  size="compact"
                  value={choice.root}
                  onChange={(event) => choose({ ...choice, root: event.target.value })}
                />
              </Label>
              {candidates.length > 0 && (
                <div className="flex flex-col items-start gap-1">
                  {candidates.map((candidate) => (
                    <Button
                      key={candidate}
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setCandidates([]);
                        setMessage("");
                        choose({ ...choice, root: candidate });
                      }}
                    >
                      {candidate}
                    </Button>
                  ))}
                </div>
              )}
              <Label className="flex-col items-stretch">
                {gt("Typesetting engine")}
                <Select
                  value={engine}
                  items={engines}
                  onValueChange={(value) => {
                    if (value) choose({ ...choice, engine: value });
                  }}
                >
                  <SelectTrigger size="compact" aria-label={gt("Typesetting engine")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {engines.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Label>
            </div>
          </PopoverPopup>
        </Popover>
        <span
          role="status"
          className={
            "ms-auto flex min-w-0 items-center gap-1.5 px-1 " +
            (report?.failed && !busy ? "text-destructive-foreground" : "text-muted-foreground")
          }
        >
          {busy && allowed && <Spinner size="sm" />}
          <span className="truncate">{status}</span>
        </span>
        <FileSurfaceAction
          label={gt("Live rendering")}
          pressed={live}
          onPress={() => setLive(!live)}
        >
          <EyeIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("PDF preview")}
          pressed={showPdf}
          onPress={() => setShowPdf(!showPdf)}
        >
          <PanelRightIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("Go to PDF ({shortcut})", { shortcut: shortcut("Shift+J") })}
          disabled={!output?.points.length}
          onPress={forward}
        >
          <LocateFixedIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction label={gt("Add selection to chat")} disabled={!quote} onPress={attach}>
          <MessageSquareQuoteIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("Build log")}
          pressed={showLog}
          disabled={!report}
          onPress={() => setShowLog(!showLog)}
        >
          <ScrollTextIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      <div
        className={
          "grid min-h-0 flex-1 " +
          (showPdf ? "grid-rows-2 @3xl:grid-cols-2 @3xl:grid-rows-1" : "grid-cols-[minmax(0,1fr)]")
        }
      >
        <LatexSource
          placeKey={fileKey}
          live={live}
          preamble={context.preamble}
          labels={context.labels}
          figures={figures}
          contents={contents}
          readOnly={props.readOnly}
          citations={output?.citations ?? []}
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
        {showPdf && (
          <div
            className="flex min-h-0 min-w-0 flex-col border-t @3xl:border-t-0 @3xl:border-l"
            aria-label={gt("PDF preview. Double-click a line to show its source.")}
            onPointerUp={(event) => {
              const selection = window.getSelection();
              if (
                !selection?.anchorNode ||
                !selection.focusNode ||
                !event.currentTarget.contains(selection.anchorNode) ||
                !event.currentTarget.contains(selection.focusNode)
              )
                return;
              const text = selection.toString().trim();
              const page = selection.anchorNode.parentElement
                ?.closest("[data-pdf-page]")
                ?.getAttribute("data-pdf-page");
              if (page && output)
                setQuote(
                  text ? { text, location: output.root + " (PDF page " + page + ")" } : null,
                );
            }}
          >
            {output ? (
              <PdfViewer
                src={output.url}
                key={output.url}
                title={output.root}
                positionKey={keyFor(environmentId, cwd, output.root)}
                onClip={clip ? attachClip : undefined}
                sourcePosition={position}
                onSourceJump={(page, y) => {
                  const hit = nearest(
                    output.points.filter((p) => p.page === page),
                    (p) => Math.abs(p.y - y),
                  );
                  if (hit) jump(hit.path, hit.line);
                }}
                actions={
                  <>
                    <FileSurfaceAction
                      label={gt("Clip PDF to chat")}
                      pressed={clip}
                      onPress={() => {
                        setClip(!clip);
                        if (!clip)
                          setMessage(gt("Drag over a figure or equation to attach it to chat."));
                      }}
                    >
                      <CropIcon className="size-3.5" />
                    </FileSurfaceAction>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={gt("Save PDF")}
                            render={
                              <a
                                href={output.url}
                                download={output.root
                                  .split(/[/\\]/)
                                  .at(-1)
                                  ?.replace(/\.tex$/i, ".pdf")}
                              />
                            }
                          />
                        }
                      >
                        <DownloadIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup>{gt("Save PDF")}</TooltipPopup>
                    </Tooltip>
                  </>
                }
              />
            ) : (
              <p className="m-auto flex items-center gap-2 p-4 text-center text-sm text-muted-foreground">
                {busy && <Spinner size="md" />}
                {busy
                  ? gt("Building PDF…")
                  : report?.failed
                    ? (diagnostics[0]?.text ??
                      report.log.trim().split("\n").find(Boolean) ??
                      message)
                    : message || gt("Build the main .tex file to preview its PDF.")}
              </p>
            )}
          </div>
        )}
      </div>
      {diagnostics.length > 0 && (
        <div
          aria-label={gt("Build errors")}
          className="max-h-28 shrink-0 overflow-auto border-t border-border/60 py-1 text-xs"
        >
          {diagnostics.map((d) => (
            <button
              type="button"
              className="flex w-full gap-2 px-3 py-0.5 text-left hover:bg-accent"
              key={d.file + d.line + d.text}
              onClick={() => jump(d.file, d.line)}
            >
              <span className="shrink-0 font-mono text-muted-foreground">
                {d.file}:{d.line}
              </span>
              <span className="text-destructive-foreground">{d.text}</span>
            </button>
          ))}
        </div>
      )}
      {showLog && report && (
        <pre
          tabIndex={0}
          className="max-h-48 shrink-0 overflow-auto border-t border-border/60 p-2 font-mono text-xs select-text"
        >
          {report.log}
        </pre>
      )}
    </div>
  );
}
