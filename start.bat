@echo off
cd /d "%~dp0"
set "NODE="
where node >nul 2>nul
if not errorlevel 1 set "NODE=node"
if not defined NODE if exist "%~dp0nodejs\node.exe" set "NODE=%~dp0nodejs\node.exe"
if not defined NODE if exist "%~dp0..\nodejs\node.exe" set "NODE=%~dp0..\nodejs\node.exe"
if not defined NODE if exist "%~dp0..\..\nodejs\node.exe" set "NODE=%~dp0..\..\nodejs\node.exe"
if not defined NODE if exist "%~dp0..\..\..\nodejs\node.exe" set "NODE=%~dp0..\..\..\nodejs\node.exe"
if not defined NODE (
  echo node.exe not found. Edit start.bat and set NODE path.
  pause
  exit /b
)
echo Server starting... open http://localhost:8790/
start "" http://localhost:8790/
"%NODE%" server.js
pause
