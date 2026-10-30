@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Prepare the local environment first. See README.md.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" scripts\configure_google.py
pause
