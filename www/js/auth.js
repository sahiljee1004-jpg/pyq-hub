// ============================================================
// VIDYARTHIASTRA — AUTHENTICATION & GUEST ACCESS GUARD
// LOGIN + SIGNUP + GOOGLE LOGIN + CENTRALIZED AUTH MODAL
// FIREBASE AUTH + FIRESTORE USER PROFILE
// ============================================================

import {
    auth,
    db,
    googleProvider
} from "./firebase.js";

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signInWithPopup,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

// ============================================================
// AUTH STATE TRACKING & PROMISE RESOLUTION
// ============================================================

let isAuthResolved = false;
let currentAuthUser = null;
let resolveAuthReady;
const authReadyPromise = new Promise((resolve) => {
    resolveAuthReady = resolve;
});

// ============================================================
// STATUS MESSAGE
// ============================================================

function showStatus(message) {
    const authStatus = document.getElementById("authStatus");
    if (authStatus) {
        authStatus.textContent = message;
    }
}

// ============================================================
// FIREBASE ERROR MESSAGE TRANSLATION
// ============================================================

function getErrorMessage(error) {
    switch (error.code) {
        case "auth/invalid-credential":
            return "Incorrect email or password.";
        case "auth/invalid-email":
            return "Please enter a valid email address.";
        case "auth/user-not-found":
            return "No account found with this email.";
        case "auth/wrong-password":
            return "Incorrect password.";
        case "auth/email-already-in-use":
            return "An account already exists with this email.";
        case "auth/weak-password":
            return "Password must be at least 6 characters.";
        case "auth/too-many-requests":
            return "Too many attempts. Please try again later.";
        case "auth/popup-closed-by-user":
            return "Google login was cancelled.";
        case "auth/popup-blocked":
            return "Please allow popups for Google login.";
        case "auth/network-request-failed":
            return "Network error. Please check your internet.";
        default:
            return error.message || "Something went wrong. Please try again.";
    }
}

// ============================================================
// CREATE / UPDATE FIRESTORE USER PROFILE
// ============================================================

async function createUserProfile(user, name = "") {
    if (!db || !user || !user.uid) return;
    const userRef = doc(db, "users", user.uid);
    const existingProfile = await getDoc(userRef);
    const profileData = {
        uid: user.uid,
        name: name || user.displayName || "",
        email: user.email || "",
        photoURL: user.photoURL || "",
        updatedAt: serverTimestamp()
    };

    if (existingProfile.exists()) {
        await setDoc(userRef, profileData, { merge: true });
        return;
    }

    await setDoc(userRef, {
        ...profileData,
        createdAt: serverTimestamp(),
        role: "user"
    });
}

// ============================================================
// SAFE LOCAL REDIRECT VALIDATION (PREVENTS OPEN REDIRECTS)
// ============================================================

