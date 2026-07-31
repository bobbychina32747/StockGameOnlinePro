@echo off
title StockSim Backend - Port 8000
cd /d "%~dp0backend"
echo [Backend] Starting StockSim Pro backend...
echo [Backend] Press Ctrl+C to stop
echo.
node dist/src/main.js
echo.
echo [Backend] Process exited.
pause
