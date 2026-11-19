# VidyarthiVerse Branding Migration

## Old Brand
PYQS Hub (also referred to as PYQS Website, PYQS AI Assistant, PYQs Hub)

## New Brand
**VidyarthiVerse** (Official spelling preserved: `VidyarthiVerse`)

## Logo
Official supplied VidyarthiVerse logo (`media_1790859796156.jpg`) containing the dark navy open-book symbol, gold/neutral sparkle, and VidyarthiVerse wordmark.

Generated branding assets:
- `www/assets/branding/vidyarthiverse-logo.png` (Full logo)
- `www/assets/branding/vidyarthiverse-logo-transparent.png` (Full logo with transparent background)
- `www/assets/branding/vidyarthiverse-icon.png` (Cropped book + sparkle symbol icon)
- `www/assets/branding/vidyarthiverse-icon-transparent.png` (Cropped symbol icon with transparent background)
- `www/favicon.ico`, `www/favicon.png`, `www/apple-touch-icon.png`

## Web
- **Header**: Main navigation header updated with official VidyarthiVerse logo (`.brand-logo-img`).
- **Footer**: Copyright text updated to `© VidyarthiVerse. All rights reserved.`.
- **Favicon**: Added high-resolution VidyarthiVerse book + sparkle favicon across all pages.
- **Metadata**: Meta title, description, and Open Graph attributes updated.
- **Titles**: Updated page titles (`VidyarthiVerse — Previous Year Question Papers`, `VidyarthiVerse — Study Resources`, `VidyarthiVerse — Live Exam Updates`, `VidyarthiVerse — AI Assistant`, `VidyarthiVerse — Papers`, `VidyarthiVerse — Login`, `VidyarthiVerse — Sign Up`, `VidyarthiVerse — Profile`).
- **Navigation**: Visible brand labels updated to VidyarthiVerse.
- **Page Branding**: Home, Login, Signup, Papers, PDF Viewer, Study Resources, Live Updates, AI Assistant, Contact, Profile, and Edit Profile screens updated.

## Android
- **App Label**: Android application label in `strings.xml` updated to `VidyarthiVerse`.
- **Launcher Icon**: Updated all mipmaps (`mipmap-mdpi`, `mipmap-hdpi`, `mipmap-xhdpi`, `mipmap-xxhdpi`, `mipmap-xxxhdpi`) for standard, round (`ic_launcher_round.png`), and adaptive (`ic_launcher_foreground.png`) launcher icons using the official book + sparkle symbol on clean background.
- **Splash Screen**: Updated all splash screen drawables (`drawable/splash.png`, `drawable-land-*/splash.png`, `drawable-port-*/splash.png`) with the official VidyarthiVerse logo on a clean background.
- **Recent Apps & System App Information**: Identified by system UI as `VidyarthiVerse`.

## AI Assistant
- Header, welcome message, assistant title (`VidyarthiVerse AI Assistant`), input placeholder, and authentication error banners updated.

## Live Updates
- Header, page title, and surrounding product descriptions updated to `VidyarthiVerse Live Updates`.

## Papers
- Header, page title, section headings, and PDF viewer header updated to `VidyarthiVerse Papers` / `VidyarthiVerse PDF Viewer`.

## Study Resources
- Page title, header, and resource section headings updated to `VidyarthiVerse Study Resources`.

## Technical Identifiers Preserved
- **Application ID / Package Namespace**: `com.pyqs.website` (Preserved to maintain Play Store identity, OAuth, and app update compatibility)
- **Firebase Project ID**: `pyqs-hub-43bed` (Preserved to avoid breaking Firebase Auth, Firestore, and Storage)
- **Firestore Collections & Schema**: `studyResources`, `papers`, `users`, `live_updates` (Preserved)
- **API Routes**: `/api/chat`, `/api/live-updates`, `/api/papers`, `/api/resources` (Preserved)
- **Environment Variables**: `FIREBASE_PROJECT_ID`, `GROQ_API_KEY`, etc. (Preserved)
- **Cloudinary Folder Structures**: Preserved
- **Backend Service Identifiers**: Internal service names preserved
- **Local Storage Identifiers**: `pyqs_session_id` preserved for backward session compatibility

## Remaining PYQS References
Every remaining reference in the repository was audited and classified:
1. `com.pyqs.website` in `build.gradle`, `AndroidManifest.xml`, `strings.xml`, `capacitor.config.json`, `MainActivity.java` -> Android Package ID (Preserved)
2. `pyqs-hub-43bed` in `firebase-config.js`, `.firebaserc`, `routes/papers.js`, `routes/studyResources.js` -> Firebase Project ID (Preserved)
3. `pyqs-website-mobile` in `package.json`, `package-lock.json` -> NPM package name (Preserved)
4. `pyqs_session_id` in `pdf-viewer-core.js` -> LocalStorage session key (Preserved for backward compatibility)
5. `pyqSpin` in `style.css` -> CSS animation keyframe name (Preserved)
6. `PYQS website/` & `mobile-migration/*.md` -> Historical project directory & documentation (Preserved)

## Test Results
- **Visual QA**: Pass
- **Android Build**: Pass (`BUILD SUCCESSFUL` in 28s)
- **Web Build**: Pass
- **Capacitor Sync**: Pass (`npx cap sync android` clean execution)
- **Regression Tests**: Pass (Firebase Auth, Firestore schemas, API endpoints, PDF viewer, view/download counters, SearXNG/TinyFish/Groq services intact)
