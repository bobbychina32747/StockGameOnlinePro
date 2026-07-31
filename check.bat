@echo off
chcp 65001 >nul
title StockSim Pro - Environment Check
cd /d "%~dp0"

echo ============================================
echo   StockSim Pro - 环境检查
echo ============================================
echo.

set "PASS=1"

:: ── Check Node.js ──
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [FAIL] Node.js 未安装。请从 https://nodejs.org/ 下载安装
    set PASS=0
) else (
    for /f "tokens=1" %%v in ('node --version') do echo [OK] Node.js  %%v
)

:: ── Check npm ──
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [FAIL] npm 未找到
    set PASS=0
) else (
    for /f "tokens=1" %%v in ('npm --version') do echo [OK] npm  %%v
)

echo.

:: ── Check backend dependencies ──
if not exist "backend\package.json" (
    echo [FAIL] backend\package.json 缺失
    set PASS=0
) else if not exist "backend\node_modules" (
    echo [WARN] 后端依赖未安装，请运行 install.bat
    set PASS=0
) else if not exist "backend\dist\src\main.js" (
    echo [FAIL] 后端编译产物 backend\dist\src\main.js 缺失
    set PASS=0
) else (
    echo [OK]  后端依赖就绪
)

:: ── Check frontend dependencies ──
if not exist "frontend\package.json" (
    echo [FAIL] frontend\package.json 缺失
    set PASS=0
) else if not exist "frontend\node_modules" (
    echo [WARN] 前端依赖未安装，请运行 install.bat
    set PASS=0
) else if not exist "frontend\index.html" (
    echo [FAIL] frontend\index.html 缺失
    set PASS=0
) else (
    echo [OK]  前端依赖就绪
)

echo.
if %PASS% equ 1 (
    echo ============================================
    echo   环境检查通过！可以运行 start.bat 启动服务
    echo ============================================
) else (
    echo ============================================
    echo   环境检查未通过，请修复上述问题
    echo ============================================
)
echo.
pause
