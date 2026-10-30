@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment is missing. Ask the assistant to restore it.
  pause
  exit /b 1
)
if not exist ".local\pgsql\bin\postgres.exe" (
  powershell -NoProfile -ExecutionPolicy RemoteSigned -File scripts\install-local-postgres.ps1
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
powershell -NoProfile -ExecutionPolicy RemoteSigned -File scripts\setup-local.ps1
if errorlevel 1 (
  echo Setup stopped safely. Do not delete any database folders. Tell the assistant.
  pause
  exit /b 1
)
pause
