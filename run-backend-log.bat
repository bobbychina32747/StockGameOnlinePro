@echo off
rem G-5: backend + full console log to file (recommended for debugging).
rem Why: running `node dist\src\main.js` directly loses the crash/stall scene forever once the
rem window is closed. This script tees stdout+stderr into backend\data\backend-console.log
rem (appended, with a start separator line) while still showing output live in the window.
setlocal
cd /d "%~dp0backend"
if not exist data mkdir data
set "LOG=%~dp0backend\data\backend-console.log"
echo. >> "%LOG%"
echo ================ backend start %DATE% %TIME% ================ >> "%LOG%"
powershell -NoProfile -Command "& { node dist\src\main.js 2>&1 | Tee-Object -FilePath '%LOG%' -Append }"
echo.
echo  Backend exited. Log appended to %LOG%
pause
