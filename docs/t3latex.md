# T3LaTeX

On Windows, run **Start-T3LaTeX.cmd** in the checkout. Open a project in the fork and click a workspace `.tex` file in Files. The editor saves ordinary project files through T3. Its desktop launcher uses a separate development profile. For the browser client, run `pnpm run dev --home-dir .t3/latex-dev --no-seed --browser` from the checkout instead. A fresh clone needs `pnpm install --frozen-lockfile` first.

## Live editing

Opening a TeX source starts in a full-width white-paper view with dark text, including when T3 uses dark mode. Inline and display math are typeset as you write. Click an expression to expose its source and see the live result beside it. Move the caret away or press Ctrl/Cmd+Enter in the formula to return to the typeset form. Headings, bold and italic text, list items and theorem headings also render in the editor. Click **Live rendering** to switch back to literal source.

Math uses KaTeX and supports ordinary and robust command definitions read from the main document and the open file. Cross-references use the main document?s existing auxiliary file when available. For PDF-only symbols with embedded Unicode ActualText, the editor can use that text as a visual fallback. Unsupported expressions stay editable as source. Page layout, bibliography generation and package-specific rendering are available through **Build PDF**. The **PDF preview** toggle controls the separate page view.

## Writing and reviewing

- Choose **Build PDF** or press **Ctrl+Enter** (**Cmd+Enter** on macOS). Enable **Auto-build** to rebuild after edits. The workspace host needs a working installation of latexmk and the selected engine. The engine menu supports pdfLaTeX, XeLaTeX, and LuaLaTeX.
- Building a chapter searches its folder and parent folders for a document that includes it. Click **Main file** to inspect the full workspace-relative path, choose a different entry point, or change engines. The editor also reads the conventional `% !TeX root = ../paper.tex` and `% !TeX program = xelatex` comments. The compiler runs from the main file's directory, so relative figures, included chapters, and bibliographies resolve there.
- Use **Outline** to jump to a section. The editor supports line numbers, command and environment snippets, environment folding, undo/redo, and find/replace. Start a command with a backslash or use **Ctrl+Space** for completion. Reference completion uses labels in the open source. Following a successful build, citation suggestions can match bibliography keys, authors, and titles.
- Put the cursor on a line and choose **Go to PDF**. Double-click a line in the PDF to go back to the nearest mapped source line. **Ctrl/Cmd+Shift+J** jumps from the source or the focused PDF. SyncTeX points to source lines and sometimes associates a macro or float with a nearby line.
- Select source or typeset text, then choose **Add selection to chat**. The existing draft keeps its text and gains a quote with the source line range or PDF page. For a diagram or equation, choose **Clip PDF to chat** and drag a rectangle within one page. The resulting image is attached to the draft.
- Use the PDF toolbar to search, zoom, and move between pages. **Save PDF** exports the current successful build. A later failed build leaves that PDF available and shows the first diagnostic. Open **Build log** for the full compiler output. Click a recognized file-and-line error to edit its source.

## Running and checking a build

Builds use the selected T3 environment and require terminal-operation permission. The compiler builds into a fresh temporary directory, disables shell escape, and skips project latexmk configuration files. Documents that require those facilities need their usual external build process. The PDF preview accepts output up to 12 MiB. The specialized editor opens files T3 can read in full. Larger sources use T3's existing large-file viewer.

Run `pnpm run test:latex-preview` to exercise all three engines, bibliography resolution, included chapters, two-page SyncTeX output, and cleanup using the host's TeX distribution. The browser integration test in `FilePreviewPanel.browser.test.tsx` exercises source edits, both chat selection modes, image clipping, and failed rebuilds.

The files work with ordinary Git workflows. Simultaneous multi-user editing and always-on hosted coauthoring would require a collaboration service. See [the editor research](latex-editor-research.md) for the underlying user reports.
