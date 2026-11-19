# ============================================================
# VIDYARTHIVERSE AI CHATBOT - ANDROID ADB REVERSE HELPER SCRIPT
# ============================================================

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  VidyarthiVerse AI Assistant - Android USB Dev Connection Setup" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Locate adb.exe
$adbPaths = @(
    "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
    "$env:ANDROID_HOME\platform-tools\adb.exe",
    "$env:ANDROID_SDK_ROOT\platform-tools\adb.exe",
    "C:\Users\RUPENDRA\AppData\Local\Android\Sdk\platform-tools\adb.exe"
)

$adb = $null
foreach ($path in $adbPaths) {
    if (Test-Path $path) {
        $adb = $path
        break
    }
}

if (-not $adb) {
    Write-Host "[ERROR] adb.exe could not be found in standard Android SDK locations." -ForegroundColor Red
    Write-Host "        Please ensure Android Studio SDK Platform Tools are installed." -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Android ADB found at: $adb" -ForegroundColor Green

# 2. Check Connected Devices
Write-Host ""
Write-Host "[1/4] Checking connected Android devices..." -ForegroundColor Yellow
$deviceOutput = & $adb devices

$lines = $deviceOutput -split "`r?`n"
$devices = @()
foreach ($line in $lines) {
    if ($line -and $line -notmatch "List of devices attached") {
        $devices += $line
    }
}

if ($devices.Count -eq 0) {
    Write-Host "[WARNING] No Android devices detected over USB." -ForegroundColor Yellow
    Write-Host "          Action Required: Connect your Android phone via USB cable and enable USB Debugging." -ForegroundColor White
} else {
    foreach ($dev in $devices) {
        if ($dev -match "unauthorized") {
            Write-Host "[UNAUTHORIZED] Device detected but UNAUTHORIZED: $dev" -ForegroundColor Red
            Write-Host "               Action Required: Unlock phone screen and tap 'Allow USB Debugging'." -ForegroundColor White
        } elseif ($dev -match "device") {
            Write-Host "[CONNECTED] Device connected and AUTHORIZED: $dev" -ForegroundColor Green
        } elseif ($dev -match "offline") {
            Write-Host "[OFFLINE] Device OFFLINE: $dev" -ForegroundColor Yellow
            Write-Host "          Action Required: Unplug and reconnect USB cable." -ForegroundColor White
        }
    }
}

# 3. Configure ADB Reverse tcp:3000 tcp:3000
Write-Host ""
Write-Host "[2/4] Setting up ADB port reverse (tcp:3000 -> tcp:3000)..." -ForegroundColor Yellow
try {
    # Execute ADB reverse-port mapping for local AI backend (port 3000)
    & $adb reverse tcp:3000 tcp:3000
    Write-Host "[OK] ADB reverse executed successfully!" -ForegroundColor Green
} catch {
    Write-Host "[WARNING] ADB reverse command failed. Ensure an authorized device is connected." -ForegroundColor Red
}

# Verify ADB Reverse List
Write-Host ""
Write-Host "[3/4] Verifying active ADB reverse port mappings:" -ForegroundColor Yellow
$reverseList = & $adb reverse --list
if ($reverseList -match "3000") {
    Write-Host "[OK] Active Port Mapping: tcp:3000 -> tcp:3000" -ForegroundColor Green
    Write-Host "     Output: $reverseList" -ForegroundColor Gray
} else {
    Write-Host "[WARNING] No active reverse port mapping found for port 3000." -ForegroundColor Yellow
}

# 4. Verify Local Backend Server Health
Write-Host ""
Write-Host "[4/4] Checking VidyarthiVerse AI Backend Server health (http://127.0.0.1:3000/health)..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/health" -TimeoutSec 3 -ErrorAction Stop
    if ($health.success) {
        Write-Host "[ONLINE] Backend Server is ONLINE!" -ForegroundColor Green
        Write-Host "         Service:  $($health.service)" -ForegroundColor Gray
        Write-Host "         Provider: $($health.provider)" -ForegroundColor Gray
        Write-Host "         Model:    $($health.model)" -ForegroundColor Gray
    } else {
        Write-Host "[WARNING] Backend returned non-success response." -ForegroundColor Yellow
    }
} catch {
    Write-Host "[OFFLINE] Backend server is NOT running on port 3000." -ForegroundColor Red
    Write-Host "          Action Required: Run 'npm run start:server' in a separate terminal window." -ForegroundColor White
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  SETUP SUMMARY" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  Chatbot API URL:  http://127.0.0.1:3000/api/chat" -ForegroundColor White
Write-Host "  Health Endpoint:  http://127.0.0.1:3000/health" -ForegroundColor White
Write-Host "====================================================" -ForegroundColor Cyan
