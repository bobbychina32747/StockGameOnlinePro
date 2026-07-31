@echo off
title StockSim Frontend - :3000
cd /d "%~dp0frontend"
echo.
echo  ================================================
echo    StockSim Frontend  -  port 3000
echo    Starting... press Ctrl+C to stop
echo  ================================================
echo.
npx vite --host
echo.
echo  Frontend process exited.
pause
