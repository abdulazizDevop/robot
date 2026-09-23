Set-StrictMode -Version Latest

$script:AutoTradeDir = Join-Path $env:LOCALAPPDATA 'HyperliquidRadar'
$script:AutoTradeFile = Join-Path $script:AutoTradeDir 'bybit-mainnet.json'
$script:BybitBase = 'https://api.bybit.com'

function Get-AutoTradeConfig {
  if (-not (Test-Path -LiteralPath $script:AutoTradeFile)) { return $null }
  return (Get-Content -LiteralPath $script:AutoTradeFile -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function ConvertTo-PlainSecret([string]$value) {
  $secure = ConvertTo-SecureString $value
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Get-AutoTradeStatus {
  $config = Get-AutoTradeConfig
  if ($null -eq $config) { return @{ configured = $false; enabled = $false; addresses = @() } }
  return @{ configured = $true; enabled = [bool]$config.enabled; addresses = @($config.addresses); equityPercent = [double]$config.equityPercent; leverage = [int]$config.leverage; apiKeyMask = ('*' * [Math]::Max(0, $config.apiKeyLast4.Length - 4)) + $config.apiKeyLast4 }
}

function Save-AutoTradeConfig($input) {
  $addresses = @($input.addresses | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ -match '^0x[0-9a-f]{40}$' } | Select-Object -Unique | Select-Object -First 2)
  if ($addresses.Count -lt 1) { throw 'Enter one or two valid Hyperliquid addresses.' }
  $equityPercent = [double]$input.equityPercent
  $leverage = [int]$input.leverage
  if ($equityPercent -le 0 -or $equityPercent -gt 100) { throw 'Equity percent must be between 0.01 and 100.' }
  if ($leverage -lt 1 -or $leverage -gt 100) { throw 'Leverage must be between 1 and 100.' }
  $old = Get-AutoTradeConfig
  $apiKey = [string]$input.apiKey
  $apiSecret = [string]$input.apiSecret
  if ([string]::IsNullOrWhiteSpace($apiKey) -or [string]::IsNullOrWhiteSpace($apiSecret)) {
    if ($null -eq $old) { throw 'Enter Bybit API Key and API Secret.' }
    $apiKeyProtected = $old.apiKeyProtected
    $apiSecretProtected = $old.apiSecretProtected
    $apiKeyLast4 = $old.apiKeyLast4
  } else {
    $apiKeyProtected = (ConvertTo-SecureString $apiKey -AsPlainText -Force | ConvertFrom-SecureString)
    $apiSecretProtected = (ConvertTo-SecureString $apiSecret -AsPlainText -Force | ConvertFrom-SecureString)
    $apiKeyLast4 = $apiKey.Substring([Math]::Max(0, $apiKey.Length - 4))
  }
  New-Item -ItemType Directory -Path $script:AutoTradeDir -Force | Out-Null
  $config = [ordered]@{ apiKeyProtected=$apiKeyProtected; apiSecretProtected=$apiSecretProtected; apiKeyLast4=$apiKeyLast4; addresses=$addresses; equityPercent=$equityPercent; leverage=$leverage; enabled=[bool]$input.enabled; updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $script:AutoTradeFile -Encoding UTF8
  return Get-AutoTradeStatus
}

function Get-BybitSecrets($config) {
  return @{ key=(ConvertTo-PlainSecret $config.apiKeyProtected); secret=(ConvertTo-PlainSecret $config.apiSecretProtected) }
}

function Invoke-Bybit([string]$method, [string]$path, $body, $config) {
  $secrets = Get-BybitSecrets $config
  $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $window = '10000'
  $payload = if ($method -eq 'GET') { [string]$body } else { $body | ConvertTo-Json -Compress -Depth 8 }
  $source = $timestamp + $secrets.key + $window + $payload
  $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secrets.secret))
  try { $signature = -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($source)) | ForEach-Object { $_.ToString('x2') }) }
  finally { $hmac.Dispose() }
  $headers = @{ 'X-BAPI-API-KEY'=$secrets.key; 'X-BAPI-SIGN'=$signature; 'X-BAPI-SIGN-TYPE'='2'; 'X-BAPI-TIMESTAMP'=$timestamp; 'X-BAPI-RECV-WINDOW'=$window }
  $uri = $script:BybitBase + $path + $(if ($method -eq 'GET' -and $payload) { '?' + $payload } else { '' })
  if ($method -eq 'GET') { $response = Invoke-RestMethod -Uri $uri -Method GET -Headers $headers -TimeoutSec 15 }
  else { $response = Invoke-RestMethod -Uri $uri -Method POST -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 15 }
  if ($response.retCode -ne 0) { throw "Bybit $($response.retCode): $($response.retMsg)" }
  return $response.result
}

