import {
  alignmentParts,
  argument,
  endOfLine,
  inlineAt,
  inlinePattern,
  mathEnd,
  skipSpace,
  type Inline,
  type Labels,
} from "./latexSyntax";

export type FigureImage = {
  url: string;
  width: number;
  height: number;
  baseline?: { depth: number; em: number };
};
export type FigureImages = ReadonlyMap<string, FigureImage>;
export type Token = {
  from: number;
  to: number;
  kind:
    | Inline["kind"]
    | "preamble"
    | "title"
    | "abstract"
    | "section"
    | "subsection"
    | "theorem"
    | "marker"
    | "display"
    | "figure"
    | "table"
    | "caption";
  value: string;
  image?: FigureImage;
  offset?: number;
  prefix?: string;
  spec?: string;
};
export type PaperLine = {
  from: number;
  indent: number;
  abstract: boolean;
  item: boolean;
  blank: boolean;
  paragraph: boolean;
  italic: boolean;
};
export type TitleField = { value: string; start: number; end: number };
/** A line break TeX reads as a space, within the paragraph spanning `first` to `last`. */
export type Join = { from: number; to: number; tight: boolean; first: number; last: number };
export type Paper = ReturnType<typeof scanPaper>;
type Row = {
  from: number;
  start: number;
  end: number;
  blank: boolean;
  opens: boolean;
  continues: boolean;
  tight: boolean;
};

// These set their own block, so text beside them keeps the source's line break.
const blocks = new Set<Token["kind"]>([
  "display",
  "table",
  "figure",
  "caption",
  "title",
  "section",
  "subsection",
]);

// Consecutive lines of prose are one paragraph. A lone unknown command, a block, verbatim text
// and an environment this editor does not typeset keep their own lines.
function paragraphJoins(
  source: string,
  rows: readonly Row[],
  tokens: readonly Token[],
  opaque: [number, number][],
) {
  const endingAfter = (pos: number) => {
    let low = 0,
      high = tokens.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tokens[mid]!.to > pos) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const flows = rows.map((row) => {
    if (row.blank) return false;
    let typeset = false;
    for (let i = endingAfter(row.from); i < tokens.length && tokens[i]!.from < row.end; i++) {
      const token = tokens[i]!;
      if (blocks.has(token.kind)) return false;
      if (token.kind === "hidden" && token.from <= row.from && token.to >= row.end) return false;
      if (token.from <= row.start && row.start < token.to) typeset = true;
    }
    const text = source.slice(row.start, row.end);
    return typeset || !/^\\[a-zA-Z@]+\*?(?:\s*(?:\[[^\]]*\]|\{[^{}]*\}))*\s*$/.test(text);
  });
  opaque.sort((a, b) => a[0] - b[0]);
  const joins: Join[] = [];
  let skipped = 0,
    settled = 0,
    opened = -1;
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i]!,
      next = rows[i + 1]!;
    while (skipped < opaque.length && opaque[skipped]![1] <= row.end) skipped++;
    const covering = tokens[endingAfter(row.end)];
    const joined =
      row.opens &&
      next.continues &&
      flows[i] &&
      flows[i + 1] &&
      !(skipped < opaque.length && opaque[skipped]![0] <= row.end) &&
      !(covering && covering.from < next.start);
    if (joined) {
      if (opened < 0) opened = i;
      joins.push({ from: row.end, to: next.start, tight: row.tight, first: 0, last: 0 });
    }
    if (opened >= 0 && (!joined || i + 2 === rows.length)) {
      const last = joined ? i + 1 : i;
      // The caret on the blank line that ends a paragraph is still writing that paragraph.
      const reach = rows[last]!.end + (rows[last + 1]?.blank ? 1 : 0);
      for (; settled < joins.length; settled++) {
        joins[settled]!.first = rows[opened]!.from;
        joins[settled]!.last = reach;
      }
      opened = -1;
    }
  }
  return joins;
}

