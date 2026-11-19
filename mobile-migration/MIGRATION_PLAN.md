# VidyarthiVerse — Mobile Migration Plan

## Executive Summary
This document outlines the step-by-step strategy for converting the existing static HTML/CSS/JavaScript web application into a native Android app using Capacitor.

---

## 1. Project Architecture Plan

```text
PYQS-website-clean-source/
│
├── PYQS website/                (Original source - PRESERVED)
│
├── www/                         (Web assets bundled for Capacitor)
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── contact.html
│   ├── edit-profile.html
│   ├── exam.html
│   ├── papers.html
│   ├── profile.html
│   ├── css/
│   │   ├── style.css
│   │   ├── papers.css
│   │   └── mobile-overrides.css (Mobile UI adaptations & responsive tweaks)
│   └── js/
│       ├── auth.js
│       ├── contact.js
│       ├── edit-profile.js
│       ├── exam.js
│       ├── firebase-config.js
│       ├── firebase.js
│       ├── header.js
│       ├── home.js
│       ├── papers.js
│       └── profile.js
│
├── android/                     (Capacitor-generated native Android Studio project)
├── package.json                 (npm project configuration)
├── capacitor.config.ts          (Capacitor native settings)
└── mobile-migration/            (Audit & Migration Documentation)
```

---

## 2. Key Technical Decisions & Strategy

1. **Static Web Preservation**:
   - Web directory configured as `www`.
   - All HTML files, CSS stylesheets, and JS ES modules are copied intact into `www/`.
   - Relative paths between HTML pages and assets are fully preserved.

2. **Capacitor Configuration**:
   - App Name: `VidyarthiVerse`
   - App ID: `com.pyqs.website`
   - Web Directory: `www`

3. **Firebase Integration Strategy**:
   - Firebase Web SDK 12.1.0 is retained without backend changes.
   - Auth persistence (`indexedDB`/`localStorage`) functions natively in Android WebView.
   - Firestore reads and writes operate directly over HTTPS.

4. **Mobile UI Adaptation**:
   - Add `mobile-overrides.css` to handle touch targets, viewports, Android safe-area insets, responsive grids, and touch scroll behavior.
   - Add viewport meta tag adjustments (`viewport-fit=cover`).
   - Enhance back button handling for Android native back gestures using Capacitor App plugin listeners if needed.

5. **Android Project Generation & Build**:
   - Command sequence:
     ```powershell
     npm install
     npx cap add android
     npx cap sync android
     ```
   - Open project in Android Studio or compile debug APK via Gradle wrapper (`./gradlew assembleDebug`).

---

## 3. Step-by-Step Implementation Timeline

| Phase | Milestone | Actions |
|---|---|---|
| Phase 1-3 | Audit & Verification | Audit codebase, verify static webapp files, build feature inventory. |
| Phase 4-6 | Project & Asset Prep | Initialize `package.json`, set up `www/` web directory, configure Capacitor. |
| Phase 7 | Firebase Preservation | Verify Firebase config credentials and client-side module initialization. |
| Phase 8 | Native Android Project | Run `npx cap add android` and `npx cap sync android`. |
| Phase 9-10| Mobile UI & Navigation | Add mobile responsiveness (`mobile-overrides.css`), optimize touch buttons and header nav. |
| Phase 11-13| Feature Verification | Verify Home, Login, Signup, Profile, Papers, Exam, Contact features on Android. |
| Phase 14-17| Android Studio & APK | Sync Gradle, configure Android permissions/SDKs, build debug APK, write instructions. |
