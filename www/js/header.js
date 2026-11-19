import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { updateNavigationAuthState } from "./auth.js";
import { getApiUrl } from "./api-config.js";

// Single-flight in-flight promise and short-lived in-memory cache (60s TTL)
let clientSessionRoleCache = { data: null, expiresAt: 0, uid: null };
let inFlightSessionRolePromise = null;

export async function fetchUserSessionRole(user, forceRefresh = false) {
    if (!user) {
        clientSessionRoleCache = { data: null, expiresAt: 0, uid: null };
        return { authenticated: false, role: "guest", isAdmin: false };
    }

    const now = Date.now();
    if (!forceRefresh && clientSessionRoleCache.uid === user.uid && clientSessionRoleCache.data && now < clientSessionRoleCache.expiresAt) {
        return clientSessionRoleCache.data;
    }

    if (inFlightSessionRolePromise && !forceRefresh) {
        return inFlightSessionRolePromise;
    }

    inFlightSessionRolePromise = (async () => {
        try {
            const token = await user.getIdToken();
            const res = await fetch(getApiUrl("/api/auth/session-role"), {
                headers: { "Authorization": `Bearer ${token}` }
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                const err = new Error(errData.error || `HTTP ${res.status}`);
                err.statusCode = res.status;
                err.code = errData.code;
                err.retryAfter = errData.retryAfter;
                throw err;
            }

            const data = await res.json();
            clientSessionRoleCache = {
                data,
                expiresAt: Date.now() + 60_000,
                uid: user.uid
            };
            return data;
        } finally {
            inFlightSessionRolePromise = null;
        }
    })();

    return inFlightSessionRolePromise;
}

if (typeof window !== "undefined") {
    window.fetchUserSessionRole = fetchUserSessionRole;
}

async function checkAndRenderAdminNav(user) {
    const nav = document.querySelector(".nav");
    if (!nav) return;

    let adminLink = document.getElementById("navAdminLink");

    if (!user) {
        if (adminLink) {
            adminLink.remove();
        }
        return;
    }

    try {
        const data = await fetchUserSessionRole(user);
        if (data && (data.isAdmin === true || data.role === "admin")) {
            if (!adminLink) {
                adminLink = document.createElement("a");
                adminLink.id = "navAdminLink";
                adminLink.href = "admin.html";
                adminLink.textContent = "Admin";
                adminLink.className = window.location.pathname.endsWith("admin.html") ? "active" : "";
                adminLink.addEventListener("click", () => {
                    sessionStorage.removeItem("adminBrowsingWebapp");
                });

                // Insert before authButton or profileCircle
                const authBtn = document.getElementById("authButton");
                if (authBtn) {
                    nav.insertBefore(adminLink, authBtn);
                } else {
                    nav.appendChild(adminLink);
                }
            }
            return;
        }

        // If not an authorized administrator, remove element completely from DOM
        if (adminLink) {
            adminLink.remove();
        }
    } catch (e) {
        if (adminLink) {
            adminLink.remove();
        }
    }
}

function ensureMockTestNav() {
    const nav = document.querySelector(".nav");
    if (!nav) return;

    const existing = nav.querySelector('a[href="mock-test.html"], a[href$="/mock-test.html"]');
    if (!existing) {
        const link = document.createElement("a");
        link.href = "mock-test.html";
        link.textContent = "Mock Tests";
        if (window.location.pathname.endsWith("mock-test.html")) {
            link.className = "active";
        }

        const aiChat = nav.querySelector('a[href*="ai-chat.html"]');
        const contact = nav.querySelector('a[href*="contact.html"]');
        const authBtn = document.getElementById("authButton");
        const profileCircle = document.getElementById("profileCircle");
        const target = aiChat || contact || authBtn || profileCircle;

        if (target) {
            nav.insertBefore(link, target);
        } else {
            nav.appendChild(link);
        }
    }
}

function setupHeader() {
    ensureMockTestNav();
    onAuthStateChanged(auth, (user) => {
        updateNavigationAuthState(user);
        checkAndRenderAdminNav(user);
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupHeader);
} else {
    setupHeader();
}