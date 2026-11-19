# VidyarthiVerse — Project Audit Report

## 1. Overview
This audit inspects every file in the VidyarthiVerse repository to prepare for native Android mobile migration using Capacitor.

## 2. Directory Structure Audit
Original Source Path: `PYQS website/`
```text
PYQS website/
├── assets/                  (Directory for static images/icons)
├── css/
│   ├── papers.css          (Styles for Question Papers list and PDF modal viewer)
│   └── style.css           (Global styles, typography, layout, modal, card, forms)
├── js/
│   ├── auth.js             (Auth logic: email/pass login & signup, Google login, modal toggle, auth state listener)
│   ├── contact.js          (Contact form logic, Firestore `contacts` collection write, WhatsApp redirect)
│   ├── edit-profile.js     (Edit Profile form, Auth displayName & Firestore `users` doc update)
│   ├── exam.js             (Exam details loader, fetch `exams/{id}/years` from Firestore)
│   ├── firebase-config.js  (Firebase SDK 12.1.0 initialization: app, auth, db, googleProvider)
│   ├── firebase.js         (Re-export module for firebase-config)
│   ├── header.js           (Header navigation auth button & profile avatar state management)
│   ├── home.js             (Homepage exam library fetch from Firestore `exams`, client-side search)
│   ├── papers.js           (Question Papers list fetch from `exams/{exam}/years/{year}/papers`, iframe PDF viewer & download)
│   └── profile.js          (User profile view, fetch Firestore `users/{uid}`, logout logic)
├── contact.html            (Contact page markup with WhatsApp submission form)
├── edit-profile.html       (Edit profile markup with full name input)
├── exam.html               (Exam details & year selection markup)
├── index.html              (Homepage with search, exam library grid, and login/signup auth modal)
├── login.html              (Standalone login page)
├── papers.html             (Question papers list & embedded iframe PDF viewer modal)
├── profile.html            (User profile page with internal `<style>` block for mobile responsive avatar/grid)
└── signup.html             (Standalone signup page)
```

---

## 3. Page-by-Page Audit

### `index.html`
* **Purpose**: Main landing page with hero banner, search bar, exam list grid, header nav, and login/signup modal.
* **HTML Structure**: Semantic `<header>`, `<main>`, `<section class="hero">`, `<section class="exams-section">`, `<footer>`, `#authModal`.
* **CSS Dependencies**: `css/style.css`.
* **JS Dependencies**: `js/auth.js` (module), `js/home.js` (module).
* **Navigation Links**: `contact.html`, `login.html`, `profile.html`, `exam.html?id=...`.
* **Firebase Dependencies**: Firebase Auth (`onAuthStateChanged`), Firestore (`exams` collection).
* **Mobile UI Audit Findings**:
  - Grid is fixed-column responsive with minimal breakpoints.
  - Search box button and input need touch-friendly sizing and mobile spacing.
  - Auth modal overlay needs safe touch-outside and mobile full-width scaling.

### `login.html`
* **Purpose**: Standalone email/password & Google login screen.
* **HTML Structure**: `<main class="auth-page">`, `<section class="auth-card">`, form with email, password, forgot password button, Google login button, links to signup and home.
* **CSS Dependencies**: `css/style.css`.
* **JS Dependencies**: `js/auth.js` (module).
* **Navigation Links**: `index.html`, `signup.html`.
* **Firebase Dependencies**: `signInWithEmailAndPassword`, `sendPasswordResetEmail`, `signInWithPopup(googleProvider)`.
* **Mobile UI Audit Findings**:
  - Card width is suitable; form inputs need touch padding and clear tap feedback.
  - Google popup authentication inside WebView requires fallbacks (Google Auth plugin or browser redirect) since `signInWithPopup` is frequently blocked in native WebViews.

### `signup.html`
* **Purpose**: Standalone account registration screen.
* **HTML Structure**: Form with Name, Email, Password, Confirm Password, Google signup button, links to login and home.
* **CSS Dependencies**: `css/style.css`.
* **JS Dependencies**: `js/auth.js` (module).
* **Navigation Links**: `index.html`, `login.html`.
* **Firebase Dependencies**: `createUserWithEmailAndPassword`, Firestore `setDoc(users/{uid})`.
* **Mobile UI Audit Findings**:
  - Validation feedback text requires padding and clear visibility on mobile screens.

