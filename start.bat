@echo off
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE=node"
  goto run
)
if exist "%~dp0..\..\nodejs\node.exe" (
  set "NODE=%~dp0..\..\nodejs\node.exe"
  goto run
)
echo node.exe not found. Edit start.bat and set NODE path.
pause
exit /b
:run
echo Server starting... open http://localhost:8787/
start "" http://localhost:8787/
"%NODE%" server.js
pause