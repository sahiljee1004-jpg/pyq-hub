import { verifyFirebaseIdToken, validateProjectIdFormat } from "../firebaseTokenService.js";
import { UniversalFirestoreService } from "./universalFirestoreService.js";

function getAdminTargetProjectId(explicitProjectId = null) {
    const raw = explicitProjectId || process.env.FIREBASE_PROJECT_ID;
    if (!raw || typeof raw !== "string" || !raw.trim()) {
        throw new Error("[AdminAuthService] FIREBASE_PROJECT_ID is not configured and no explicit targetProjectId was provided. Rejecting admin authorization to prevent ambient production fallback.");
    }
    return validateProjectIdFormat(raw.trim(), "targetProjectId");
}

/**
 * Admin Authorization Service — Firestore-Managed Admin Access
 * 
 * Strict Centralized Security Model:
 * 1. Extract Bearer token from the `Authorization: Bearer <token>` header.
 * 2. Cryptographically verify the token (RS256, expiration, issuer, audience).
 * 3. Extract the canonical verified Firebase UID from token claims (`claims.sub`).
 * 4. Fetch the authoritative user document from Firestore: `users/{verifiedUid}`.
 * 5. Grant administrator access ONLY if the document exists and its `role` field is strictly `"admin"`.
 * 6. Reject all other cases:
 *    - Missing, expired, malformed, or tampered token: HTTP 401 Unauthorized.
 *    - Missing user document, `role === "user"`, unknown role: HTTP 403 Forbidden.
 * 
 * NO bypasses, NO shared secrets, NO allowlists, NO custom-claim-only grants.
 * The ONLY way to grant or revoke admin access is to edit `users/{uid}.role` in the Firebase Console.
 */
export class AdminAuthService {

