# T3Xeditor

T3Xeditor is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code) maintained independently of T3 Tools, Inc. It opens `.tex` files as editable, typeset pages. Click an equation to edit its LaTeX, move away to see the result, or select a passage to add it to chat.

## Run the editor

Install [Vite+](https://viteplus.dev/guide/) for the project's pinned toolchain. From a terminal, run these commands to start the desktop app with its own local profile.

```sh
git clone -c core.longpaths=true https://github.com/CursiveCrow/T3Xeditor.git
cd T3Xeditor
vp i
vp run dev:desktop --home-dir .t3/latex-dev --no-seed
```

On Windows, after installing dependencies, you can also launch the app with [Start-T3LaTeX.cmd](./Start-T3LaTeX.cmd) when `pnpm` is on your PATH. In **Files**, open a project containing a `.tex` file and select the file. Live editing works immediately. To use **Build PDF** and jump between source and PDF, install `latexmk` and a TeX engine on the machine hosting the project.

[LaTeX editing and keyboard shortcuts](./docs/user/latex.md) ? [Development setup](./docs/operations/00_development.md#first-checkout) ? [All documentation](./docs/README.md)

## License

The original source and this fork are distributed under the [MIT License](./LICENSE). The bundled fonts carry their own [Latin Modern](./apps/web/src/assets/latin-modern/GUST-FONT-LICENSE.TXT) and [double-struck font](./apps/web/src/assets/double-struck/OFL.txt) licenses. Upstream names, logos and other brand assets are covered by the [upstream trademark policy](./TRADEMARK.md).
