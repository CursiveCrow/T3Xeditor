# T3LaTeX

On Windows, run **Start-T3LaTeX.cmd** in the checkout. Open a project in the fork and click a workspace `.tex` file in Files. The editor saves ordinary project files through T3. Its desktop launcher uses a separate development profile. For the browser client, run `pnpm run dev --home-dir .t3/latex-dev --no-seed --browser` from the checkout instead. A fresh clone needs `pnpm install --frozen-lockfile` first.

## Writing and reviewing

- Choose **Build PDF** or press **Ctrl+Enter** (**Cmd+Enter** on macOS). Enable **Auto-build** to rebuild after edits. The workspace host needs a working installation of latexmk and the selected engine. The engine menu supports pdfLaTeX, XeLaTeX, and LuaLaTeX.
- Set **Main file** to the workspace-relative path of the project entry point when editing a chapter. The editor also reads the conventional `% !TeX root = ../paper.tex` and `% !TeX program = xelatex` comments. The compiler runs from the main file's directory, so relative figures, included chapters, and bibliographies resolve there.
- Use **Outline** to jump to a section. The editor supports line numbers, command and environment snippets, environment folding, undo/redo, and find/replace. Start a command with a backslash or use **Ctrl+Space** for completion. Reference completion uses labels in the open source. Following a successful build, citation suggestions can match bibliography keys, authors, and titles.
- Put the cursor on a line and choose **Go to PDF**. Double-click a line in the PDF to go back to the nearest mapped source line. **Ctrl/Cmd+Shift+J** jumps from the source or the focused PDF. SyncTeX points to source lines and sometimes associates a macro or float with a nearby line.
- Select source or typeset text, then choose **Add selection to chat**. The existing draft keeps its text and gains a quote with the source line range or PDF page. For a diagram or equation, choose **Clip PDF to chat** and drag a rectangle within one page. The resulting image is attached to the draft.
- Use the PDF toolbar to search, zoom, and move between pages. **Save PDF** exports the current successful build. A later failed build leaves that PDF available and opens the compiler log. Click a recognized file-and-line error to edit its source.

## Running and checking a build

Builds use the selected T3 environment and require terminal-operation permission. The compiler builds into a fresh temporary directory, disables shell escape, and skips project latexmk configuration files. Documents that require those facilities need their usual external build process. The PDF preview accepts output up to 12 MiB. The specialized editor opens files T3 can read in full. Larger sources use T3's existing large-file viewer.

Run `node scripts/test-latex-preview.ts` to exercise all three engines, bibliography resolution, included chapters, two-page SyncTeX output, and cleanup using the host's TeX distribution. The browser integration test in `FilePreviewPanel.browser.test.tsx` exercises source edits, both chat selection modes, image clipping, and failed rebuilds.

The files work with ordinary Git workflows. Simultaneous multi-user editing and always-on hosted coauthoring would require a collaboration service. See [the editor research](latex-editor-research.md) for the underlying user reports.