    /**
     * Authorize an incoming HTTP request
     * @param {import("express").Request} req 
     * @returns {Promise<{ authorized: boolean, statusCode: number, error?: string, user?: { uid: string, email?: string, role: string } }>}
     */
    static async verifyAdmin(req) {
        // 1. Extract Authorization header or admin_session cookie
        let token = null;
        const authHeader = req.headers["authorization"] || req.headers["Authorization"];
        if (authHeader && typeof authHeader !== "string" && Array.isArray(authHeader)) {
            // handle array
        } else if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7).trim();
        } else if (req.cookies && req.cookies.admin_session) {
            token = req.cookies.admin_session.trim();
        }

        if (!token) {
            return {
                authorized: false,
                statusCode: 401,
                error: "Unauthorized: Missing or invalid Authorization header or session cookie. Bearer token required."
            };
        }

        // 1b. CSRF defense-in-depth: if mutation relies on cookie session alone, check origin
        const isMutation = ["POST", "PUT", "DELETE", "PATCH"].includes((req.method || "").toUpperCase());
        const hasBearerAuth = Boolean(authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer "));
        if (isMutation && !hasBearerAuth && req.cookies && req.cookies.admin_session) {
            if (req.headers["sec-fetch-site"] === "cross-site") {
                return {
                    authorized: false,
                    statusCode: 403,
                    error: "Forbidden: Cross-site request rejected (Sec-Fetch-Site: cross-site)."
                };
            }
            const origin = req.headers["origin"];
            const host = req.headers["host"];
            if (origin && host) {
                try {
                    const originHost = new URL(origin).host;
                    if (originHost !== host) {
                        return {
                            authorized: false,
                            statusCode: 403,
                            error: "Forbidden: Cross-origin state mutation rejected (CSRF protection)."
                        };
                    }
                } catch (_) {
                    return {
                        authorized: false,
                        statusCode: 403,
                        error: "Forbidden: Malformed Origin header rejected."
                    };
                }
            }
        }

        // 2. Cryptographically verify Firebase ID token
        const claims = await verifyFirebaseIdToken(token);
        if (!claims || !claims.sub) {
            return {
                authorized: false,
                statusCode: 401,
                error: "Unauthorized: Invalid, expired, or tampered Firebase ID token."
            };
        }

        const verifiedUid = claims.sub;
        let targetProjectId;
        try {
            targetProjectId = getAdminTargetProjectId(req.targetProjectId);
        } catch (configErr) {
            console.error(`[AdminAuthService] Target project configuration error: ${configErr.message}`);
            return {
                authorized: false,
                statusCode: 503,
                error: `Service Unavailable: ${configErr.message}`,
                diagnostic: {
                    errorType: "missing_target_project"
                }
            };
        }

        // 3. Fetch users/{verifiedUid} directly from Firestore using bound client (server-side authoritative)
        let userDoc;
        try {
            const client = req.adminClient && req.adminClient.projectId === targetProjectId
                ? req.adminClient
                : UniversalFirestoreService.forProject(targetProjectId);
            userDoc = await client.getDocument("users", verifiedUid);
        } catch (fetchErr) {
            console.error(`[AdminAuthService] Firestore connectivity failure for UID ${verifiedUid}:`, fetchErr.message);
            const isQuota = Boolean(fetchErr.isQuotaExhausted || fetchErr.statusCode === 429 || (fetchErr.message && fetchErr.message.includes("RESOURCE_EXHAUSTED")));
            const statusCode = isQuota ? 429 : 503;
            const errorMsg = isQuota
                ? "Service Unavailable: Database read quota exceeded. Administrator verification is temporarily paused. Please retry shortly."
                : `Service Unavailable: Failed to connect to Firestore to verify admin permissions (${fetchErr.message}). Safe diagnostic: Target project '${targetProjectId}'.`;
            return {
                authorized: false,
                statusCode,
                error: errorMsg,
                diagnostic: {
                    targetProjectId,
                    verifiedUid,
                    errorType: isQuota ? "firestore_quota_exhausted" : "firestore_connection_error",
                    retryAfter: fetchErr.retryAfter || 30
                }
            };
        }

        if (!userDoc) {
            console.warn(`[AdminAuthService] Authorization rejected: Document 'users/${verifiedUid}' not found in Firestore project '${targetProjectId}'.`);
            return {
                authorized: false,
                statusCode: 403,
                error: `Access Denied: User document 'users/${verifiedUid}' does not exist in Firestore.`,
                diagnostic: {
                    targetProjectId,
                    verifiedUid,
                    documentExists: false
                }
            };
        }

        // 4. Strict role check: must be exactly string "admin"
        if (userDoc.role !== "admin") {
            console.warn(`[AdminAuthService] Authorization rejected: UID '${verifiedUid}' has role '${userDoc.role || "undefined"}', expected 'admin' in project '${targetProjectId}'.`);
            return {
                authorized: false,
                statusCode: 403,
                error: `Access Denied: Administrator role required in Firestore (users/${verifiedUid}.role is '${userDoc.role || "undefined"}', expected 'admin').`,
                diagnostic: {
                    targetProjectId,
                    verifiedUid,
                    documentExists: true,
                    roleFound: userDoc.role || null
                }
            };
        }

        console.log(`[AdminAuthService] Authorization granted for UID '${verifiedUid}' (role: admin, project: ${targetProjectId}).`);

        // 5. Authorized!
        return {
            authorized: true,
            statusCode: 200,
            user: {
                uid: verifiedUid,
                email: claims.email || userDoc.email || "",
                role: "admin"
            },
            diagnostic: {
                targetProjectId,
                verifiedUid,
                documentExists: true,
                roleFound: "admin"
            }
        };
    }

    /**
     * Express middleware to enforce Firestore-managed administrator authorization for API routes
     */
    static requireAdmin() {
        return async (req, res, next) => {
            try {
                res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
                res.setHeader("Pragma", "no-cache");
                const result = await AdminAuthService.verifyAdmin(req);
                if (!result.authorized) {
                    return res.status(result.statusCode).json({
                        success: false,
                        error: result.error,
                        diagnostic: result.diagnostic || undefined
                    });
                }

                req.adminUser = result.user;
                req.adminActor = result.user.uid;
                req.adminEmail = result.user.email;
                req.adminRole = "admin";
                const targetProject = result.diagnostic?.targetProjectId;
                if (!targetProject) {
                    return res.status(503).json({ success: false, error: "Internal authorization failure: target project undetermined." });
                }
                req.targetProjectId = targetProject;
                req.adminClient = UniversalFirestoreService.forProject(targetProject);
                next();
            } catch (err) {
                console.error("[AdminAuthService] Authorization error:", err.message);
                return res.status(500).json({ success: false, error: "Internal authorization failure" });
            }
        };
    }

    /**
     * Express middleware to protect the admin HTML page navigation.
     * Serves the page only if authenticated with role: "admin".
     * Rejects unauthenticated (401) and ordinary users (403) with clear access-denied response.
     */
    static protectAdminPage() {
        return async (req, res, next) => {
            try {
                res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
                res.setHeader("Pragma", "no-cache");
                const result = await AdminAuthService.verifyAdmin(req);
                if (!result.authorized) {
                    return AdminAuthService.renderAccessDenied(req, res, result.statusCode, result.error);
                }

                req.adminUser = result.user;
                req.adminActor = result.user.uid;
                req.adminEmail = result.user.email;
                req.adminRole = "admin";
                const targetProject = result.diagnostic?.targetProjectId;
                if (!targetProject) {
                    return AdminAuthService.renderAccessDenied(req, res, 503, "Internal authorization failure: target project undetermined.");
                }
                req.targetProjectId = targetProject;
                req.adminClient = UniversalFirestoreService.forProject(targetProject);
                next();
            } catch (err) {
                console.error("[AdminAuthService] Protected page access error:", err.message);
                return AdminAuthService.renderAccessDenied(req, res, 500, "Internal authorization error verifying admin permissions.");
            }
        };
    }

    /**
     * Render a clean, secure access-denied page or JSON response
     */
    static renderAccessDenied(req, res, statusCode, message) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        res.setHeader("Pragma", "no-cache");
        if (req && req.accepts && !req.accepts("html") && req.accepts("json")) {
            return res.status(statusCode).json({ success: false, error: message });
        }
        res.status(statusCode);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${statusCode === 401 ? "Sign In Required" : "Access Denied"} — VidyarthiAstra</title>
    <link rel="stylesheet" href="/css/style.css">
    <style>
        body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: white; border: 1px solid #e2e8f0; border-radius: 20px; box-shadow: 0 15px 35px rgba(0,0,0,0.06); padding: 40px; max-width: 480px; width: 100%; text-align: center; }
        .icon { font-size: 44px; margin-bottom: 16px; color: ${statusCode === 401 ? "#f59e0b" : "#ef4444"}; }
        h1 { margin: 0 0 12px; font-size: 24px; color: #1e293b; }
        p { margin: 0 0 24px; color: #64748b; font-size: 15px; line-height: 1.5; }
        .btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 22px; border-radius: 10px; font-weight: 600; text-decoration: none; font-size: 14px; transition: all 0.2s; }
        .btn-primary { background: #2563eb; color: white; }
        .btn-primary:hover { background: #1d4ed8; }
        .btn-secondary { background: #f1f5f9; color: #475569; margin-left: 10px; }
        .btn-secondary:hover { background: #e2e8f0; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">${statusCode === 401 ? "&#128274;" : "&#9888;"}</div>
        <h1>${statusCode === 401 ? "401 — Sign In Required" : "403 — Access Denied"}</h1>
        <p>${message}</p>
        <div style="display:flex; justify-content:center; gap:10px;">
            ${statusCode === 401 ? '<a href="/login.html?redirect=/admin.html" class="btn btn-primary">Sign In</a>' : ''}
            <a href="/" class="btn ${statusCode === 401 ? 'btn-secondary' : 'btn-primary'}">&larr; Back to Webapp</a>
        </div>
    </div>
</body>
</html>`);
    }

    /**
     * Backward-compatible alias for requireAdmin
     */
    static middleware() {
        return this.requireAdmin();
    }
}

