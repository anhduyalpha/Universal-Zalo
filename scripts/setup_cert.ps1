# Setup Windows Root CA Certificate for Universal Zalo Proxy
$CertDir = "$PSScriptRoot\..\certs"
$CertPath = "$CertDir\ca.crt"

if (-not (Test-Path $CertDir)) {
    New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
}

Write-Host "Checking certificate at $CertPath..." -ForegroundColor Cyan

if (Test-Path $CertPath) {
    Write-Host "Installing Root CA into Windows Certificate Store (CurrentUser\Root)..." -ForegroundColor Yellow
    certutil.exe -addstore -user Root $CertPath
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Root CA installed successfully!" -ForegroundColor Green
    } else {
        Write-Host "Failed to install Root CA. Error code: $LASTEXITCODE" -ForegroundColor Red
    }
} else {
    Write-Host "Certificate file not found at $CertPath. Start zalo-proxy once to generate certificates automatically." -ForegroundColor Yellow
}
