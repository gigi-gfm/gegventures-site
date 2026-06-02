@echo off
REM Garcia Family Medicine Clinic Studio — one-click launcher
REM Starts the IME Studio server AND the Cloudflare Tunnel in separate windows.
REM Close either window to stop that part.

title Clinic Studio Launcher

echo.
echo =====================================================
echo   Garcia Family Medicine — Clinic Studio launcher
echo =====================================================
echo.
echo Starting two windows:
echo   1. IME Studio server  (don't close it while in use)
echo   2. Cloudflare Tunnel  (gives Dr. Tess a public URL)
echo.

REM %~dp0 expands to the folder this .bat file lives in.
cd /d "%~dp0"

REM ---- Server window ----
echo Launching server window...
start "Clinic Studio - SERVER" cmd /k "cd /d "%~dp0" && echo === IME Studio SERVER === && echo Leave this window open while using the app. && echo. && npm start"

REM Give the server a few seconds to come up before the tunnel tries to connect.
timeout /t 4 /nobreak >nul

REM ---- Tunnel window ----
echo Launching tunnel window...
start "Clinic Studio - TUNNEL" cmd /k "echo === Cloudflare TUNNEL === && echo Copy the trycloudflare.com URL below and share it with Dr. Tess. && echo. && cloudflared tunnel --url http://localhost:3000"

echo.
echo Both windows launched.
echo The TUNNEL window will print a https://...trycloudflare.com URL
echo within 5-10 seconds. That's the link to share with Dr. Tess.
echo Add /ime-studio.html to the end:
echo   https://[the-random-words].trycloudflare.com/ime-studio.html
echo.
echo You can close THIS window. Leave the other two open while in use.
echo.
pause
