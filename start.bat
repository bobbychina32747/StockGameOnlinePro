@echo off
setlocal EnableExtensions EnableDelayedExpansion
title StockSim Pro - One-Click Launcher
cd /d "%~dp0"
color 0B

echo.
echo   ======================================================
echo     StockSim Pro  -  Stock Trading Simulator Platform
echo   ======================================================
echo.

:: ---------------- 0. Environment check ----------------
echo   [1/6] Environment check
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo        [FAIL] Node.js not found! Install from https://nodejs.org  v18+
    pause
    exit /b 1
)
for /f "tokens=1" %%v in ('node --version') do echo        [OK] Node.js  %%v
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo        [FAIL] npm not found
    pause
    exit /b 1
)
for /f "tokens=1" %%v in ('npm --version') do echo        [OK] npm  %%v
echo.

:: ---------------- 1. Dependency check (auto install) ----------------
echo   [2/6] Dependency check
if not exist "backend\node_modules" (
    echo        [WARN] Backend deps missing, installing...
    pushd "backend"
    call npm install --no-fund --no-audit >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] Backend install failed. Try: cd backend ^&^& npm install
        pause
        exit /b 1
    )
    popd
    echo        [OK] Backend deps installed
) else (
    echo        [OK] Backend deps ready
)
if not exist "frontend\node_modules" (
    echo        [WARN] Frontend deps missing, installing...
    pushd "frontend"
    call npm install --no-fund --no-audit >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] Frontend install failed. Try: cd frontend ^&^& npm install
        pause
        exit /b 1
    )
    popd
    echo        [OK] Frontend deps installed
) else (
    echo        [OK] Frontend deps ready
)
echo.

:: ---------------- 2. Build check (auto rebuild) ----------------
echo   [3/6] Build check
if not exist "backend\data" mkdir "backend\data"
set "NEED_BUILD="
for /f "delims=" %%r in ('node scripts\check-build.js') do set "NEED_BUILD=%%r"

echo !NEED_BUILD! | findstr /c:"backend" >nul 2>&1
if %errorlevel% equ 0 (
    echo        [WARN] Backend source changed, rebuilding...
    pushd "backend"
    call npm run build >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] Backend build failed, check TypeScript errors
        pause
        exit /b 1
    )
    popd
    echo        [OK] Backend build done
) else (
    echo        [OK] Backend build up-to-date
)

echo !NEED_BUILD! | findstr /c:"frontend" >nul 2>&1
if %errorlevel% equ 0 (
    echo        [WARN] Frontend source changed, rebuilding...
    pushd "frontend"
    call npm run build >nul 2>&1
    if %errorlevel% neq 0 (
        popd
        echo        [FAIL] Frontend build failed, check TypeScript errors
        pause
        exit /b 1
    )
    popd
    echo        [OK] Frontend build done
) else (
    echo        [OK] Frontend build up-to-date
)
echo.

:: ---------------- 3. Port check ----------------
echo   [4/6] Port check
netstat -ano | findstr ":8000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    curl -s -o nul http://localhost:8000/api/market/prices 2>nul
    if %errorlevel% equ 0 (
        echo        [OK] Port 8000 already running StockSim backend  -  skipped
        set "BACKEND_RUNNING=1"
    ) else (
        echo        [FAIL] Port 8000 occupied by another program, close it first
        pause
        exit /b 1
    )
) else (
    echo        [OK] Port 8000 free
)
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    curl -s -o nul http://localhost:3000 2>nul
    if %errorlevel% equ 0 (
        echo        [OK] Port 3000 already running StockSim frontend  -  skipped
        set "FRONTEND_RUNNING=1"
    ) else (
        echo        [FAIL] Port 3000 occupied by another program, close it first
        pause
        exit /b 1
    )
) else (
    echo        [OK] Port 3000 free
)
echo.

:: ---------------- 4. Start backend + health check ----------------
if not defined BACKEND_RUNNING (
    echo   [5/6] Start backend  http://localhost:8000/api
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
        echo        [OK] Backend ready  -  health check passed
    ) else (
        echo        [FAIL] Backend startup timeout, check "StockSim Backend" window
        pause
        exit /b 1
    )
)
echo.

:: ---------------- 5. Start frontend + health check ----------------
if not defined FRONTEND_RUNNING (
    echo   [6/6] Start frontend  http://localhost:3000
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
        echo        [OK] Frontend ready  -  health check passed
    ) else (
        echo        [FAIL] Frontend startup timeout, check "StockSim Frontend" window
        pause
        exit /b 1
    )
)
echo.

:: ---------------- 6. Open browser ----------------
echo   [DONE] Opening browser...
start http://localhost:3000

:: ---------------- Done panel ----------------
echo.
echo   ======================================================
echo     All services ready!
echo   ------------------------------------------------------
echo     Frontend:   http://localhost:3000
echo     API:        http://localhost:8000/api
echo     WebSocket:  ws://localhost:8000/market
echo   ------------------------------------------------------
echo     Stop:    close the two service windows
echo     Restart: run start.bat again  -  running services are skipped
echo   ======================================================
echo.
pause
