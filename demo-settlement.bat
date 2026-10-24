@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js 22 is required. Please install it first.
  pause
  exit /b 1
)
set "LEVEL=%~1"
if not "%LEVEL%"=="" goto run
echo Settlement animation demo (a throw-away browser profile; your save is not touched)
echo.
echo   1. Mangan
echo   2. Haneman
echo   3. Baiman
echo   4. Sanbaiman
echo   5. Yakuman
echo   6. All of them in turn
echo.
choice /c 123456 /n /m "Pick 1-6: "
if errorlevel 6 set "LEVEL=all" & goto run
if errorlevel 5 set "LEVEL=yakuman" & goto run
if errorlevel 4 set "LEVEL=sanbaiman" & goto run
if errorlevel 3 set "LEVEL=baiman" & goto run
if errorlevel 2 set "LEVEL=haneman" & goto run
set "LEVEL=mangan"
:run
echo Starting the %LEVEL% demo. Close the browser window to stop.
node tools\demo_settlement.mjs %LEVEL%
if errorlevel 1 pause
