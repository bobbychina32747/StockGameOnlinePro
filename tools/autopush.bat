@echo off
rem =====================================================
rem  StockSim Pro auto backup (daily 17:00 via Task Scheduler)
rem  Lightweight: runs only when triggered, exits in <2s
rem =====================================================
cd /d E:\Files\Games\StockGameOnlinePro

git add -A
git commit -m "auto backup" >nul 2>&1
git push origin main >>tools\autopush.log 2>&1
echo [%date% %time%] backup done >>tools\autopush.log
