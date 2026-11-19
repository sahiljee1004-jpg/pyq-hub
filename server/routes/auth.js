import express from "express";
import { verifyFirebaseIdToken } from "../services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../services/admin/universalFirestoreService.js";

const router = express.Router();

/**
 * Helper to extract Firebase ID token from Bearer header or body or cookie
 */
function extractToken(req) {
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7).trim();
    }
    if (req.body && req.body.idToken && typeof req.body.idToken === "string") {
        return req.body.idToken.trim();
    }
    if (req.cookies && req.cookies.admin_session) {
        return req.cookies.admin_session.trim();
    }
    return null;
}

/**
 * POST /api/auth/session
 * Establish authenticated server session cookie and return authoritative Firestore role
 */
router.post("/session", async (req, res) => {
    try {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized: Missing Firebase ID token"
            });
        }

        const claims = await verifyFirebaseIdToken(token);
        if (!claims || !claims.sub) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized: Invalid or expired Firebase ID token"
            });
        }

        const verifiedUid = claims.sub;
        const userDoc = await UniversalFirestoreService.getDocument("users", verifiedUid);
        const role = userDoc?.role || "user";
        const isAdmin = role === "admin";

        // Set secure HttpOnly cookie for top-level browser navigation to /admin.html
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        res.cookie("admin_session", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/",
            maxAge: 3600 * 1000 // 1 hour matching Firebase ID token lifespan
        });

        res.json({
            success: true,
            uid: verifiedUid,
            email: claims.email || userDoc?.email || "",
            role,
            isAdmin
        });
    } catch (err) {
        console.error("[Auth API] Session sync error:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Please wait a moment and retry.",
                retryAfter
            });
        }
        res.status(500).json({ success: false, error: "Internal server error syncing session" });
    }
});

/**
 * POST /api/auth/logout
 * Terminate server session cookie
 */
router.post("/logout", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.clearCookie("admin_session", {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax"
    });
    res.json({
        success: true,
        message: "Session ended successfully"
    });
});

/**
 * GET /api/auth/session-role
 * Check current user role without mutating session
 */
router.get("/session-role", async (req, res) => {
    try {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        const token = extractToken(req);
        if (!token) {
            return res.json({
                authenticated: false,
                role: "guest",
                isAdmin: false
            });
        }

        const claims = await verifyFirebaseIdToken(token);
        if (!claims || !claims.sub) {
            res.clearCookie("admin_session", {
                path: "/",
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax"
            });
            return res.json({
                authenticated: false,
                role: "guest",
                isAdmin: false
            });
        }

        const verifiedUid = claims.sub;
        const userDoc = await UniversalFirestoreService.getDocument("users", verifiedUid);
        const role = userDoc?.role || "user";

        res.json({
            authenticated: true,
            uid: verifiedUid,
            email: claims.email || userDoc?.email || "",
            role,
            isAdmin: role === "admin"
        });
    } catch (err) {
        console.error("[Auth API] Session role check error:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                authenticated: true,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Please wait a moment and retry.",
                retryAfter
            });
        }
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

export default router;
