export type TexArgument = { value: string; start: number; end: number };

export function argument(source: string, open: number, optional = false): TexArgument | undefined {
  const left = optional ? "[" : "{",
    right = optional ? "]" : "}";
  if (source[open] !== left) return;
  let braces = 0;
  let brackets = 0;
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "%") {
      i = endOfLine(source, i) - 1;
      continue;
    }
    if (ch === right && braces === 0 && brackets === 0)
      return { value: source.slice(open + 1, i), start: open + 1, end: i + 1 };
    if (optional && braces === 0 && ch === "[") brackets++;
    if (optional && braces === 0 && ch === "]") brackets--;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
  }
}

export function endOfLine(source: string, at: number) {
  const next = source.indexOf("\n", at);
  return next < 0 ? source.length : next;
}

export function skipSpace(source: string, at: number) {
  while (at < source.length && /[ \t\n]/.test(source[at]!)) at++;
  return at;
}

export function inlinePattern() {
  return /\\[a-zA-Z@]+\*?|\\[^\n]|\$\$?|%|~|---?|``|''/g;
}

export function mathEnd(source: string, start: number, close: string) {
  for (let i = start; i < source.length; i++) {
    if (source.startsWith(close, i)) return i;
    if (source[i] === "%") i = endOfLine(source, i) - 1;
    else if (source[i] === "\\") i++;
    else if (close === "$" && source[i] === "\n" && /^\n[ \t]*\n/.test(source.slice(i))) break;
  }
  return -1;
}

// Separators inside a group, math cell, or nested array belong to that construct.
export function alignmentParts(source: string, splitCells: boolean) {
  const parts: { from: number; to: number; rowEnd: boolean; separator: string }[] = [];
  const syntax = /\\(?:begin|end)\{[^}]+\}|\\[\s\S]|[{}%&$]/g;
  let braces = 0,
    environments = 0,
    start = 0;
  for (let m; (m = syntax.exec(source));) {
    const token = m[0];
    if (token === "%") {
      syntax.lastIndex = endOfLine(source, syntax.lastIndex);
      continue;
    }
    if (splitCells && (token === "$" || token === "\\(")) {
      const close = token === "$" ? "$" : "\\)";
      const end = mathEnd(source, syntax.lastIndex, close);
      if (end >= 0) syntax.lastIndex = end + close.length;
      continue;
    }
    if (token === "{") braces++;
    if (token === "}") braces--;
    if (token.startsWith("\\begin{")) environments++;
    if (token.startsWith("\\end{")) environments--;
    if (braces || environments || !(token === "\\\\" || (splitCells && token === "&"))) continue;
    if (token === "\\\\")
      syntax.lastIndex = argument(source, syntax.lastIndex, true)?.end ?? syntax.lastIndex;
    parts.push({
      from: start,
      to: m.index,
      rowEnd: token === "\\\\",
      separator: source.slice(m.index, syntax.lastIndex),
    });
    start = syntax.lastIndex;
  }
  parts.push({ from: start, to: source.length, rowEnd: true, separator: "" });
  return parts;
}

export type Labels = Readonly<Record<string, string>>;
export type Inline = {
  kind:
    | "glyph"
    | "math"
    | "bold"
    | "italic"
    | "reference"
    | "text"
    | "break"
    | "hidden"
    | "plain"
    | "code";
  value: string;
  start: number;
  end: number;
};
// A word joiner (U+2060) withholds a line break the browser would allow and TeX does not: before
// an em dash and after a thin space.
const substitutions: Record<string, string> = {
  "~": "\u00a0",
  // oxlint-disable-next-line t3code/no-em-dash-copy -- TeX uses three hyphens to typeset this punctuation in the manuscript.
  "---": "\u2060\u2014",
  "--": "–",
  "``": "“",
  "''": "”",
  "\\%": "%",
  "\\&": "&",
  "\\#": "#",
  "\\_": "_",
  "\\$": "$",
  "\\{": "{",
  "\\}": "}",
  "\\ ": "\u00a0",
  "\\,": "\u2009\u2060",
  "\\LaTeX": "LaTeX",
  "\\TeX": "TeX",
};
export function inlineAt(
  source: string,
  command: string,
  after: number,
  labels: Labels,
  glyphs?: { has(command: string): boolean },
): Inline | undefined {
  const span = (
    kind: Inline["kind"],
    value: string,
    end = after,
    start = after - command.length,
  ): Inline => ({ kind, value, start, end });
  if (glyphs?.has(command)) return span("glyph", command);
  if (Object.hasOwn(substitutions, command)) return span("text", substitutions[command]!);
  if (command === "%") return span("hidden", "", endOfLine(source, after));
  if (command === "$" || command === "\\(") {
    const close = command === "$" ? "$" : "\\)";
    const at = mathEnd(source, after, close);
    if (at >= 0) return span("math", source.slice(after, at), at + close.length, after);
    return;
  }
  if (/^\\verb\*?$/.test(command)) {
    const delimiter = source[after];
    const end = delimiter && source.indexOf(delimiter, after + 1);
    if (typeof end === "number" && end >= 0 && end <= endOfLine(source, after))
      return span("code", source.slice(after + 1, end), end + 1, after + 1);
    return;
  }
  if (command === "\\\\") return span("break", "", argument(source, after, true)?.end ?? after);
  if (
    /^\\(?:centering|raggedright|small|large|Large|normalsize|noindent|medskip|bigskip|smallskip|makeatletter|makeatother)$/.test(
      command,
    )
  )
    return span("hidden", "");
  if (
    !/^\\(?:textbf|textit|emph|textnormal|textrm|texttt|text|texorpdfstring|label|ref|pageref|eqref|[vh]space\*?)$/.test(
      command,
    )
  )
    return;
  const body = argument(source, skipSpace(source, after));
  if (!body) return;
  if (/^\\(?:label|[vh]space)/.test(command)) return span("hidden", "", body.end);
  if (command === "\\texorpdfstring") {
    const bookmark = argument(source, skipSpace(source, body.end));
    if (!bookmark) return;
    return span("plain", body.value, bookmark.end, body.start);
  }
  if (/ref$/.test(command)) {
    const value = labels[(command === "\\pageref" ? "page:" : "") + body.value] ?? body.value;
    return span("reference", command === "\\eqref" ? `(${value})` : value, body.end);
  }
  const kind =
    command === "\\textbf"
      ? "bold"
      : /^\\(?:textit|emph)$/.test(command)
        ? "italic"
        : command === "\\texttt"
          ? "code"
          : "plain";
  return span(kind, body.value, body.end, body.start);
}
