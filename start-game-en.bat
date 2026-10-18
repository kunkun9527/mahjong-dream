@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js 22 or higher is required. Please install Node.js 22 first.
  pause
  exit /b 1
)
for /f "delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (
  echo [Error] Node.js version is too low. Please install Node.js 22 or higher.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  echo Installing local dependencies...
  call npm install
  if errorlevel 1 (
    echo [Error] npm install failed.
    pause
    exit /b 1
  )
)
echo Close this window to stop the local game server.
node local\launcher.mjs --lang=en %*
if errorlevel 1 pause
