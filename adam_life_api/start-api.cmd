@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Create the project virtual environment and install requirements-dev.txt. See README.md.
  exit /b 1
)
if exist ".local\local-settings.json" (
  ".venv\Scripts\python.exe" scripts\local_env.py serve
) else (
  ".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --no-access-log
)
