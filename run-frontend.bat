@echo off
title StockSim Frontend - Port 3000
cd /d "%~dp0frontend"
echo [Frontend] Starting StockSim Pro frontend...
echo [Frontend] Press Ctrl+C to stop
echo.
npx vite --host
echo.
echo [Frontend] Process exited.
pause
