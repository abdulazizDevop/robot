$server = Join-Path $PSScriptRoot 'server.ps1'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Server file was not found:`n$server", 'Hyperliquid Radar')
  exit 1
}

$port = 8765
$url = "http://127.0.0.1:$port/"
$ready = $false

try {
  $probe = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1
  $ready = $probe.StatusCode -eq 200
} catch {}

if (-not $ready) {
  $quotedServer = '"' + $server + '"'
  Start-Process powershell.exe -WindowStyle Hidden -WorkingDirectory $PSScriptRoot `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $quotedServer, '-Port', $port)

  $deadline = (Get-Date).AddSeconds(12)
  do {
    Start-Sleep -Milliseconds 250
    try {
      $probe = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1
      $ready = $probe.StatusCode -eq 200
    } catch { $ready = $false }
  } while (-not $ready -and (Get-Date) -lt $deadline)
}

if (-not $ready) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Local server did not respond at $url`nCheck whether port 8765 is already in use.", 'Hyperliquid Radar')
  exit 1
}

$browser = Get-Command msedge.exe, chrome.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($browser) {
  Start-Process -FilePath $browser.Source -ArgumentList @('--new-window', $url)
} else {
  Start-Process $url
}
