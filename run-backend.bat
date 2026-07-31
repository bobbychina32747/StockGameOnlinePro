@echo off
title StockSim Backend - :8000
cd /d "%~dp0backend"
echo.
echo  ================================================
echo    StockSim Backend  -  port 8000
echo    Starting... press Ctrl+C to stop
echo  ================================================
echo.
node dist\src\main.js
echo.
echo  Backend process exited.
pause