export function isSafeLocalRedirect(url) {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    // Block protocol-relative URLs (//evil.com), javascript:, data:, vbscript:
    if (trimmed.startsWith("//") || /^(?:javascript|data|vbscript):/i.test(trimmed)) {
        return false;
    }
    // Relative paths starting with /
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
        return true;
    }
    // Relative file paths like "mock-test.html" or "mock-test.html?test=123"
    if (/^[a-zA-Z0-9_\-\./]+\.html(?:[?#].*)?$/.test(trimmed) && !trimmed.includes("://")) {
        return true;
    }
    // Validate same-origin absolute URL
    try {
        const parsed = new URL(trimmed, window.location.origin);
        return parsed.origin === window.location.origin;
    } catch {
        return false;
    }
}

// ============================================================
// REDIRECT / POST-AUTH COMPLETION
// ============================================================

async function onAuthSuccess(user) {
    hideAuthModal();
    const currentUser = user || auth.currentUser;

    if (currentUser) {
        try {
            const token = await currentUser.getIdToken();
            const sessionRes = await fetch("/api/auth/session", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify({ idToken: token })
            });

            if (sessionRes.ok) {
                const sessionData = await sessionRes.json();
                if (sessionData.isAdmin === true || sessionData.role === "admin") {
                    // Admin verified: redirect directly to admin dashboard
                    sessionStorage.removeItem("adminBrowsingWebapp");
                    window.location.href = "admin.html";
                    return;
                }
            }
        } catch (err) {
            console.warn("[Auth] Server role verification notice:", err.message);
        }
    }

    const postLoginRedirect = sessionStorage.getItem("postLoginRedirect");
    if (postLoginRedirect && isSafeLocalRedirect(postLoginRedirect) && !postLoginRedirect.includes("admin.html")) {
        sessionStorage.removeItem("postLoginRedirect");
        const currentPath = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();
        const targetPath = (postLoginRedirect.split("?")[0].split("/").pop() || "index.html").toLowerCase();
        if (currentPath === targetPath) {
            // Already on the destination page: avoid disruptive page reload and allow smooth in-place auth transition
            return;
        }
        window.location.href = postLoginRedirect;
        return;
    }
    sessionStorage.removeItem("postLoginRedirect");

    const pathname = window.location.pathname.toLowerCase();
    const isAuthPage =
        pathname.endsWith("login.html") ||
        pathname.endsWith("signup.html") ||
        pathname.endsWith("index.html") ||
        pathname === "/" ||
        pathname === "";

    if (isAuthPage) {
        window.location.href = "profile.html";
    }
}

// ============================================================
// GOOGLE AUTHENTICATION
// ============================================================

async function googleAuthentication() {
    try {
        showStatus("Opening Google login...");
        const result = await signInWithPopup(auth, googleProvider);
        await createUserProfile(result.user);
        showStatus("Google login successful.");
        await onAuthSuccess(result.user);
    } catch (error) {
        console.error("Google authentication error:", error);
        showStatus(getErrorMessage(error));
    }
}

// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
        const characters = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        };
        return characters[character];
    });
}

// ============================================================
// PROFILE CIRCLE
// ============================================================

function updateProfileCircle(user) {
    const profileCircle = document.getElementById("profileCircle");
    if (!profileCircle) return;

    if (!user) {
        profileCircle.style.display = "none";
        return;
    }

    profileCircle.style.display = "inline-flex";

    if (user.photoURL) {
        profileCircle.innerHTML = `
            <img
                src="${escapeHTML(user.photoURL)}"
                alt="Profile"
            >
        `;
        return;
    }

    const name = user.displayName || user.email || "U";
    const firstLetter = name.trim().charAt(0).toUpperCase();

    profileCircle.innerHTML = `
        <span>
            ${escapeHTML(firstLetter)}
        </span>
    `;
}

// ============================================================
// DYNAMIC AUTH MODAL INJECTION & INITIALIZATION
// ============================================================