function Format-BybitNumber([decimal]$value) { return $value.ToString('0.########', [Globalization.CultureInfo]::InvariantCulture) }

function Invoke-AutoTradeSignal($input) {
  $config = Get-AutoTradeConfig
  if ($null -eq $config -or -not [bool]$config.enabled) { return @{ ok=$true; skipped='Auto trading is disabled' } }
  $leader = ([string]$input.address).ToLowerInvariant()
  if (@($config.addresses) -notcontains $leader) { return @{ ok=$true; skipped='Address is not configured' } }
  $coin = ([string]$input.coin).ToUpperInvariant()
  $symbol = ($coin -replace '^[A-Z0-9]+:', '' -replace '^@', '') + 'USDT'
  if ($coin -match 'USDT$') { $symbol = $coin }
  $query = "category=linear&symbol=$([Uri]::EscapeDataString($symbol))"
  try { $instrument = Invoke-RestMethod -Uri ($script:BybitBase + '/v5/market/instruments-info?' + $query) -Method GET -TimeoutSec 12 }
  catch { throw "Could not check symbol ${symbol}: $($_.Exception.Message)" }
  if ($instrument.retCode -ne 0 -or @($instrument.result.list).Count -eq 0) { return @{ ok=$true; skipped="Symbol ${symbol} is not available" } }
  $side = [string]$input.side
  if ($side -notin @('Buy','Sell','')) { throw 'Invalid order side.' }
  $positions = Invoke-Bybit 'GET' '/v5/position/list' $query $config
  $open = @($positions.list | Where-Object { [decimal]$_.size -gt 0 -and $_.side -in @('Buy','Sell') })
  $current = $open | Select-Object -First 1
  if ([string]::IsNullOrEmpty($side)) {
    if ($null -eq $current) { return @{ ok=$true; skipped='No Bybit position' } }
    $closeSide = if ($current.side -eq 'Buy') { 'Sell' } else { 'Buy' }
    $close = @{ category='linear'; symbol=$symbol; side=$closeSide; orderType='Market'; qty=[string]$current.size; reduceOnly=$true; positionIdx=if($current.side -eq 'Buy'){1}else{2} }
    Invoke-Bybit 'POST' '/v5/order/create' $close $config | Out-Null
    return @{ ok=$true; action="Closed ${symbol} after leader close" }
  }
  if ($null -ne $current -and $current.side -eq $side) { return @{ ok=$true; skipped='Same position is already open' } }
  if ($null -ne $current) {
    if ([decimal]$current.unrealisedPnl -lt 10) { return @{ ok=$true; skipped='Opposite signal ignored: PnL is below $10' } }
    $closeSide = if ($current.side -eq 'Buy') { 'Sell' } else { 'Buy' }
    $close = @{ category='linear'; symbol=$symbol; side=$closeSide; orderType='Market'; qty=[string]$current.size; reduceOnly=$true; positionIdx=if($current.side -eq 'Buy'){1}else{2} }
    Invoke-Bybit 'POST' '/v5/order/create' $close $config | Out-Null
  }
  Invoke-Bybit 'POST' '/v5/position/set-leverage' @{ category='linear'; symbol=$symbol; buyLeverage=[string]$config.leverage; sellLeverage=[string]$config.leverage } $config | Out-Null
  $wallet = Invoke-Bybit 'GET' '/v5/account/wallet-balance' 'accountType=UNIFIED' $config
  $available = [decimal]$wallet.list[0].totalAvailableBalance
  $ticker = Invoke-RestMethod -Uri ($script:BybitBase + '/v5/market/tickers?' + $query) -Method GET -TimeoutSec 12
  $price = [decimal]$ticker.result.list[0].lastPrice
  $step = [decimal]$instrument.result.list[0].lotSizeFilter.qtyStep
  $notional = $available * ([decimal]$config.equityPercent / 100) * [decimal]$config.leverage
  $qty = [Math]::Floor($notional / $price / $step) * $step
  if ($qty -le 0) { throw 'Available balance is below the minimum order size.' }
  $order = @{ category='linear'; symbol=$symbol; side=$side; orderType='Market'; qty=(Format-BybitNumber $qty); positionIdx=if($side -eq 'Buy'){1}else{2}; orderLinkId=('hlr' + [Guid]::NewGuid().ToString('N').Substring(0,18)) }
  $result = Invoke-Bybit 'POST' '/v5/order/create' $order $config
  return @{ ok=$true; action="Opened $side ${symbol}"; orderId=$result.orderId; qty=(Format-BybitNumber $qty) }
}
