@echo off
setlocal
cd /d "%~dp0"
set "T3CODE_DEV_INSTANCE=t3latex"
call pnpm run dev:desktop --home-dir "%~dp0.t3\latex-dev" --no-seed
if errorlevel 1 pause