export function ensureAuthModal() {
    let modal = document.getElementById("authModal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "authModal";
        modal.className = "auth-modal";
        modal.setAttribute("aria-hidden", "true");
        modal.innerHTML = `
    <div class="auth-modal-overlay"></div>
    <div
        class="auth-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="authModalTitle"
    >
        <button
            type="button"
            id="closeAuthModal"
            class="auth-modal-close"
            aria-label="Close"
        >&times;</button>

        <div class="auth-modal-header">
            <p class="section-label">WELCOME TO VIDYARTHIASTRA</p>
            <h2 id="authModalTitle">Login to continue</h2>
            <p id="authModalSubtitle">Login or create an account to access this feature.</p>
        </div>

        <div class="auth-tabs">
            <button
                type="button"
                id="loginTab"
                class="auth-tab active"
            >Login</button>
            <button
                type="button"
                id="signupTab"
                class="auth-tab"
            >Sign Up</button>
        </div>

        <form id="loginForm" class="auth-modal-form">
            <label>
                Email
                <input
                    type="email"
                    id="loginEmail"
                    placeholder="Enter your email"
                    required
                >
            </label>
            <label>
                Password
                <input
                    type="password"
                    id="loginPassword"
                    placeholder="Enter your password"
                    required
                >
                <button
                    type="button"
                    id="forgotPassword"
                    class="forgot-password"
                >Forgot password?</button>
            </label>
            <button
                type="submit"
                class="primary-btn"
            >Login</button>
        </form>

        <p class="auth-switch modal-auth-switch" id="loginSwitchContainer">
            Don't have an account?
            <button type="button" id="switchToSignup">Sign up</button>
        </p>

        <form
            id="signupForm"
            class="auth-modal-form"
            style="display:none;"
        >
            <label>
                Full Name
                <input
                    type="text"
                    id="signupName"
                    placeholder="Enter your name"
                    required
                >
            </label>
            <label>
                Email
                <input
                    type="email"
                    id="signupEmail"
                    placeholder="Enter your email"
                    required
                >
            </label>
            <label>
                Password
                <input
                    type="password"
                    id="signupPassword"
                    placeholder="Create a password"
                    required
                >
            </label>
            <label>
                Confirm Password
                <input
                    type="password"
                    id="signupConfirmPassword"
                    placeholder="Confirm your password"
                    required
                >
            </label>
            <button
                type="submit"
                class="primary-btn"
            >Create Account</button>
        </form>

        <p class="auth-switch modal-auth-switch" id="signupSwitchContainer" style="display:none;">
            Already have an account?
            <button type="button" id="switchToLogin">Login</button>
        </p>

        <div class="auth-divider">
            <span>OR</span>
        </div>

        <button
            type="button"
            id="googleLogin"
            class="google-btn"
        >Continue with Google</button>

        <p id="authStatus" class="status"></p>

        <p class="auth-modal-note">
            You can close this window and continue browsing.
        </p>
    </div>`;
        document.body.appendChild(modal);
    }

    initModalEvents(modal);
    return modal;
}

