param([int]$Port = 3000)

$ErrorActionPreference = 'Stop'
$ruleName = "DropLink Local Transfer (TCP $Port)"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  $argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port"
  $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $argLine
  exit $proc.ExitCode
}

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

$privateRanges = @('LocalSubnet','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -RemoteAddress $privateRanges `
  -Profile Any | Out-Null

Write-Host ''
Write-Host "DropLink: TCP $Port разрешён для LocalSubnet и частных LAN-диапазонов." -ForegroundColor Green
Write-Host 'Правило действует для Private/Public/Domain профилей Windows.'
Write-Host ''
Start-Sleep -Seconds 2
