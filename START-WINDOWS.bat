@echo off
setlocal
cd /d "%~dp0"

if not exist "data" mkdir "data"

set "ZENIT_DATABASE_PATH=%~dp0data\zenitmc.sqlite"
set "LOG_PROFILE=quiet"

if not exist "runtime\node.exe" (
  echo ERROR: Portable Node.js runtime was not found.
  echo Extract the complete ZIP archive before starting the application.
  pause
  exit /b 1
)

"runtime\node.exe" manager.js dev
set "ZENIT_EXIT_CODE=%ERRORLEVEL%"

if not "%ZENIT_EXIT_CODE%"=="0" (
  echo.
  echo ZenitMC stopped with exit code %ZENIT_EXIT_CODE%.
  pause
)

exit /b %ZENIT_EXIT_CODE%