function initModalEvents(modal) {
    if (!modal || modal.dataset.authEventsBound === "true") return;
    modal.dataset.authEventsBound = "true";

    const closeBtn = modal.querySelector("#closeAuthModal");
    const overlay = modal.querySelector(".auth-modal-overlay");
    const loginTab = modal.querySelector("#loginTab");
    const signupTab = modal.querySelector("#signupTab");
    const switchToSignup = modal.querySelector("#switchToSignup");
    const switchToLogin = modal.querySelector("#switchToLogin");
    const loginForm = modal.querySelector("#loginForm");
    const signupForm = modal.querySelector("#signupForm");
    const googleLogin = modal.querySelector("#googleLogin");
    const forgotPassword = modal.querySelector("#forgotPassword");
    const authModalTitle = modal.querySelector("#authModalTitle");
    const loginSwitchContainer = modal.querySelector("#loginSwitchContainer");
    const signupSwitchContainer = modal.querySelector("#signupSwitchContainer");

    // Close Button & Overlay
    closeBtn?.addEventListener("click", hideAuthModal);
    overlay?.addEventListener("click", hideAuthModal);

    // Switch to Login Tab
    const activateLoginTab = () => {
        if (loginForm) loginForm.style.display = "grid";
        if (signupForm) signupForm.style.display = "none";
        if (loginSwitchContainer) loginSwitchContainer.style.display = "block";
        if (signupSwitchContainer) signupSwitchContainer.style.display = "none";
        loginTab?.classList.add("active");
        signupTab?.classList.remove("active");
        if (authModalTitle && !modal.dataset.customTitle) authModalTitle.textContent = "Login to continue";
        if (googleLogin) googleLogin.textContent = "Continue with Google";
        showStatus("");
    };

    // Switch to Signup Tab
    const activateSignupTab = () => {
        if (loginForm) loginForm.style.display = "none";
        if (signupForm) signupForm.style.display = "grid";
        if (loginSwitchContainer) loginSwitchContainer.style.display = "none";
        if (signupSwitchContainer) signupSwitchContainer.style.display = "block";
        signupTab?.classList.add("active");
        loginTab?.classList.remove("active");
        if (authModalTitle && !modal.dataset.customTitle) authModalTitle.textContent = "Create your account";
        if (googleLogin) googleLogin.textContent = "Sign up with Google";
        showStatus("");
    };

    loginTab?.addEventListener("click", activateLoginTab);
    signupTab?.addEventListener("click", activateSignupTab);
    switchToSignup?.addEventListener("click", activateSignupTab);
    switchToLogin?.addEventListener("click", activateLoginTab);

    // Login Form Submit
    loginForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const email = document.getElementById("loginEmail")?.value.trim() || "";
        const password = document.getElementById("loginPassword")?.value || "";

        try {
            showStatus("Logging in...");
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            showStatus("Login successful.");
            await onAuthSuccess(userCredential.user);
        } catch (error) {
            console.error("Login error:", error);
            showStatus(getErrorMessage(error));
        }
    });

    // Signup Form Submit
    signupForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = document.getElementById("signupName")?.value.trim() || "";
        const email = document.getElementById("signupEmail")?.value.trim() || "";
        const password = document.getElementById("signupPassword")?.value || "";
        const confirmPassword = document.getElementById("signupConfirmPassword")?.value || "";

        if (password !== confirmPassword) {
            showStatus("Passwords do not match.");
            return;
        }

        if (password.length < 6) {
            showStatus("Password must be at least 6 characters.");
            return;
        }

        try {
            showStatus("Creating your account...");
            const result = await createUserWithEmailAndPassword(auth, email, password);
            await createUserProfile(result.user, name);
            showStatus("Account created successfully.");
            await onAuthSuccess(result.user);
        } catch (error) {
            console.error("Signup error:", error);
            showStatus(getErrorMessage(error));
        }
    });

    // Forgot Password
    forgotPassword?.addEventListener("click", async () => {
        const emailInput = document.getElementById("loginEmail");
        const email = emailInput?.value.trim();

        if (!email) {
            showStatus("Enter your email first to reset your password.");
            emailInput?.focus();
            return;
        }

        try {
            showStatus("Sending password reset email...");
            await sendPasswordResetEmail(auth, email);
            showStatus("Password reset email sent. Check your inbox.");
        } catch (error) {
            console.error("Password reset error:", error);
            showStatus(getErrorMessage(error));
        }
    });

    // Google Login
    googleLogin?.addEventListener("click", googleAuthentication);
}

// ============================================================
// SHOW / HIDE MODAL
// ============================================================

export function showAuthModal(options = {}) {
    const modal = ensureAuthModal();
    if (!modal) return;

    const authModalTitle = modal.querySelector("#authModalTitle");
    const authModalSubtitle = modal.querySelector("#authModalSubtitle") || modal.querySelector(".auth-modal-header p:last-child");

    if (options.title && authModalTitle) {
        modal.dataset.customTitle = "true";
        authModalTitle.textContent = options.title;
    }
    if (options.message && authModalSubtitle) {
        modal.dataset.customMessage = "true";
        authModalSubtitle.textContent = options.message;
    }
    if (options.postLoginRedirect && isSafeLocalRedirect(options.postLoginRedirect)) {
        sessionStorage.setItem("postLoginRedirect", options.postLoginRedirect);
    }
    if (options.defaultTab === "signup") {
        modal.querySelector("#signupTab")?.click();
    } else if (options.defaultTab === "login") {
        modal.querySelector("#loginTab")?.click();
    }

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    document.body.classList.add("auth-modal-open");
    document.documentElement.classList.add("auth-modal-open");

    if (window.scrollX !== 0) {
        window.scrollTo(0, window.scrollY);
    }

    const emailInput = document.getElementById("loginEmail");
    if (emailInput) {
        setTimeout(() => emailInput.focus(), 60);
    }
}

