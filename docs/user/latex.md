# T3Xeditor

Open a `.tex` file from Files on web or desktop to write directly on the typeset page in T3Xeditor. Building the PDF runs on the machine that hosts the environment, which needs `latexmk` and your TeX engine installed.

## Writing on the paper

Headings, emphasis, lists, theorems, tables, cross-references, and inline and display math are typeset as you write. Put the caret on anything typeset, or select inside it, and it turns back into its source, shown in a code font. Math shows its result beside the source while you edit. Move the caret away or press Escape and it is typeset again. Find and replace reveals each match the same way.

The preamble stays hidden until the caret enters it, for example with the Up arrow from the first line. Clicking the title edits only its `\title`, `\author`, or `\date`.

A paragraph written across several source lines flows together as it does in the PDF. While the caret is inside it, the paragraph shows its source lines instead, so Enter and Backspace act on the line breaks you see. It flows again when the caret leaves.

Macros come from the main document's preamble and from the file you are in. Math the editor cannot typeset stays as source. TikZ pictures and symbols drawn with TikZ appear in place after a build.

Turn off **Live rendering** to work in plain source, with line numbers and folding. **Show source** in the file header opens T3 Code's standard source view instead.

## Building the PDF

Choose **Build PDF** or press Ctrl+Enter (Cmd+Enter on macOS). The PDF opens beside the source, and **Stop** cancels a build that is still running. Turn on **Auto-build** to rebuild a moment after each edit. Building needs permission to run commands in the environment.

A chapter builds through the document that includes it, and its chapters share one PDF. When more than one document includes the file, the main-file menu lists them to pick from. That menu also sets the engine: pdfLaTeX, XeLaTeX, or LuaLaTeX. The comments `% !TeX root = ../paper.tex` and `% !TeX program = xelatex` set both from the file.

Builds write to a temporary folder, so they never replace a PDF or auxiliary files in your project. They skip the project's `.latexmkrc` and run without shell escape; a document that needs either has to be built in a terminal. A build stops after 90 seconds, and a PDF over 12 MiB is not shown.

When a build fails, the last good PDF stays open and the errors are listed under the editor. Click one to go to its line. **Build log** shows the full compiler output.

## Moving between source and PDF

- **Go to PDF** (Ctrl/Cmd+Shift+J) scrolls the PDF to the line your caret is on.
- Double-click in the PDF to jump to its source, in whichever file it comes from. Ctrl/Cmd+Shift+J does the same from a focused PDF.
- **Outline** jumps to a section of the open file.

## Asking the agent about a passage

Select source or text in the PDF and choose **Add selection to chat** to quote it in your draft with its location. For a figure or an equation, turn on **Clip PDF to chat** in the PDF toolbar and drag a rectangle over it. The clip is attached as an image.

## Completion

Type a backslash for commands and environments. Inside `\ref{` the labels of the open file are offered. Inside `\cite{`, after a build, so are the bibliography's entries, which you can search by key, author, or title.
