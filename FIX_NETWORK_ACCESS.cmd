@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set "PORT=3000"
title DropLink — настройка локальной сети

echo.
echo ================================================
echo   DropLink — доступ с телефона по локальной сети
echo ================================================
echo.
echo Windows попросит права администратора.
echo Правило откроет TCP-порт %PORT% только для LocalSubnet.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0FIX_NETWORK_ACCESS.ps1" -Port %PORT%
if errorlevel 1 (
  echo.
  echo [DropLink] Настройка не выполнена.
  echo Если окно UAC было отменено, запустите этот файл снова.
  echo.
  pause
  exit /b 1
)

echo.
echo Готово.
echo.
pause