export function hideAuthModal() {
    const modal = document.getElementById("authModal");
    if (!modal) return;

    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");

    if (modal.dataset.customTitle) {
        delete modal.dataset.customTitle;
        const titleEl = modal.querySelector("#authModalTitle");
        if (titleEl) titleEl.textContent = "Login to continue";
    }
    if (modal.dataset.customMessage) {
        delete modal.dataset.customMessage;
        const subEl = modal.querySelector("#authModalSubtitle") || modal.querySelector(".auth-modal-header p:last-child");
        if (subEl) subEl.textContent = "Login or create an account to access this feature.";
    }

    document.body.classList.remove("auth-modal-open");
    document.documentElement.classList.remove("auth-modal-open");
}

// ============================================================
// ESC KEY LISTENER FOR MODAL
// ============================================================

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        const modal = document.getElementById("authModal");
        if (modal && modal.classList.contains("show")) {
            hideAuthModal();
        }
    }
});

// ============================================================
// AUTH STATE & NAVIGATION UI SYNC
// ============================================================

export function updateNavigationAuthState(user) {
    const authButton = document.getElementById("authButton");
    const profileCircle = document.getElementById("profileCircle");
    const modal = document.getElementById("authModal");

    if (user) {
        if (modal && modal.classList.contains("show")) {
            hideAuthModal();
        }

        if (authButton) {
            authButton.style.setProperty("display", "none", "important");
        }

        if (profileCircle) {
            profileCircle.style.setProperty("display", "inline-flex", "important");
            updateProfileCircle(user);
        }
    } else {
        if (profileCircle) {
            profileCircle.style.setProperty("display", "none", "important");
        }

        if (authButton) {
            authButton.style.setProperty("display", "inline-flex", "important");
        }
    }
}

onAuthStateChanged(auth, async (user) => {
    isAuthResolved = true;
    currentAuthUser = user;
    if (resolveAuthReady) {
        resolveAuthReady(user);
    }
    updateNavigationAuthState(user);

    // If an active session is restored on dedicated login/signup page:
    if (user) {
        const pathname = window.location.pathname.toLowerCase();
        const isDedicatedAuthPage = pathname.endsWith("login.html") || pathname.endsWith("signup.html");
        if (isDedicatedAuthPage && sessionStorage.getItem("adminBrowsingWebapp") !== "true") {
            await onAuthSuccess(user);
        }
    }
});

// ============================================================
// CENTRALIZED GUEST AUTHENTICATION GUARD
// ============================================================
// Guests are prompted with the auth modal when clicking any protected
// action button.
// STRICT EXCEPTION: PYQ paper viewing (.view-paper-btn and all controls
// inside #paperViewer / .pdf-viewer) remains 100% accessible to guests!
// ============================================================
// PROTECTED FEATURE NAVIGATION HELPER
// Identifies if a click targets Study Resources, Live Updates, or AI Assistant
// ============================================================

function getProtectedNavigationTarget(target) {
    if (!target) return null;

    // A. Floating ChatGPT / AI Assistant shortcut button or locked screen triggers
    const chatBtn = target.closest("#chatgptFloatingBtn, .floating-chatbot-btn, #askGptLockedBtn");
    if (chatBtn) {
        return {
            element: chatBtn,
            destination: "ai-chat.html"
        };
    }

    // B. Navigation anchors leading to Study Resources, Live Updates, or AI Assistant
    const anchor = target.closest("a");
    if (anchor) {
        const rawHref = anchor.getAttribute("href") || "";
        if (!rawHref || rawHref === "#" || rawHref.startsWith("javascript:")) {
            if (anchor.hasAttribute("data-requires-auth")) {
                return { element: anchor, destination: null };
            }
            return null;
        }

        const cleanHref = rawHref.split("?")[0].split("#")[0].toLowerCase().trim();
        if (
            cleanHref === "study-resources.html" ||
            cleanHref.endsWith("/study-resources.html") ||
            cleanHref === "live-updates.html" ||
            cleanHref.endsWith("/live-updates.html") ||
            cleanHref === "ai-chat.html" ||
            cleanHref.endsWith("/ai-chat.html") ||
            cleanHref === "admin.html" ||
            cleanHref.endsWith("/admin.html")
        ) {
            return {
                element: anchor,
                destination: anchor.href || rawHref
            };
        }
    }

    return null;
}

