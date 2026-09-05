@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DropLink v0.2.2
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm не найден. Установите Node.js 18+.
  pause
  exit /b 1
)
npm start
pause
