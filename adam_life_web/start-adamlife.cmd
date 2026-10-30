@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Для запуска требуется установленный Node.js.
  pause
  exit /b 1
)
if not exist "node_modules\vite\bin\vite.js" (
  echo Установка локальных зависимостей AdamLife...
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo AdamLife 2.0: http://localhost:5173/
echo Для авторизации сначала запустите adam_life_api\start-api.cmd.
echo Оставьте это окно открытым. Для остановки нажмите Ctrl+C.
node node_modules\vite\bin\vite.js --port 5173 --strictPort --open http://localhost:5173/
pause
