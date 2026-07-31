@echo off
chcp 65001 >nul
title StockSim Pro - 启动服务
cd /d "%~dp0"

echo ============================================
echo   StockSim Pro - 启动服务
echo   Stock Trading Simulator Platform
echo ============================================
echo.

:: Quick pre-check before launching
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [FAIL] Node.js 未安装。请先运行 check.bat 查看详情
    pause
    exit /b 1
)

:: Create data directory if not exists
if not exist "backend\data" mkdir backend\data

:: Start backend
echo [1/2] Starting backend (port 8000)...
start "StockSim-Backend" cmd /c run-backend.bat

:: Wait for backend to initialize
echo Waiting for backend (5 seconds)...
ping -n 5 127.0.0.1 >nul

:: Start frontend
echo [2/2] Starting frontend (port 3000)...
start "StockSim-Frontend" cmd /c run-frontend.bat

echo.
echo ============================================
echo   服务已启动！
echo.
echo   Backend:  http://localhost:8000/api
echo   Frontend: http://localhost:3000
echo   WebSocket: ws://localhost:8000/market
echo ============================================
echo.
echo 按任意键关闭此窗口（服务将持续在后台运行）...
pause >nul
