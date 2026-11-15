@echo off
rem Double-click this file to start Hiyo on Windows.
rem First run installs the dependencies (about a minute), then opens the site.
title Hiyo
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies - this takes a minute the first time...
  call npm install || (
    echo.
    echo npm install failed. Make sure this folder is not inside C:\Users\yourname or OneDrive.
    pause
    exit /b 1
  )
)

echo.
echo Starting Hiyo... keep this window open. Press Ctrl+C to stop.
start "" http://localhost:3000
call npm start
pause
