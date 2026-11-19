// ============================================================
// VIDYARTHIASTRA — PROFILE PAGE
// Firebase Authentication + Firestore
// ============================================================

import { auth, db } from "./firebase.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    doc,
    getDoc
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { SkeletonManager } from "./skeleton-manager.js";
import {
    createProfileLoadController,
    PROFILE_STATES
} from "./profile-load-controller.js";

const profileCard = document.querySelector(".profile-card");
const initialProfileMarkup = profileCard?.innerHTML || "";
let profileSkeleton = null;

function getProfileElements() {
    return {
        content: profileCard?.querySelector("#profileContent"),
        status: profileCard?.querySelector("#profileStatus"),
        statusMessage: profileCard?.querySelector("#profileStatusMessage"),
        retryButton: profileCard?.querySelector("#profileRetryButton"),
        loginLink: profileCard?.querySelector("#profileLoginLink"),
        avatar: profileCard?.querySelector("#profileAvatar"),
        name: profileCard?.querySelector("#profileName"),
        email: profileCard?.querySelector("#profileEmail"),
        nameBox: profileCard?.querySelector("#profileNameBox"),
        emailBox: profileCard?.querySelector("#profileEmailBox")
    };
}

function restoreProfileMarkup() {
    if (profileCard) {
        profileCard.innerHTML = initialProfileMarkup;
    }
}

function getInitials(name, email) {
    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (normalizedName) {
        const words = normalizedName.split(/\s+/);
        return words.length > 1
            ? `${words[0].charAt(0)}${words[words.length - 1].charAt(0)}`.toUpperCase()
            : words[0].substring(0, 2).toUpperCase();
    }

    return typeof email === "string" && email.trim()
        ? email.trim().charAt(0).toUpperCase()
        : "U";
}

function profileText(value, fallback) {
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }
    if (typeof fallback === "string" && fallback.trim()) {
        return fallback.trim();
    }
    return "Not provided";
}

function displayProfile(user, data = {}) {
    const elements = getProfileElements();
    const name = profileText(data.name, user?.displayName);
    const email = profileText(data.email, user?.email);
    const photoURL = typeof data.photoURL === "string" && data.photoURL.trim()
        ? data.photoURL.trim()
        : (typeof user?.photoURL === "string" ? user.photoURL.trim() : "");

    if (elements.name) elements.name.textContent = name;
    if (elements.email) elements.email.textContent = email;
    if (elements.nameBox) elements.nameBox.textContent = name;
    if (elements.emailBox) elements.emailBox.textContent = email;

    if (!elements.avatar) return;

    let safePhotoURL = "";
    try {
        const parsedPhotoURL = new URL(photoURL);
        if (parsedPhotoURL.protocol === "https:") {
            safePhotoURL = parsedPhotoURL.href;
        }
    } catch {
        safePhotoURL = "";
    }

    if (safePhotoURL) {
        const image = document.createElement("img");
        image.src = safePhotoURL;
        image.alt = "Profile";
        image.loading = "lazy";
        image.addEventListener("error", () => {
            if (elements.avatar.contains(image)) {
                elements.avatar.textContent = getInitials(data.name || user?.displayName, data.email || user?.email);
            }
        });
        elements.avatar.replaceChildren(image);
    } else {
        elements.avatar.textContent = getInitials(data.name || user?.displayName, data.email || user?.email);
    }
}

function profileErrorMessage(state, errorCode) {
    if (state === PROFILE_STATES.NETWORK_ERROR) {
        return "Unable to load your profile. Check your connection and try again.";
    }
    if (state === PROFILE_STATES.QUOTA_ERROR) {
        return "Profile services are temporarily unavailable. Please try again shortly.";
    }
    if (state === PROFILE_STATES.AUTH_ERROR) {
        if (errorCode === "permission-denied") {
            return "You do not have permission to view this profile.";
        }
        if (errorCode === "unauthenticated" || errorCode === "auth/user-token-expired") {
            return "Your session has expired. Please sign in again.";
        }
        return "Unable to verify your session. Please sign in again.";
    }
    return "Something went wrong while loading your profile. Please try again.";
}

