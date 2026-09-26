// ============================================================
// PYQs HUB — AUTHENTICATION
// LOGIN + SIGNUP + GOOGLE LOGIN
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
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


// ============================================================
// PAGE DETECTION
// ============================================================


// ============================================================
// ELEMENTS
// ============================================================

const loginForm =
    document.getElementById("loginForm");

const signupForm =
    document.getElementById("signupForm");

const googleLogin =
    document.getElementById("googleLogin");

const googleSignup =
    document.getElementById("googleSignup");

const authStatus =
    document.getElementById("authStatus");

const authButton =
    document.getElementById("authButton");

const forgotPassword =
    document.getElementById("forgotPassword");

let authRequestInProgress = false;


// ============================================================
// STATUS MESSAGE
// ============================================================

function showStatus(message) {

    if (authStatus) {
        authStatus.textContent = message;
    }

}


// ============================================================
// FIREBASE ERROR MESSAGE
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

        case "auth/cancelled-popup-request":
            return "A Google login is already in progress.";

        case "auth/operation-not-allowed":
            return "This sign-in method is disabled in Firebase Authentication.";

        case "auth/user-disabled":
            return "This account has been disabled.";

        case "auth/account-exists-with-different-credential":
            return "An account already exists with a different sign-in method.";

        case "auth/network-request-failed":
            return "Network error. Please check your internet.";

        case "auth/unauthorized-domain":
            return "This website domain is not authorized in Firebase. Add your Netlify domain in Firebase Authentication settings.";

        default:
            return error.message ||
                "Something went wrong. Please try again.";
    }

}


// ============================================================
// CREATE / UPDATE FIRESTORE USER PROFILE
// ============================================================

async function createUserProfile(
    user,
    name = ""
) {

    const userRef =
        doc(
            db,
            "users",
            user.uid
        );


    await setDoc(
        userRef,
        {
            uid: user.uid,

            name:
                name ||
                user.displayName ||
                "",

            email:
                user.email ||
                "",

            photoURL:
                user.photoURL ||
                "",

            createdAt:
                serverTimestamp(),

            updatedAt:
                serverTimestamp(),

            role: "user"
        },
        {
            merge: true
        }
    );

}

function setAuthBusy(isBusy) {

    authRequestInProgress = isBusy;

    const buttons = [
        loginForm?.querySelector('button[type="submit"]'),
        signupForm?.querySelector('button[type="submit"]'),
        googleLogin,
        googleSignup
    ];

    buttons.forEach((button) => {

        if (button) {
            button.disabled = isBusy;
        }

    });

}


// ============================================================
// EMAIL + PASSWORD SIGNUP
// ============================================================

if (signupForm) {

    signupForm.addEventListener(
        "submit",
        async function (event) {

            event.preventDefault();

            if (authRequestInProgress) {
                return;
            }


            const name =
                document
                    .getElementById("signupName")
                    .value
                    .trim();


            const email =
                document
                    .getElementById("signupEmail")
                    .value
                    .trim();


            const password =
                document
                    .getElementById("signupPassword")
                    .value;


            const confirmPassword =
                document
                    .getElementById(
                        "signupConfirmPassword"
                    )
                    .value;


            // ------------------------------------------------
            // CHECK PASSWORD
            // ------------------------------------------------

            if (password !== confirmPassword) {

                showStatus(
                    "Passwords do not match."
                );

                return;

            }


            if (password.length < 6) {

                showStatus(
                    "Password must be at least 6 characters."
                );

                return;

            }


            try {

                setAuthBusy(true);

                showStatus(
                    "Creating your account..."
                );


                // ------------------------------------------------
                // CREATE FIREBASE ACCOUNT
                // ------------------------------------------------

                const result =
                    await createUserWithEmailAndPassword(
                        auth,
                        email,
                        password
                    );


                // ------------------------------------------------
                // CREATE FIRESTORE PROFILE
                // ------------------------------------------------

                try {

                    await createUserProfile(
                        result.user,
                        name
                    );

                } catch (profileError) {

                    console.error(
                        "Signup profile error:",
                        profileError
                    );

                }


                showStatus(
                    "Account created successfully."
                );


                // ------------------------------------------------
                // GO TO HOME
                // ------------------------------------------------

                window.location.href =
                    "profile.html";


            } catch (error) {

                console.error(
                    "Signup error:",
                    error
                );


                showStatus(
                    getErrorMessage(error)
                );

            } finally {

                setAuthBusy(false);

            }

        }
    );

}


