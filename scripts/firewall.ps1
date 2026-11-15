# Allow inbound TCP port for sybot (run as Administrator).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/firewall.ps1 [-Port 5284]
param([int]$Port = 5284)

$ruleName = "sybot $Port"

# idempotent: remove same-name rule first
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Remove-NetFirewallRule -DisplayName $ruleName
  Write-Host "Removed existing rule: $ruleName"
}

New-NetFirewallRule -DisplayName $ruleName `
  -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -Profile Private, Domain `
  -Description "sybot LAN photo sync server port" | Out-Null
Write-Host "Allowed inbound TCP $Port (Private/Domain profiles only)."
Write-Host "NOTE: if your Wi-Fi profile is 'Public', switch it to 'Private' first:"
Write-Host "  Set-NetConnectionProfile -InterfaceAlias WLAN -NetworkCategory Private"
Write-Host "  (Settings > Network > WLAN > Network profile type)"
