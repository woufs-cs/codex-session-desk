@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies missing. Run npm ci in this folder first.
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause
