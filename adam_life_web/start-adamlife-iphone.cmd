@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\vite\bin\vite.js" (
  echo Сначала запустите start-adamlife.cmd для подготовки проекта.
  pause
  exit /b 1
)
echo AdamLife: локальный просмотр на компьютере и iPhone в одной Wi-Fi сети.
echo Откройте на iPhone адрес Network из списка ниже.
echo Это HTTP-проверка интерфейса, не подтверждение установки PWA по HTTPS.
echo Не закрывайте это окно. Для остановки: Ctrl+C.
node node_modules\vite\bin\vite.js --host 0.0.0.0 --port 5174 --strictPort
pause
