@echo off
REM Garcia Family Medicine — server-only launcher (no tunnel).
REM Use this when you only need to access the studio yourself at
REM http://localhost:3000 and don't need Dr. Tess to be able to reach it.

title Clinic Studio - SERVER

cd /d "%~dp0"

echo === IME Studio SERVER (local only) ===
echo.
echo The studio will be available at http://localhost:3000
echo Leave this window open while using the app.
echo Press Ctrl+C to stop the server.
echo.

npm start

REM If npm start exits for any reason, hold the window open so you can see why.
echo.
echo The server has stopped. Press any key to close this window.
pause >nul
