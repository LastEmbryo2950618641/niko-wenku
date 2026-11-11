@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer.
  pause
  exit /b 1
)
if not exist node_modules call npm install --no-audit --no-fund
if errorlevel 1 goto failed
call npm run setup
if errorlevel 1 goto failed
if not exist dist\index.html call npm run build
if errorlevel 1 goto failed
echo Open http://127.0.0.1:4178
call npm start
goto end
:failed
echo Startup failed. See the message above.
pause
:end