function renderProfileState(state, result = {}) {
    if (!profileCard) return;

    profileCard.dataset.profileState = state;

    if (state === PROFILE_STATES.INITIALIZING) return;

    if (state === PROFILE_STATES.AUTHENTICATING) {
        if (profileSkeleton) {
            profileSkeleton.cancel();
            profileSkeleton = null;
            restoreProfileMarkup();
        }
        return;
    }

    if (state === PROFILE_STATES.LOADING_PROFILE) {
        profileSkeleton = SkeletonManager.mount(
            profileCard,
            () => SkeletonManager.templates.profile(),
            { delay: 200, ariaLabel: "Loading student profile..." }
        );
        return;
    }

    if ([
        PROFILE_STATES.AUTH_ERROR,
        PROFILE_STATES.NETWORK_ERROR,
        PROFILE_STATES.QUOTA_ERROR,
        PROFILE_STATES.SERVER_ERROR
    ].includes(state)) {
        console.error("[Profile] Profile load failed.", {
            state,
            code: result.errorCode || "unknown"
        });
    }

    const currentSkeleton = profileSkeleton;
    profileSkeleton = null;
    const renderResult = () => {
        restoreProfileMarkup();
        profileCard.dataset.profileState = state;

        const elements = getProfileElements();
        const user = result.user || null;

        if (state === PROFILE_STATES.SUCCESS || state === PROFILE_STATES.EMPTY_PROFILE) {
            if (elements.content) elements.content.hidden = false;
            if (state === PROFILE_STATES.SUCCESS) {
                displayProfile(user, result.data);
            } else {
                displayProfile(user);
            }

            if (state === PROFILE_STATES.EMPTY_PROFILE && elements.statusMessage) {
                elements.statusMessage.textContent = "Your profile has not been set up yet. Complete your profile to continue.";
                if (elements.status) elements.status.hidden = false;
            }
            return;
        }

        if (elements.content) elements.content.hidden = true;
        if (elements.status) elements.status.hidden = false;
        if (elements.statusMessage) {
            elements.statusMessage.textContent = profileErrorMessage(state, result.errorCode);
        }
        if (elements.retryButton) {
            elements.retryButton.hidden = !profileLoader.canRetry();
        }
        if (elements.loginLink) {
            elements.loginLink.hidden = profileLoader.canRetry() && result.errorCode !== "unauthenticated";
        }
    };

    if (currentSkeleton) {
        currentSkeleton.dismiss(renderResult);
    } else {
        renderResult();
    }
}

const profileLoader = createProfileLoadController({
    readProfile: (uid) => getDoc(doc(db, "users", uid)),
    onState: renderProfileState,
    onUnauthenticated: () => {
        if (profileSkeleton) {
            profileSkeleton.cancel();
            profileSkeleton = null;
            restoreProfileMarkup();
        }
        window.location.replace("login.html");
    }
});

onAuthStateChanged(
    auth,
    (user) => {
        void profileLoader.onAuthState(user);
    },
    (error) => {
        profileLoader.onAuthError(error);
    }
);

if (profileCard) {
    profileCard.addEventListener("click", async (event) => {
        const action = event.target?.closest?.("#profileRetryButton, #logoutButton");
        if (!action || !profileCard.contains(action)) return;

        if (action.id === "profileRetryButton") {
            void profileLoader.retry();
            return;
        }

        if (action.id === "logoutButton") {
            try {
                action.disabled = true;
                action.textContent = "Logging out...";
                await signOut(auth);
                window.location.replace("index.html");
            } catch (error) {
                console.error("[Profile] Logout failed.", {
                    code: typeof error?.code === "string" ? error.code : "unknown"
                });
                action.disabled = false;
                action.textContent = "Logout";
            }
        }
    });
}