// ============================================================
// EMAIL + PASSWORD LOGIN
// ============================================================

if (loginForm) {

    loginForm.addEventListener(
        "submit",
        async function (event) {

            event.preventDefault();

            if (authRequestInProgress) {
                return;
            }


            const email =
                document
                    .getElementById("loginEmail")
                    .value
                    .trim();


            const password =
                document
                    .getElementById("loginPassword")
                    .value;


            try {

                setAuthBusy(true);

                showStatus(
                    "Logging in..."
                );


                await signInWithEmailAndPassword(
                    auth,
                    email,
                    password
                );


                showStatus(
                    "Login successful."
                );


                // ------------------------------------------------
                // GO TO HOME
                // ------------------------------------------------

                window.location.href =
                    "profile.html";


            } catch (error) {

                console.error(
                    "Login error:",
                    error
                );


                showStatus(
                    getErrorMessage(error)
                );

            } finally {

                setAuthBusy(false);

            }

        }
    );

}

if (forgotPassword) {
    forgotPassword.addEventListener("click", async () => {
        const emailInput =
            document.getElementById("loginEmail");

        const email = emailInput.value.trim();

        if (!email) {
            showStatus("Enter your email first to reset your password.");
            emailInput.focus();
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
}


// ============================================================
// GOOGLE LOGIN / SIGNUP
// ============================================================

async function googleAuthentication() {

    if (authRequestInProgress) {
        return;
    }

    try {

        setAuthBusy(true);

        showStatus(
            "Opening Google login..."
        );


        const result =
            await signInWithPopup(
                auth,
                googleProvider
            );


        // ------------------------------------------------
        // CREATE / UPDATE FIRESTORE PROFILE
        // ------------------------------------------------

        try {

            await createUserProfile(
                result.user
            );

        } catch (profileError) {

            console.error(
                "Google profile error:",
                profileError
            );

        }


        showStatus(
            "Google login successful."
        );


        // ------------------------------------------------
        // GO TO HOME
        // ------------------------------------------------

        window.location.href =
            "profile.html";


    } catch (error) {

        console.error(
            "Google authentication error:",
            error
        );


        showStatus(
            getErrorMessage(error)
        );

    } finally {

        setAuthBusy(false);

    }

}


// ============================================================
// GOOGLE LOGIN BUTTON
// ============================================================

if (googleLogin) {

    googleLogin.addEventListener(
        "click",
        googleAuthentication
    );

}


// ============================================================
// GOOGLE SIGNUP BUTTON
// ============================================================

if (googleSignup) {

    googleSignup.addEventListener(
        "click",
        googleAuthentication
    );

}


// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHTML(value) {

    return String(value)
        .replace(
            /[&<>"']/g,
            character => {

                const characters = {

                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#039;"

                };

                return characters[
                    character
                ];

            }
        );

}


// ============================================================
// PROFILE CIRCLE
// ============================================================

function updateProfileCircle(user) {

    const profileCircle =
        document.getElementById(
            "profileCircle"
        );


    if (!profileCircle) {
        return;
    }


    // --------------------------------------------------------
    // NOT LOGGED IN
    // --------------------------------------------------------

    if (!user) {

        profileCircle.style.display =
            "none";

        return;

    }


    // --------------------------------------------------------
    // LOGGED IN
    // --------------------------------------------------------

    profileCircle.style.display =
        "inline-flex";


    // --------------------------------------------------------
    // GOOGLE / PROFILE PHOTO
    // --------------------------------------------------------

    if (user.photoURL) {

        profileCircle.innerHTML = `

            <img
                src="${escapeHTML(user.photoURL)}"
                alt="Profile"
            >

        `;

        return;

    }


    // --------------------------------------------------------
    // NO PHOTO
    // SHOW FIRST LETTER
    // --------------------------------------------------------

    const name =
        user.displayName ||
        user.email ||
        "U";


    const firstLetter =
        name
            .trim()
            .charAt(0)
            .toUpperCase();


    profileCircle.innerHTML = `

        <span>
            ${escapeHTML(firstLetter)}
        </span>

    `;

}


// ============================================================
// AUTH STATE
// ============================================================



// ============================================================
// HOME PAGE AUTH MODAL
// ============================================================

const authModal =
    document.getElementById("authModal");

const closeAuthModal =
    document.getElementById("closeAuthModal");

const loginTab =
    document.getElementById("loginTab");

const signupTab =
    document.getElementById("signupTab");

const authModalTitle =
    document.getElementById("authModalTitle");

const switchToSignup =
    document.getElementById("switchToSignup");

const switchToLogin =
    document.getElementById("switchToLogin");


// ============================================================
// SHOW MODAL
// ============================================================

function showAuthModal() {

    if (!authModal) {
        return;
    }

    authModal.classList.add("show");

    authModal.setAttribute(
        "aria-hidden",
        "false"
    );

}


// ============================================================
// CLOSE MODAL
// ============================================================

function hideAuthModal() {

    if (!authModal) {
        return;
    }

    authModal.classList.remove("show");

    authModal.setAttribute(
        "aria-hidden",
        "true"
    );

}


// ============================================================
// CLOSE BUTTON
// ============================================================

if (closeAuthModal) {

    closeAuthModal.addEventListener(
        "click",
        hideAuthModal
    );

}


// ============================================================
// CLICK OUTSIDE MODAL
// ============================================================

if (authModal) {

    const overlay =
        authModal.querySelector(
            ".auth-modal-overlay"
        );

    if (overlay) {

        overlay.addEventListener(
            "click",
            hideAuthModal
        );

    }

}


// ============================================================
// ESC KEY
// ============================================================

document.addEventListener(
    "keydown",
    (event) => {

        if (
            event.key === "Escape" &&
            authModal &&
            authModal.classList.contains("show")
        ) {

            hideAuthModal();

        }

    }
);


// ============================================================
// LOGIN TAB
// ============================================================

if (loginTab) {

    loginTab.addEventListener(
        "click",
        () => {

            if (loginForm) {
                loginForm.style.display =
                    "grid";
            }

            if (signupForm) {
                signupForm.style.display =
                    "none";
            }

            loginTab.classList.add(
                "active"
            );

            signupTab.classList.remove(
                "active"
            );

            if (authModalTitle) {

                authModalTitle.textContent =
                    "Login to continue";

            }

            if (googleLogin) {

                googleLogin.textContent =
                    "Continue with Google";

            }

        }
    );

}


// ============================================================
// SIGNUP TAB
// ============================================================

if (signupTab) {

    signupTab.addEventListener(
        "click",
        () => {

            if (loginForm) {
                loginForm.style.display =
                    "none";
            }

            if (signupForm) {
                signupForm.style.display =
                    "grid";
            }

            signupTab.classList.add(
                "active"
            );

            loginTab.classList.remove(
                "active"
            );

            if (authModalTitle) {

                authModalTitle.textContent =
                    "Create your account";

            }

            if (googleLogin) {

                googleLogin.textContent =
                    "Sign up with Google";

            }

        }
    );

}

if (switchToSignup && signupTab) {
    switchToSignup.addEventListener("click", () => signupTab.click());
}

if (switchToLogin && loginTab) {
    switchToLogin.addEventListener("click", () => loginTab.click());
}


// ============================================================
// AUTH STATE — SHARED AUTH UI
// ============================================================

if (authButton && authModal) {
    authButton.addEventListener("click", (event) => {
        event.preventDefault();
        showAuthModal();
    });
}

onAuthStateChanged(auth, (user) => {
    const profileCircle =
        document.getElementById("profileCircle");

    if (user) {
        hideAuthModal();

        if (authButton) {
            authButton.style.display = "none";
        }

        if (profileCircle) {
            profileCircle.style.display = "inline-flex";
            updateProfileCircle(user);
        }

        return;
    }

    if (authButton) {
        authButton.style.display = "inline-flex";
    }

    if (profileCircle) {
        profileCircle.style.display = "none";
    }

    const isHomePage =
        window.location.pathname.endsWith("index.html") ||
        window.location.pathname === "/" ||
        window.location.pathname === "";

    if (isHomePage && authModal) {
        showAuthModal();
    }
});