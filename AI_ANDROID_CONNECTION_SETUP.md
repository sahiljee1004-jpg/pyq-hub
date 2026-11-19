# VidyarthiVerse AI Assistant — Android USB Connection & Setup Guide

This guide explains how to connect your physical Android phone to your local Node.js backend server using ADB Reverse Port Mapping.

---

## 1. Quick Start (Automated PowerShell Helper Script)

Run the included helper script in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-ai-android-dev.ps1
```

The script automatically:
1. Detects your Android SDK and `adb.exe` location (`C:\Users\RUPENDRA\AppData\Local\Android\Sdk\platform-tools\adb.exe`).
2. Verifies connected Android USB devices and authority status.
3. Executes `adb reverse tcp:3000 tcp:3000` to forward mobile requests to your PC's local server.
4. Verifies `http://127.0.0.1:3000/health` backend health endpoint.

---

## 2. Manual Step-by-Step Connection Setup

### Step A: Start the AI Backend Server
In your project directory, run:
```bash
npm run start:server
```
Expected output:
```
🚀 VidyarthiVerse AI Assistant Server listening on 0.0.0.0:3000
   Provider: groq
   Model:    openai/gpt-oss-120b
   Endpoints: GET /health | POST /api/chat | POST /api/ai-chat
```

### Step B: Connect Android Phone via USB
1. Plug your Android phone into your PC with a USB cable.
2. Enable **Developer Options** on your phone (Settings -> About Phone -> Tap *Build Number* 7 times).
3. Enable **USB Debugging** (Settings -> Developer Options -> USB Debugging).
4. When prompted on your phone ("Allow USB debugging?"), check **Always allow from this computer** and tap **Allow**.

### Step C: Fix "ADB is not recognized" Error
If `adb` is not in your global system PATH, run commands using the absolute SDK path:
```powershell
& "C:\Users\RUPENDRA\AppData\Local\Android\Sdk\platform-tools\adb.exe" devices
```

Expected output:
```
List of devices attached
5pjnjzqwfqcinzor    device
```

### Step D: Forward Mobile Requests to PC
Run the ADB reverse command:
```powershell
& "C:\Users\RUPENDRA\AppData\Local\Android\Sdk\platform-tools\adb.exe" reverse tcp:3000 tcp:3000
```
Verify the mapping:
```powershell
& "C:\Users\RUPENDRA\AppData\Local\Android\Sdk\platform-tools\adb.exe" reverse --list
```
Expected output: `UsbFfs tcp:3000 tcp:3000`

---

## 3. Rebuilding the Android Application

Whenever you update web files (`www/`) or Capacitor configurations, run:

```bash
# 1. Copy web assets to Android
npx cap sync android

# 2. Compile Debug APK
cd android
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat clean assembleDebug
```

Output APK Location:
`c:\Users\RUPENDRA\Downloads\PYQS-website-clean-source\android\app\build\outputs\apk\debug\app-debug.apk`

---

## 4. Development vs Production Endpoints

In [www/js/ai-chat.js](file:///c:/Users/RUPENDRA/Downloads/PYQS-website-clean-source/www/js/ai-chat.js), API URLs are centrally managed:

```javascript
const CONFIG = {
    // 1. USB Development (requires ADB reverse)
    USB_DEV_URL: "http://127.0.0.1:3000/api/chat",

    // 2. Wi-Fi Local Development (requires phone & PC on same Wi-Fi)
    // WIFI_DEV_URL: "http://192.168.1.X:3000/api/chat",

    // 3. Production HTTPS Endpoint (Firebase Functions / Cloud Run)
    // PROD_URL: "https://<your-project>.cloudfunctions.net/api/chat"
};
```

---

## 5. ADB Reverse Limitations & Production Deployment

- **USB Dependency**: `adb reverse tcp:3000 tcp:3000` routes requests through the USB cable. If you unplug the USB cable, mobile requests to `127.0.0.1:3000` will fail.
- **Wi-Fi Alternative**: For wireless testing on the same Wi-Fi network, update `CONFIG.USB_DEV_URL` to your PC's local IP address (e.g. `http://192.168.1.15:3000/api/chat`).
- **Production Deployment**: Deploy `server/server.js` as a Firebase Cloud Function or Cloud Run service, set `AI_API_KEY` in Firebase secrets, and update `CONFIG.PROD_URL`.