function setupGuestGuard() {
    document.addEventListener(
        "click",
        async (event) => {
            const target = event.target;
            if (!target) return;

            // 1. NEVER intercept inside the auth modal
            if (target.closest("#authModal, .auth-modal")) {
                return;
            }

            // 2. Explicit auth trigger button: let authButton open modal naturally
            if (target.closest("#authButton")) {
                event.preventDefault();
                sessionStorage.removeItem("postLoginRedirect");
                showAuthModal();
                return;
            }

            // Admission enquiries are public and do not require a signed-in account.
            if (target.closest("[data-open-counselling], #counsellingDialog")) {
                return;
            }

            // 3. Dedicated auth pages and admin dashboard do not require guest interception
            const pathname = window.location.pathname.toLowerCase();
            if (
                pathname.endsWith("login.html") ||
                pathname.endsWith("signup.html") ||
                pathname.includes("admin") ||
                target.closest(".admin-page, #adminDashboardView, .admin-modal, .admin-card")
            ) {
                return;
            }

            // 4. THE PYQ PAPER VIEWING EXCEPTION:
            // A. "View PDF" button on PYQ question papers
            if (target.closest(".view-paper-btn")) {
                return;
            }
            // B. PDF Viewer modal controls (zoom in/out/fit, close viewer, open original, retry, fallback, canvas, gestures)
            if (target.closest("#paperViewer, .pdf-viewer")) {
                return;
            }

            // 5. PROTECTED FEATURE NAVIGATION:
            // Intercept guest navigation clicks leading to Study Resources, Live Updates, or AI Assistant
            const protectedNav = getProtectedNavigationTarget(target);
            if (protectedNav) {
                // If user is already confirmed authenticated, allow normal navigation
                if (currentAuthUser) {
                    return;
                }

                // Block immediate navigation for unauthenticated / pending users
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                // Wait if Firebase auth state is still initializing
                if (!isAuthResolved) {
                    try {
                        const user = await authReadyPromise;
                        if (user) {
                            if (protectedNav.destination) {
                                window.location.href = protectedNav.destination;
                            } else if (typeof protectedNav.element.click === "function") {
                                protectedNav.element.click();
                            }
                            return;
                        }
                    } catch (e) {}
                }

                // User is a confirmed guest: save intended destination and show login modal
                if (protectedNav.destination) {
                    sessionStorage.setItem("postLoginRedirect", protectedNav.destination);
                }
                showAuthModal();
                return;
            }

            // 6. Standard navigation:
            // A. Links: ordinary page links or hash anchors (unless explicitly tagged data-requires-auth)
            const anchor = target.closest("a");
            if (anchor && !anchor.hasAttribute("data-requires-auth")) {
                const href = anchor.getAttribute("href") || "";
                if (href && href !== "#" && !href.startsWith("javascript:")) {
                    return;
                }
                if (anchor.classList.contains("back-link") || anchor.id === "backLink") {
                    return;
                }
            }

            // B. Navigational back buttons and mobile menu toggle
            if (target.closest("#backBtn, .back-link, .live-back-btn, .ai-back-btn, #menuToggle, .menu-toggle, .nav-toggle, #themeToggle")) {
                return;
            }

            // C. Catalog hierarchy navigation cards on study-resources (Exams, Subjects, Chapters)
            if (target.closest(".study-card, .year-card, .exam-card")) {
                return;
            }

            // Non-protected mock-test controls: catalog retry, cancel/confirm modals, session resume
            if (target.closest("#btnRetryCatalog, #btnResumeSession, #langModalBtnCancel, #langModalBtnConfirm, #modalBtnCancel, #modalBtnConfirm, .modal-overlay, #languageModal, #submitModal, #sessionExpiryModal")) {
                return;
            }

            // Mock-test attempt trigger (.btn-start-test):
            const mockStartBtn = target.closest(".btn-start-test");
            if (mockStartBtn) {
                if (currentAuthUser) {
                    return; // Authenticated student proceeds
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                const testId = mockStartBtn.getAttribute("data-testid");

                if (!isAuthResolved) {
                    try {
                        const user = await authReadyPromise;
                        if (user) {
                            if (typeof mockStartBtn.click === "function") {
                                mockStartBtn.click();
                            }
                            return;
                        }
                    } catch (e) {}
                }

                if (testId) {
                    sessionStorage.setItem("pendingMockTestId", testId);
                    sessionStorage.setItem("postLoginRedirect", `mock-test.html?test=${encodeURIComponent(testId)}`);
                }

                showAuthModal({
                    title: "Sign in to Attempt Mock Test",
                    message: "Create a free VidyarthiAstra account or log in to attempt this mock test. Your progress and results can then be saved to your account.",
                    postLoginRedirect: testId ? `mock-test.html?test=${encodeURIComponent(testId)}` : "mock-test.html"
                });
                return;
            }

            // 7. Check for protected or actionable controls:
            // A. Explicit protected buttons/targets:
            const isExplicitProtected = target.closest(
                ".download-paper-btn, .view-note-btn, .download-note-btn, " +
                "#searchBtn, #sendButton, #clearChatBtn, .ai-suggestion-chip, #askGptLockedBtn, " +
                "#chatgptFloatingBtn, #seedStudyCatalog, #importLegacyResources, " +
                ".study-admin-form button, .contact-form button, [data-requires-auth='true']"
            );

            // B. General button elements:
            const button = target.closest("button, [role='button'], .btn");

            // If it's neither an explicit protected target nor an actionable button, don't intercept
            if (!isExplicitProtected && !button) {
                return;
            }

            // If user is confirmed authenticated, allow action
            if (currentAuthUser) {
                return;
            }

            // Intercept action for unauthenticated user
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            // If Firebase auth is still restoring session, wait
            if (!isAuthResolved) {
                try {
                    const user = await authReadyPromise;
                    if (user) {
                        const actionableEl = isExplicitProtected || button;
                        if (actionableEl && typeof actionableEl.click === "function") {
                            actionableEl.click();
                        }
                        return;
                    }
                } catch (e) {}
            }

            // Show login popup
            showAuthModal();
        },
        true
    );

    // Intercept Enter key submissions on inputs requiring auth
    document.addEventListener(
        "keydown",
        async (event) => {
            if (event.key !== "Enter") return;
            const target = event.target;
            if (!target) return;

            const isLiveSearch = target.id === "searchInput" && window.location.pathname.includes("live-updates");
            const isAiInput = target.id === "messageInput" && window.location.pathname.includes("ai-chat");

            if (!isLiveSearch && !isAiInput) return;
            if (currentAuthUser) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            if (!isAuthResolved) {
                try {
                    const user = await authReadyPromise;
                    if (user) {
                        if (isLiveSearch) {
                            document.getElementById("searchBtn")?.click();
                        } else if (isAiInput) {
                            document.getElementById("sendButton")?.click();
                        }
                        return;
                    }
                } catch (e) {}
            }

            showAuthModal();
        },
        true
    );
}

// ============================================================
// INITIALIZATION
// ============================================================

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        ensureAuthModal();
        setupGuestGuard();
    });
} else {
    ensureAuthModal();
    setupGuestGuard();
}

// Expose modal functions to window for global access
if (typeof window !== "undefined") {
    window.showAuthModal = showAuthModal;
    window.hideAuthModal = hideAuthModal;
    window.ensureAuthModal = ensureAuthModal;
    window.isSafeLocalRedirect = isSafeLocalRedirect;
}