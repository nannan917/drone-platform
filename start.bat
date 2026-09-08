@echo off
setlocal
title Drone-Swarm-Platform Launcher
cd /d "%~dp0"

if not exist "%~dp0node_modules\ws" (
  echo [first-run] installing ws dependency...
  call npm install
  if errorlevel 1 (
    echo dependency install failed. check Node.js.
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if %errorlevel% equ 0 (
  echo [info] already running at http://127.0.0.1:4000
  start "" "http://127.0.0.1:4000"
  exit /b 0
)

echo [start] launching service in background...
powershell -NoProfile -Command "Start-Process -FilePath 'D:\node.exe' -ArgumentList 'server/src/index.js --sim 0 --udp 14550 --port 4000' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server.log' -RedirectStandardError '%~dp0server-err.log'"

echo [wait] waiting for service...
set /a tries=0
:waitloop
set /a tries+=1
if %tries% gtr 20 goto timeout
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:4000/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }" | findstr "True" >nul 2>&1
if %errorlevel% equ 0 goto ready
timeout /t 2 /nobreak >nul
goto waitloop

:timeout
echo [FAIL] service not ready. check server.log / server-err.log
pause
exit /b 1

:ready
echo [OK] platform ready at http://127.0.0.1:4000
start "" "http://127.0.0.1:4000"
echo project dir: %~dp0
echo stop service: close only this platform process
timeout /t 4 /nobreak >nul
exit /b 0