### `exam.html`
* **Purpose**: Displays exam title, icon, description, and available years list.
* **HTML Structure**: Header nav, back link, exam title container, year selection grid, footer.
* **CSS Dependencies**: `css/style.css`.
* **JS Dependencies**: `js/auth.js` (module), `js/exam.js` (module).
* **Navigation Links**: `index.html`, `papers.html?exam=...&year=...`.
* **Firebase Dependencies**: Firestore `doc(exams/{id})`, `collection(exams/{id}/years)`.
* **Mobile UI Audit Findings**:
  - Year grid buttons need mobile grid touch spacing.

### `papers.html`
* **Purpose**: Displays list of question papers with "View PDF" and "Download" buttons, plus embedded PDF modal iframe viewer.
* **HTML Structure**: Header nav, back link, hero info, paper card list, `#paperViewer` modal with iframe, footer.
* **CSS Dependencies**: `css/style.css`, `css/papers.css`.
* **JS Dependencies**: `js/auth.js` (module), `js/papers.js` (module).
* **Navigation Links**: `exam.html?id=...`.
* **Firebase Dependencies**: Firestore `exams/{exam}/years/{year}/papers`.
* **Mobile UI Audit Findings**:
  - `<iframe>` PDF viewer inside webview may not render inline PDF files on native Android WebViews standardly. Needs fallback to external browser view or Capacitor Browser plugin.
  - Paper cards action buttons ("View PDF", "Download") need responsive stacking on small screen devices.

### `profile.html`
* **Purpose**: Displays user details, avatar (photo or initials), name, email, account type, and edit/logout buttons.
* **HTML Structure**: Site header, profile card, avatar container, info grid boxes, action buttons.
* **CSS Dependencies**: `css/style.css`, inline `<style>` block.
* **JS Dependencies**: `js/profile.js` (module).
* **Navigation Links**: `index.html`, `contact.html`, `edit-profile.html`, `login.html`.
* **Firebase Dependencies**: Firebase Auth (`onAuthStateChanged`, `signOut`), Firestore `doc(users/{uid})`.
* **Mobile UI Audit Findings**:
  - Has custom inline mobile CSS (`@media (max-width: 750px)`), which handles avatar sizing and grid column collapse well.

### `edit-profile.html`
* **Purpose**: Form to edit full name and update avatar/profile details.
* **HTML Structure**: Site header, edit profile card, form with full name input, disabled email input, save/cancel buttons.
* **CSS Dependencies**: `css/style.css`.
* **JS Dependencies**: `js/edit-profile.js` (module).
* **Navigation Links**: `index.html`, `contact.html`, `profile.html`.
* **Firebase Dependencies**: Firebase Auth `updateProfile`, Firestore `setDoc(users/{uid})`.
* **Mobile UI Audit Findings**:
  - Form layout is responsive; needs touch padding for mobile keyboard interactions.

### `contact.html`
* **Purpose**: Contact form to send messages saved to Firestore and redirected to WhatsApp.
* **HTML Structure**: Site header, contact card form (Name, Email, Message), submit button ("Send on WhatsApp"), status text.
* **CSS Dependencies**: `css/style.css`.
* **JS Dependencies**: `js/auth.js` (module), `js/contact.js` (module).
* **Navigation Links**: `index.html`, `profile.html`.
* **Firebase Dependencies**: Firestore `addDoc(collection(db, "contacts"))`.
* **Mobile UI Audit Findings**:
  - WhatsApp redirect uses `https://wa.me/916299890944?text=...` which seamlessly opens the WhatsApp native Android app or browser.

---

## 4. CSS & Styling Audit
* Global CSS (`style.css`): Lacks explicit `@media` breakpoints for small screens (<480px and 480px-768px). Fixed container paddings and header layouts need enhancement for mobile viewports and native safe area insets (top status bar / bottom gesture bar).
* `papers.css`: Flexible card layout; requires responsive button wrapping for small mobile screens.

---

## 5. JavaScript & Logic Audit
* Firebase Web SDK 12.1.0 loaded via ES Modules directly from Google CDN (`https://www.gstatic.com/firebasejs/12.1.0/...`).
* Capacitor webapps run locally from `file://` or `http://localhost`. ES Module imports from CDN work when device has active internet access.
* Auth Persistence: Firebase Web SDK defaults to `indexedDB` / `localStorage` persistence, which works seamlessly in Capacitor Android WebView.

---

## 6. Audit Conclusion
The codebase is clean, well-structured Vanilla HTML/CSS/JS with ES Module Firebase integration. Capacitor 6+ is the ideal framework for wrapping this application into a native Android app while keeping 100% of the existing code intact.