// Standard xcolor names differ from CSS (notably green, lime and purple).
const texColors: Readonly<Record<string, string>> = {
  black: "000000",
  white: "ffffff",
  red: "ff0000",
  green: "00ff00",
  blue: "0000ff",
  cyan: "00ffff",
  magenta: "ff00ff",
  yellow: "ffff00",
  gray: "808080",
  lightgray: "bfbfbf",
  darkgray: "404040",
  brown: "bf8040",
  lime: "bfff00",
  orange: "ff8000",
  pink: "ffbfbf",
  purple: "bf0040",
  teal: "008080",
  violet: "800080",
  olive: "808000",
};

function referenceColor(clean: string) {
  let enabled = false;
  let color = "red";
  const names = new Map(Object.entries(texColors));
  // Read the keys in document order so a later hypersetup can override package options.
  const commands =
    /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}|\\hypersetup\s*(?=\{)|\\definecolor\s*\{([\w-]+)\}\s*\{HTML\}\s*\{([\da-fA-F]{6})\}/g;
  for (let m; (m = commands.exec(clean));) {
    if (m[3] && m[4]) {
      names.set(m[3], m[4]);
      continue;
    }
    if (m[2] !== undefined && !m[2].split(",").some((name) => name.trim() === "hyperref")) continue;
    const group = m[2] === undefined ? argument(clean, commands.lastIndex) : undefined;
    if (group) commands.lastIndex = group.end;
    for (const option of (group?.value ?? m[1] ?? "").split(",")) {
      const [key, raw] = option.trim().split(/\s*=\s*/);
      const value = raw?.replace(/^\{(.*)\}$/, "$1").trim();
      if (key === "colorlinks") enabled = value === undefined || value === "true";
      if (key === "hidelinks") enabled = false;
      if ((key === "linkcolor" || key === "allcolors") && value) color = value;
    }
  }
  if (!enabled) return "inherit";
  const [first, ...mixes] = color.split("!");
  const initial = names.get(first!);
  if (!initial) return "inherit";
  const channels = (hex: string) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  let rgb = channels(initial);
  for (let i = 0; i < mixes.length; i += 2) {
    const percent = Number(mixes[i]);
    const next = names.get(mixes[i + 1] || "white");
    if (!next || !Number.isFinite(percent) || percent < 0 || percent > 100) return "inherit";
    const weight = percent / 100;
    rgb = channels(next).map((n, j) => rgb[j]! * weight + n * (1 - weight));
  }
  return `rgb(${rgb.map(Math.round).join(",")})`;
}

function declarations(preamble: string) {
  // Keep offsets identical to the editable document while masking commented declarations.
  const clean = preamble.replace(/\\.|%[^\n]*/g, (m) =>
    m.startsWith("%") ? " ".repeat(m.length) : m,
  );
  const titles: TitleField[] = [];
  for (const name of ["title", "author", "date"]) {
    const commands = clean.matchAll(new RegExp("\\\\" + name + "\\s*\\{", "g"));
    const m = Array.from(commands).at(-1);
    const body = m && argument(preamble, m.index + m[0].length - 1);
    if (body?.value.trim()) titles.push(body);
  }
  const theorems = new Map<
    string,
    { title: string; counter: string; within: string | undefined; starred: boolean; style: string }
  >();
  let style = "plain";
  for (const m of clean.matchAll(
    /\\newtheorem(\*)?\s*\{([\w@]+)\}\s*(?:\[([\w@]+)\]\s*)?\{([^{}]+)\}(?:\[([\w@]+)\])?|\\theoremstyle\s*\{(definition|plain|remark)\}/g,
  )) {
    if (m[6]) {
      style = m[6];
      continue;
    }
    theorems.set(m[2]!, {
      title: m[4]!,
      counter: m[3] ?? m[2]!,
      within: m[5],
      starred: !!m[1],
      style,
    });
  }
  return { titles, theorems, linkColor: referenceColor(clean) };
}

