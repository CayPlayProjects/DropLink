@echo off
chcp 65001 >nul
setlocal
if "%PORT%"=="" set "PORT=3000"
echo ========================================
echo   DropLink LAN diagnostics
echo ========================================
echo.
echo [1] Node / port
where node
netstat -ano | findstr ":%PORT%"
echo.
echo [2] IPv4 adapters + default gateways
powershell -NoProfile -Command "Get-NetIPConfiguration ^| Where-Object {$_.IPv4Address} ^| Select-Object InterfaceAlias,@{n='IPv4';e={$_.IPv4Address.IPAddress}},@{n='Gateway';e={$_.IPv4DefaultGateway.NextHop}} ^| Format-Table -AutoSize"
echo.
echo [3] Firewall rule
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'DropLink Local Transfer (TCP %PORT%)' -ErrorAction SilentlyContinue ^| Get-NetFirewallPortFilter ^| Format-List"
echo.
echo [4] Local health
powershell -NoProfile -Command "try{Invoke-RestMethod 'http://127.0.0.1:%PORT%/api/health' ^| ConvertTo-Json -Compress}catch{Write-Host $_.Exception.Message -ForegroundColor Red}"
echo.
echo Copy this whole window if phone still cannot connect.
echo.
pause
