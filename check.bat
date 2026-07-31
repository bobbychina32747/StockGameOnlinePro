@echo off
title StockSim Pro - Environment Check
cd /d "%~dp0"

echo ============================================
echo   StockSim Pro - Environment Check
echo ============================================
echo.

set "PASS=1"

:: -- Check Node.js --
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [FAIL] Node.js not installed. Download from https://nodejs.org/
    set PASS=0
) else (
    for /f "tokens=1" %%v in ('node --version') do echo [OK] Node.js  %%v
)

:: -- Check npm --
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [FAIL] npm not found
    set PASS=0
) else (
    for /f "tokens=1" %%v in ('npm --version') do echo [OK] npm  %%v
)

echo.

:: -- Check backend deps & build --
if not exist "backend\package.json" (
    echo [FAIL] backend\package.json missing
    set PASS=0
) else if not exist "backend\node_modules" (
    echo [WARN] Backend deps not installed, run start.bat
    set PASS=0
) else if not exist "backend\dist\src\main.js" (
    echo [FAIL] Backend build missing  -  backend\dist\src\main.js
    set PASS=0
) else (
    echo [OK]  Backend ready
)

:: -- Check frontend deps --
if not exist "frontend\package.json" (
    echo [FAIL] frontend\package.json missing
    set PASS=0
) else if not exist "frontend\node_modules" (
    echo [WARN] Frontend deps not installed, run start.bat
    set PASS=0
) else if not exist "frontend\index.html" (
    echo [FAIL] frontend\index.html missing
    set PASS=0
) else (
    echo [OK]  Frontend ready
)

echo.
if %PASS% equ 1 (
    echo ============================================
    echo   All checks passed! Run start.bat to launch
    echo ============================================
) else (
    echo ============================================
    echo   Check failed, fix the issues above
    echo ============================================
)
echo.
pause
