@echo off
setlocal
cd /d "%~dp0"
".venv\Scripts\python.exe" scripts\local_env.py start
if errorlevel 1 pause
