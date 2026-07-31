@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title StockSim Pro - 一键启动
cd /d "%~dp0"

:: 全局主题色（Windows 控制台标准色）
color 0B

:: ==========================================================
echo.
echo   ======================================================
echo     StockSim Pro  -  专业炒股模拟平台
echo     Stock Trading Simulator Platform
echo   ======================================================
echo.

:: ---------------- 0. 环境检查 ----------------
echo   [1/6] 环境检查
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo        [FAIL] Node.js 未安装！请访问 https://nodejs.org 安装 v18+ 后重试
    pause
    exit /b 1
)
for /f "tokens=1" %%v in ('node --version') do echo        [OK] Node.js  %%v
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo        [FAIL] npm 未找到
    pause
    exit /b 1
)
for /f "tokens=1" %%v in ('npm --version') do echo        [OK] npm  %%v
echo.

:: ---------------- 1. 依赖检查（缺失自动安装） ----------------
echo   [2/6] 依赖检查
if not exist "backend\node_modules" (
    echo        [WARN] 后端依赖缺失，正在自动安装，请稍候...
    pushd "backend"
    call npm install --no-fund --no-audit >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] 后端依赖安装失败，请手动执行: cd backend ^&^& npm install
        pause
        exit /b 1
    )
    popd
    echo        [OK] 后端依赖安装完成
) else (
    echo        [OK] 后端依赖已就绪
)
if not exist "frontend\node_modules" (
    echo        [WARN] 前端依赖缺失，正在自动安装，请稍候...
    pushd "frontend"
    call npm install --no-fund --no-audit >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] 前端依赖安装失败，请手动执行: cd frontend ^&^& npm install
        pause
        exit /b 1
    )
    popd
    echo        [OK] 前端依赖安装完成
) else (
    echo        [OK] 前端依赖已就绪
)
echo.

:: ---------------- 2. 构建检查（源码更新自动重建） ----------------
echo   [3/6] 构建检查
if not exist "backend\data" mkdir "backend\data"
set "NEED_BUILD="
for /f "delims=" %%r in ('node scripts\check-build.js') do set "NEED_BUILD=%%r"

echo !NEED_BUILD! | findstr /c:"backend" >nul 2>&1
if %errorlevel% equ 0 (
    echo        [WARN] 后端源码有更新，正在重新构建...
    pushd "backend"
    call npm run build >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] 后端构建失败，请检查 TypeScript 报错
        pause
        exit /b 1
    )
    popd
    echo        [OK] 后端构建完成
) else (
    echo        [OK] 后端构建产物为最新
)

echo !NEED_BUILD! | findstr /c:"frontend" >nul 2>&1
if %errorlevel% equ 0 (
    echo        [WARN] 前端源码有更新，正在重新构建...
    pushd "frontend"
    call npm run build >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] 前端构建失败，请检查 TypeScript 报错
        pause
        exit /b 1
    )
    popd
    echo        [OK] 前端构建完成
) else (
    echo        [OK] 前端构建产物为最新
)
echo.

:: ---------------- 3. 端口检查 ----------------
echo   [4/6] 端口检查
netstat -ano | findstr ":8000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    curl -s -o nul http://localhost:8000/api/market/prices 2>nul
    if %errorlevel% equ 0 (
        echo        [OK] 端口 8000 已有 StockSim 后端在运行（跳过启动）
        set "BACKEND_RUNNING=1"
    ) else (
        echo        [FAIL] 端口 8000 被其他程序占用，请先关闭占用进程后重试
        pause
        exit /b 1
    )
) else (
    echo        [OK] 端口 8000 可用
)
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    curl -s -o nul http://localhost:3000 2>nul
    if %errorlevel% equ 0 (
        echo        [OK] 端口 3000 已有 StockSim 前端在运行（跳过启动）
        set "FRONTEND_RUNNING=1"
    ) else (
        echo        [FAIL] 端口 3000 被其他程序占用，请先关闭占用进程后重试
        pause
        exit /b 1
    )
) else (
    echo        [OK] 端口 3000 可用
)
echo.

:: ---------------- 4. 启动后端 + 健康检查 ----------------
if not defined BACKEND_RUNNING (
    echo   [5/6] 启动后端服务  http://localhost:8000/api
    start "StockSim Backend - :8000" cmd /k "cd /d %~dp0backend && node dist\src\main.js"

    set "BACKEND_OK="
    for /l %%i in (1,1,30) do (
        curl -s -o nul http://localhost:8000/api/market/prices 2>nul
        if not errorlevel 1 (
            set "BACKEND_OK=1"
            goto backend_ready
        )
        ping -n 2 127.0.0.1 >nul
    )
    :backend_ready
    if defined BACKEND_OK (
        echo        [OK] 后端已就绪（健康检查通过）
    ) else (
        echo        [FAIL] 后端启动超时，请查看 "StockSim Backend" 窗口的日志
        pause
        exit /b 1
    )
)
echo.

:: ---------------- 5. 启动前端 + 健康检查 ----------------
if not defined FRONTEND_RUNNING (
    echo   [6/6] 启动前端服务  http://localhost:3000
    start "StockSim Frontend - :3000" cmd /k "cd /d %~dp0frontend && npx vite --host"

    set "FRONTEND_OK="
    for /l %%i in (1,1,30) do (
        curl -s -o nul http://localhost:3000 2>nul
        if not errorlevel 1 (
            set "FRONTEND_OK=1"
            goto frontend_ready
        )
        ping -n 2 127.0.0.1 >nul
    )
    :frontend_ready
    if defined FRONTEND_OK (
        echo        [OK] 前端已就绪（健康检查通过）
    ) else (
        echo        [FAIL] 前端启动超时，请查看 "StockSim Frontend" 窗口的日志
        pause
        exit /b 1
    )
)
echo.

:: ---------------- 6. 打开浏览器 ----------------
echo   [DONE] 打开浏览器...
start http://localhost:3000

:: ---------------- 完成面板 ----------------
echo.
echo   ======================================================
echo     服务已全部就绪！
echo   ------------------------------------------------------
echo     前端页面    http://localhost:3000
echo     API 接口    http://localhost:8000/api
echo     WebSocket   ws://localhost:8000/market
echo   ------------------------------------------------------
echo     停止服务：直接关闭两个服务窗口即可
echo     重新启动：再次运行 start.bat（自动跳过已运行服务）
echo   ======================================================
echo.
pause
