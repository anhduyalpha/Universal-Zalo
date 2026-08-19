param (
    [string]$ProxyServer = "socks5://127.0.0.1:9050",
    [string]$UserDataDir = "$env:LOCALAPPDATA\UniversalZalo\ChromeProfile",
    [string]$TargetUrl = "https://chat.zalo.me"
)

$ChromeCandidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

$BrowserPath = $null
foreach ($path in $ChromeCandidates) {
    if (Test-Path $path) {
        $BrowserPath = $path
        break
    }
}

if (-not $BrowserPath) {
    Write-Host "No Chrome/Edge executable found in standard locations!" -ForegroundColor Red
    exit 1
}

Write-Host "Launching Browser: $BrowserPath" -ForegroundColor Cyan
Write-Host "Proxy Server: $ProxyServer" -ForegroundColor Cyan
Write-Host "User Data Directory: $UserDataDir" -ForegroundColor Cyan

& $BrowserPath `
    --proxy-server="$ProxyServer" `
    --user-data-dir="$UserDataDir" `
    --disable-background-timer-throttling `
    --disable-backgrounding-occluded-windows `
    --disable-renderer-backgrounding `
    --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling `
    --disable-ipc-flooding-protection `
    --autoplay-policy=no-user-gesture-required `
    --no-first-run `
    --no-default-browser-check `
    $TargetUrl
