param([int]$Port = 8765)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'autotrade.ps1')
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Hyperliquid Radar on http://127.0.0.1:$Port/"
try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      if ($context.Request.HttpMethod -in @('POST','GET') -and $context.Request.Url.AbsolutePath -like '/autotrade/*') {
        if ($context.Request.HttpMethod -eq 'GET' -and $context.Request.Url.AbsolutePath -eq '/autotrade/status') {
          $response = (Get-AutoTradeStatus | ConvertTo-Json -Compress -Depth 5)
        } elseif ($context.Request.HttpMethod -eq 'POST') {
          $reader = [IO.StreamReader]::new($context.Request.InputStream, $context.Request.ContentEncoding)
          $payload = $reader.ReadToEnd(); $reader.Dispose(); $data = $payload | ConvertFrom-Json
          if ($context.Request.Url.AbsolutePath -eq '/autotrade/config') { $response = (Save-AutoTradeConfig $data | ConvertTo-Json -Compress -Depth 5) }
          elseif ($context.Request.Url.AbsolutePath -eq '/autotrade/signal') { $response = (Invoke-AutoTradeSignal $data | ConvertTo-Json -Compress -Depth 5) }
          else { throw 'Unknown autotrade endpoint' }
        } else { throw 'Invalid autotrade request' }
        $bytes = [Text.Encoding]::UTF8.GetBytes($response)
        $context.Response.ContentType = 'application/json; charset=utf-8'; $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length); $context.Response.Close(); continue
      }
      if ($context.Request.HttpMethod -eq 'POST' -and $context.Request.Url.AbsolutePath -eq '/save-export') {
        $reader = [IO.StreamReader]::new($context.Request.InputStream, $context.Request.ContentEncoding)
        $payload = $reader.ReadToEnd()
        $reader.Dispose()
        $data = $payload | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($data.filename) -or $data.filename -notmatch '^[A-Za-z0-9._-]+\.csv$') {
          throw 'Invalid export filename'
        }
        $desktop = [Environment]::GetFolderPath('Desktop')
        $target = Join-Path $desktop $data.filename
        $content = [string]$data.content
        $hasBom = $content.Length -gt 0 -and [int][char]$content[0] -eq 0xFEFF
        $encoding = [Text.UTF8Encoding]::new(-not $hasBom)
        [IO.File]::WriteAllText($target, $content, $encoding)
        $response = (@{ ok = $true; filename = $data.filename } | ConvertTo-Json -Compress)
        $bytes = [Text.Encoding]::UTF8.GetBytes($response)
        $context.Response.ContentType = 'application/json; charset=utf-8'
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.Close()
        continue
      }
      $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
      if ([string]::IsNullOrWhiteSpace($path)) { $path = 'index.html' }
      $file = Join-Path $root $path
      $fullRoot = [IO.Path]::GetFullPath($root)
      $fullFile = [IO.Path]::GetFullPath($file)
      if (-not $fullFile.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $fullFile -PathType Leaf)) {
        $context.Response.StatusCode = 404
        $context.Response.Close()
        continue
      }
      $bytes = [IO.File]::ReadAllBytes($fullFile)
      $mime = switch ([IO.Path]::GetExtension($fullFile).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.css' { 'text/css; charset=utf-8' }
        '.js' { 'text/javascript; charset=utf-8' }
        default { 'application/octet-stream' }
      }
      $context.Response.ContentType = $mime
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $context.Response.Close()
    } catch {
      try { $context.Response.StatusCode = 500; $context.Response.Close() } catch {}
    }
  }
} finally { $listener.Stop(); $listener.Close() }
