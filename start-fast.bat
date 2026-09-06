@echo off
rem Phase A: 沙盒高速回放启动器（1 秒 = 1 分钟行情，约 4 分钟跑完一个交易日）。
rem 快档下日息/IPO/分红按游戏日加速，与真实市场口径不符，仅供演示/调试/快速体验。
setlocal
set "TICK_INTERVAL_MS=1000"
set "SANDBOX_FAST=true"
echo.
echo   [SANDBOX] 高速回放模式: TICK_INTERVAL_MS=1000 (1秒=1分钟)
echo            日息/IPO/分红按游戏日加速，仅供演示。
echo.
call "%~dp0start.bat"
endlocal
