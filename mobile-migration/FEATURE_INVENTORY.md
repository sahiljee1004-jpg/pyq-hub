# VidyarthiVerse — Feature Inventory

This inventory tracks all features identified in the PYQS website codebase, mapping them to mobile screens, dependencies, and migration status.

| # | Feature Name | Original HTML Page | Original JS Module | Backend / Firebase Dependency | Mobile Screen / View | Migration Status | Known Risks / Notes |
|---|---|---|---|---|---|---|---|
| 1 | **Homepage & Exam Library** | `index.html` | `js/home.js` | Firestore (`exams` collection) | `HomeScreen` (`index.html`) | Completed | Responsive grid layout & search touch targets updated |
| 2 | **Client-Side Exam Search** | `index.html` | `js/home.js` | In-memory filtering of Firestore exams | `HomeScreen` (`index.html`) | Completed | Smooth keyboard input behavior verified |
| 3 | **Login Modal & Page** | `index.html`, `login.html` | `js/auth.js` | Firebase Auth (`signInWithEmailAndPassword`) | `LoginScreen` / `AuthModal` | Completed | Natively supported in Capacitor WebView |
| 4 | **Google OAuth Sign-In** | `index.html`, `login.html`, `signup.html` | `js/auth.js` | Firebase Auth (`signInWithPopup`, `googleProvider`) | `AuthModal` / `LoginScreen` | Completed | Web SDK popup supported with direct auth fallback |
| 5 | **Password Reset** | `login.html`, `index.html` modal | `js/auth.js` | Firebase Auth (`sendPasswordResetEmail`) | `LoginScreen` / `AuthModal` | Completed | Sends email directly via Firebase Auth |
| 6 | **Sign Up & Account Creation** | `signup.html`, `index.html` modal | `js/auth.js` | Firebase Auth (`createUserWithEmailAndPassword`), Firestore `users/{uid}` | `SignupScreen` / `AuthModal` | Completed | Auto-creates Firestore profile document |
| 7 | **User Profile View** | `profile.html` | `js/profile.js` | Firebase Auth (`onAuthStateChanged`, `signOut`), Firestore `users/{uid}` | `ProfileScreen` (`profile.html`) | Completed | Displays user name, email, avatar photo or initials |
| 8 | **Edit Profile** | `edit-profile.html` | `js/edit-profile.js` | Firebase Auth (`updateProfile`), Firestore `users/{uid}` | `EditProfileScreen` (`edit-profile.html`) | Completed | Updates full name in Auth & Firestore |
| 9 | **Exam Details & Years List** | `exam.html` | `js/exam.js` | Firestore (`exams/{id}` & `exams/{id}/years`) | `ExamScreen` (`exam.html?id=...`) | Completed | Displays years available for selected exam (e.g., JEE Main 2026, 2025) |
| 10 | **Question Papers List** | `papers.html` | `js/papers.js` | Firestore (`exams/{exam}/years/{year}/papers`) | `PapersScreen` (`papers.html?exam=...&year=...`) | Completed | Displays list of papers, dates, shifts, and subjects |
| 11 | **In-App PDF Viewer** | `papers.html` | `js/papers.js` | Embedded `<iframe>` | `PapersScreen` (`#paperViewer`) | Completed | Fullscreen mobile overlay with fallback to external browser |
| 12 | **PDF Download** | `papers.html` | `js/papers.js` | Blob fetch & browser download trigger | `PapersScreen` | Completed | Direct blob fetch download supported |
| 13 | **Contact & WhatsApp Integration** | `contact.html` | `js/contact.js` | Firestore (`contacts` collection), WhatsApp API (`wa.me`) | `ContactScreen` (`contact.html`) | Completed | Launches native WhatsApp app via `wa.me` intent on Android |
| 14 | **Site Header Navigation & Auth State Sync** | Shared HTML Headers | `js/header.js`, `js/auth.js` | Firebase Auth (`onAuthStateChanged`) | Shared App Header / Bottom Bar | Completed | Toggle login button / profile avatar dynamically across all pages |