function listLabel(template: string, n: number) {
  return template.replace(/\\(arabic|alph|Alph|roman|Roman)\*/g, (_, format: string) => {
    if (format === "arabic") return String(n);
    if (/alph/i.test(format))
      return n < 1 || n > 26 ? String(n) : String.fromCharCode((format === "alph" ? 96 : 64) + n);
    if (n < 1 || n > 3999) return String(n);
    let value = "",
      remaining = n;
    for (const [amount, symbol] of [
      [1000, "m"],
      [900, "cm"],
      [500, "d"],
      [400, "cd"],
      [100, "c"],
      [90, "xc"],
      [50, "l"],
      [40, "xl"],
      [10, "x"],
      [9, "ix"],
      [5, "v"],
      [4, "iv"],
      [1, "i"],
    ] as const) {
      value += symbol.repeat(Math.floor(Math.max(0, remaining) / amount));
      remaining %= amount;
    }
    return format === "Roman" ? value.toUpperCase() : value;
  });
}

export function scanPaper(source: string, inherited: string, aux: Labels, figures?: FigureImages) {
  const start = /^[ \t]*\\begin\s*\{document\}/m.exec(source);
  const preamble = start ? source.slice(0, start.index) : inherited;
  const { titles, theorems, linkColor } = declarations(preamble);
  const labels: Record<string, string> = Object.assign(Object.create(null), aux);
  const localDefinitions: string[] = [];
  const tokens: Token[] = [];
  const lines: PaperLine[] = [];
  const rows: Row[] = [];
  const unknown: { name: string; from: number }[] = [];
  const opaque: [number, number][] = [];
  const counters = new Map<string, number>();
  const lists: { next: number; template: string; margin: number }[] = [];
  const theoremStyles: string[] = [];
  let previousWasBlank = false,
    previousWasProse = false,
    abstract = false,
    captionType = "",
    currentNumber = "",
    lineStart = 0;
  const pattern = inlinePattern();
  function add(
    from: number,
    to: number,
    kind: Token["kind"],
    value = "",
    extra: Partial<Token> = {},
  ) {
    tokens.push({ from, to, kind, value, ...extra });
    pattern.lastIndex = to;
  }
  function hidden(from: number, to: number) {
    const previous = tokens.at(-1);
    if (previous?.kind === "hidden" && /^[ \t]*$/.test(source.slice(previous.to, from))) {
      from = previous.from;
      tokens.pop();
    }
    const line = source.lastIndexOf("\n", from - 1);
    const end = endOfLine(source, to);
    if (
      !source.slice(line + 1, from).trim() &&
      !source.slice(to, end).trim() &&
      line >= 0 &&
      line >= (tokens.at(-1)?.to ?? 0)
    ) {
      from = line;
      to = end;
    }
    add(from, to, "hidden");
  }
  function linesThrough(pos: number) {
    while (lineStart <= pos && lineStart < source.length) {
      const end = endOfLine(source, lineStart);
      const text = source.slice(lineStart, end).trimStart();
      const blank = !text;
      const item = /^\\item\b/.test(text);
      const prose =
        !!text &&
        !/^(?:%|\\(?:begin|end|(?:sub)*section|label|maketitle|vspace|medskip|item)\b)/.test(text);
      const paragraph =
        previousWasBlank &&
        previousWasProse &&
        prose &&
        !text.startsWith("\\noindent") &&
        !lists.length;
      const italic = theoremStyles.at(-1) === "plain";
      rows.push({
        from: lineStart,
        start: end - text.length,
        end,
        blank,
        opens: prose || item,
        continues: prose,
        // After a forced break or a comment, TeX drops the line break instead of spacing it.
        tight: /\\\\(?:\[[^\]]*\])?\s*$|(?<!\\)%/.test(text),
      });
      if (abstract || lists.length || blank || paragraph || italic)
        lines.push({
          from: lineStart,
          abstract,
          indent: lists.reduce((total, list) => total + list.margin, 0),
          item,
          blank,
          paragraph,
          italic,
        });
      if (!blank && !text.startsWith("%") && !text.startsWith("\\label")) previousWasProse = prose;
      previousWasBlank = blank;
      lineStart = end + 1;
    }
  }
  function number(counter: string, within?: string) {
    const n = (counters.get(counter) ?? 0) + 1;
    counters.set(counter, n);
    const parent = within ? counters.get(within) : undefined;
    return parent ? `${parent}.${n}` : String(n);
  }
  function documentNumber(computed: string, end: number) {
    const next = /\s*\\label\{([^}]+)\}/y;
    next.lastIndex = end;
    const key = next.exec(source)?.[1];
    currentNumber = (!start && key && aux[key]) || computed;
    return currentNumber;
  }
  if (start) {
    let end = start.index + start[0].length;
    if (source[end] === "\n") end++;
    add(0, end, "preamble");
    lineStart = end;
  }
  for (let m; (m = pattern.exec(source));) {
    const command = m[0],
      from = m.index,
      after = pattern.lastIndex;
    linesThrough(from);
    if (
      /^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator)\*?$/.test(
        command,
      )
    ) {
      const name = argument(source, skipSpace(source, after));
      if (name) {
        const arity = argument(source, skipSpace(source, name.end), true);
        const definition = argument(source, skipSpace(source, arity?.end ?? name.end));
        if (definition) {
          localDefinitions.push(source.slice(from, definition.end));
          hidden(from, definition.end);
          continue;
        }
      }
    }
    if (command === "\\maketitle" && titles.length) {
      add(from, after, "title");
      continue;
    }
    if (command === "\\def" && source.startsWith("\\@captype{", after)) {
      const type = argument(source, after + 9);
      if (type) {
        captionType = type.value;
        hidden(from, type.end);
        continue;
      }
    }
    const isEnv = command === "\\begin" || command === "\\end";
    const isHeading = /^\\(?:part|chapter|section|subsection|subsubsection)\*?$/.test(command);
    if (isHeading || command === "\\caption" || isEnv) {
      let at = skipSpace(source, after);
      const short = !isEnv && argument(source, at, true);
      if (short) at = skipSpace(source, short.end);
      const body = argument(source, at);
      if (!body) continue;
      const name = body.value;
      if (isHeading) {
        const level = command.replace(/[\\*]/g, "");
        const sectionLevels = ["part", "chapter", "section", "subsection", "subsubsection"];
        let prefix = "";
        if (!command.endsWith("*")) {
          for (const lower of sectionLevels.slice(sectionLevels.indexOf(level) + 1))
            counters.delete(lower);
          for (const def of theorems.values())
            if (def.within === level) counters.delete(def.counter);
          number(level);
          const first = level === "part" ? 0 : 1;
          const hierarchy = sectionLevels
            .slice(first, sectionLevels.indexOf(level) + 1)
            .filter((k) => counters.has(k))
            .map((k) => counters.get(k))
            .join(".");
          prefix = documentNumber(hierarchy, body.end);
        }
        add(from, body.end, level.startsWith("sub") ? "subsection" : "section", name, {
          prefix,
          offset: body.start - from,
        });
        continue;
      }
      if (command === "\\caption") {
        const type = captionType || "table";
        const prefix =
          (type === "figure" ? "Figure " : "Table ") +
          documentNumber(number(type), body.end) +
          ": ";
        add(from, body.end, "caption", name, { prefix, offset: body.start - from });
        continue;
      }
      const begin = command === "\\begin";
      const optAt = skipSpace(source, body.end);
      const opt = begin ? argument(source, optAt, true) : undefined;
      const end = opt?.end ?? body.end;
      if (begin && name === "tikzpicture" && figures?.size) {
        const close = "\\end{tikzpicture}";
        const stop = mathEnd(source, end, close);
        const to = stop + close.length;
        const image = stop >= 0 && figures.get(source.slice(from, to));
        if (image) {
          add(from, to, "figure", "", { image });
          continue;
        }
      }
      if (begin && /^(?:verbatim\*?|minted|lstlisting)$/.test(name)) {
        const close = `\\end{${name}}`,
          i = source.indexOf(close, end);
        pattern.lastIndex = i < 0 ? source.length : i + close.length;
        opaque.push([from, pattern.lastIndex]);
        continue;
      }
      if (begin && name === "tabular") {
        const spec = argument(source, skipSpace(source, end));
        const close = "\\end{tabular}";
        const i = spec && mathEnd(source, spec.end, close);
        if (spec && i !== undefined && i >= 0)
          add(from, i + close.length, "table", source.slice(spec.end, i), {
            spec: spec.value,
            offset: spec.end - from,
          });
        continue;
      }
      if (begin && /^(?:equation|align|gather|multline)\*?$/.test(name)) {
        const close = `\\end{${name}}`;
        const i = mathEnd(source, body.end, close);
        if (i < 0) continue;
        const content = source.slice(body.end, i);
        const multi = /^(?:align|gather)/.test(name);
        const rows = multi
          ? alignmentParts(content, false)
          : [{ from: 0, to: content.length, separator: "" }];
        let rendered = rows
          .map((row) => {
            const raw = content.slice(row.from, row.to);
            const keys = Array.from(raw.matchAll(/\\label\{([^}]+)\}/g), (item) => item[1]!);
            let value = raw.replace(/\\label\{[^}]+\}/g, "");
            const tagCommand = /\\tag\*?\s*(?=\{)/.exec(value);
            const explicit = tagCommand && argument(value, tagCommand.index + tagCommand[0].length);
            if (explicit) {
              for (const key of keys) labels[key] = explicit.value;
            } else if (
              !name.endsWith("*") &&
              !/\\(?:notag|nonumber)\b/.test(value) &&
              value.trim()
            ) {
              const seq = number("equation");
              const tag = (!start && keys[0] && aux[keys[0]]) || seq;
              for (const key of keys) labels[key] = tag;
              value += `\\tag{${tag}}`;
            }
            return value + row.separator;
          })
          .join("");
        const env = name.startsWith("align")
          ? "align*"
          : name.startsWith("gather")
            ? "gather*"
            : "";
        if (env) rendered = `\\begin{${env}}${rendered}\\end{${env}}`;
        if (name.startsWith("multline"))
          rendered = rendered.replace(
            /^(.*?)(\\tag\{[^}]*\})?$/s,
            (_, v: string, tag: string | undefined) =>
              `\\begin{gathered}${v}\\end{gathered}${tag ?? ""}`,
          );
        add(from, i + close.length, "display", rendered);
        continue;
      }
      if (name === "enumerate" || name === "itemize") {
        if (begin) {
          const options = opt?.value ?? "";
          const template =
            /(?:^|,)\s*label\s*=\s*([^,]+)/.exec(options)?.[1] ??
            (name === "itemize" ? "\u2022" : "\\arabic*.");
          const initial = /(?:^|,)\s*start\s*=\s*(-?\d+)/.exec(options)?.[1];
          const margin = /(?:^|,)\s*leftmargin\s*=\s*(\d*\.?\d+)em\b/.exec(options)?.[1];
          lists.push({
            template,
            next: initial ? Number(initial) : 1,
            margin: margin ? Math.min(10, Number(margin)) : 2,
          });
        } else lists.pop();
        hidden(from, end);
        continue;
      }
      if (name === "abstract") {
        abstract = begin;
        if (begin) add(from, end, "abstract", "Abstract");
        else hidden(from, end);
        continue;
      }
      const theorem = theorems.get(name);
      if (theorem || /^(definition|theorem|lemma|remark|proof|proposition|corollary)$/.test(name)) {
        if (begin) {
          const title = theorem?.title ?? name[0]!.toUpperCase() + name.slice(1);
          const counter = theorem?.counter ?? name;
          const within = theorems.get(counter)?.within;
          const key =
            theorem && !theorem.starred ? documentNumber(number(counter, within), end) : "";
          // A source newline after the theorem heading is an interword space in TeX.
          const following = /[ \t]*(?:\n[ \t]*)?\\label\{([^{}\n]+)\}/y;
          following.lastIndex = end;
          const label = following.exec(source);
          if (key && label) labels[label[1]!] = key;
          let headingEnd = label ? following.lastIndex : end;
          const space = /[ \t]*(?:\n[ \t]*)?(?!\s|\\(?:begin|end)\b)/y;
          space.lastIndex = headingEnd;
          if (space.exec(source)) headingEnd = space.lastIndex;
          const style =
            theorem?.style ?? (name === "proof" || name === "definition" ? "definition" : "plain");
          theoremStyles.push(style);
          if (style === "plain") {
            const first = source.lastIndexOf("\n", from - 1) + 1;
            const line = lines.at(-1);
            if (line?.from === first) line.italic = true;
            else
              lines.push({
                from: first,
                indent: 0,
                abstract,
                item: false,
                blank: false,
                paragraph: false,
                italic: true,
              });
          }
          add(from, headingEnd, "theorem", opt?.value ?? "", {
            prefix: title + (key ? " " + key : ""),
            offset: (opt?.start ?? end) - from,
          });
        } else {
          theoremStyles.pop();
          hidden(from, end);
        }
        continue;
      }
      if (["center", "minipage", "document", "figure", "table"].includes(name)) {
        if (name === "figure" || name === "table") captionType = begin ? name : "";
        const width =
          begin && name === "minipage" ? argument(source, skipSpace(source, end)) : undefined;
        hidden(from, width?.end ?? end);
        continue;
      }
      // Only a closed environment counts, so typing \begin does not unsettle the text below it.
      if (begin) unknown.push({ name, from });
      else {
        const opened = unknown.findLastIndex((environment) => environment.name === name);
        if (opened >= 0) opaque.push([unknown[opened]!.from, end]);
        if (opened >= 0) unknown.length = opened;
      }
      continue;
    }
    if (command === "\\item" && lists.length) {
      const list = lists[lists.length - 1]!;
      const opt = argument(source, skipSpace(source, after), true);
      const startLine = source.lastIndexOf("\n", from - 1) + 1;
      const startPos = !source.slice(startLine, from).trim() ? startLine : from;
      let end = opt?.end ?? after;
      while (source[end] === " " || source[end] === "\t") end++;
      add(startPos, end, "marker", opt?.value ?? listLabel(list.template, list.next++));
      continue;
    }
    if (command === "$$" || command === "\\[") {
      const close = command === "$$" ? "$$" : "\\]";
      const i = mathEnd(source, after, close);
      if (i >= 0) add(from, i + close.length, "display", source.slice(after, i));
      continue;
    }
    const t = inlineAt(source, command, after, labels, figures);
    if (!t) continue;
    if (command === "\\label" && currentNumber) {
      const key = argument(source, skipSpace(source, after))?.value;
      if (key && (start || !labels[key])) labels[key] = currentNumber;
    }
    if (t.kind === "hidden") hidden(from, t.end);
    else add(from, t.end, t.kind, t.value, { offset: t.start - from });
  }
  linesThrough(source.length);
  // A forward reference may precede its declaration in an unbuilt manuscript.
  for (const t of tokens)
    if (t.kind === "reference") {
      const cmd = /^\\\w+/.exec(source.slice(t.from, t.to))![0];
      t.value = inlineAt(source, cmd, t.from + cmd.length, labels)!.value;
    }
  return {
    tokens,
    lines,
    joins: paragraphJoins(source, rows, tokens, opaque),
    labels,
    titles,
    figures,
    localTitle: !!start,
    linkColor,
    preamble: [preamble, ...localDefinitions].join("\n"),
  };
}
