import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { verifyFirebaseIdToken } from "../services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../services/admin/universalFirestoreService.js";
import { MockTestService } from "../services/mockTestService.js";

const router = express.Router();

// -------------------------------------------------------------
// 0. Serve Diagram Assets for Mock Tests (Safe & Public for Tests)
// -------------------------------------------------------------
router.get("/diagrams/:filename", (req, res) => {
    try {
        const { filename } = req.params;
        const safeFilename = path.basename(filename);
        if (!/^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|svg)$/i.test(safeFilename)) {
            return res.status(400).json({ success: false, error: "Invalid diagram filename format" });
        }
        const filePath = path.join(process.cwd(), "uploads", "vault", "diagrams", safeFilename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: "Diagram asset not found" });
        }
        const ext = path.extname(safeFilename).toLowerCase();
        const contentType = ext === ".svg" ? "image/svg+xml; charset=utf-8" : (ext === ".webp" ? "image/webp" : "image/png");
        res.setHeader("Content-Type", contentType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "public, max-age=86400");
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    } catch (err) {
        console.error("[MockTest API] Error serving diagram:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// Security & Maintenance Middleware
// -------------------------------------------------------------

/**
 * Middleware: Check Maintenance Mode for State-Mutating Student Routes
 *
 * Enforces strict operational boundaries:
 *  - Maintenance active via .maintenance file or MAINTENANCE_MODE env.
 *  - Blocks all student mutating operations (attempts, autosaves, submissions) with HTTP 503.
 *  - Ordinary administrators (role: 'admin') are ALSO blocked from student attempt routes during maintenance.
 *  - Only superadmins (role: 'superadmin' or recovery: true) conducting verified recovery tests can pass.
 *  - SECURITY FIX: Student attempt routes NEVER inspect or authorize access based on x-admin-recovery-token header.
 */
export function checkMaintenanceMode(req, res, next) {
    const isMaintenanceFile = fs.existsSync(path.resolve(process.cwd(), ".maintenance"));
    const isMaintenanceEnv = process.env.MAINTENANCE_MODE === "true" || process.env.MAINTENANCE_MODE === "1";

    if (isMaintenanceEnv || isMaintenanceFile) {
        // Only explicit superadmin recovery identity (verified via Firebase Auth) is permitted on attempt routes
        const isSuperadmin = req.user?.role === "superadmin" || req.user?.permissions?.recovery === true;
        if (isSuperadmin) {
            console.log(`[SECURITY AUDIT] Superadmin maintenance bypass granted for UID: ${req.user.uid} (${req.method} ${req.originalUrl})`);
            return next();
        }

        res.setHeader("Retry-After", "300");
        return res.status(503).json({
            success: false,
            code: "MAINTENANCE_MODE_ACTIVE",
            error: "Platform is currently undergoing scheduled database maintenance. Exam attempts, autosaves, and submissions are temporarily paused. Please try again after maintenance concludes."
        });
    }
    next();
}

/**
 * Middleware: Cryptographic Verification for Dedicated Administrative Recovery Routes
 *
 * Requirements:
 *  1. Strictly restricted to dedicated recovery endpoints, NEVER student attempt routes.
 *  2. Requires server-side secret ADMIN_RECOVERY_TOKEN >= 32 bytes.
 *  3. Constant-time validation using crypto.timingSafeEqual with length checks.
 *  4. Never exposes secret in responses or logs.
 *  5. Structured security audit logging for all attempts.
 */
export function verifyRecoveryAuth(req, res, next) {
    const serverSecret = process.env.ADMIN_RECOVERY_TOKEN;
    const clientIp = req.ip || req.socket?.remoteAddress || "unknown_ip";

    if (!serverSecret || typeof serverSecret !== "string" || Buffer.byteLength(serverSecret, "utf8") < 32) {
        console.error(`[SECURITY AUDIT] Recovery access rejected: Server ADMIN_RECOVERY_TOKEN is not configured with >= 32 bytes. Request from IP: ${clientIp}`);
        return res.status(503).json({
            success: false,
            code: "RECOVERY_AUTH_UNCONFIGURED",
            error: "Recovery authentication is not securely configured on this server (requires secret >= 32 bytes)."
        });
    }

    const suppliedHeader = req.headers["x-admin-recovery-token"];
    if (!suppliedHeader || typeof suppliedHeader !== "string") {
        console.warn(`[SECURITY AUDIT] Recovery access rejected: Missing x-admin-recovery-token from IP: ${clientIp} for ${req.method} ${req.originalUrl}`);
        return res.status(401).json({
            success: false,
            code: "RECOVERY_TOKEN_REQUIRED",
            error: "An administrative recovery token is required in the 'x-admin-recovery-token' header."
        });
    }

    const suppliedBuf = Buffer.from(suppliedHeader, "utf8");
    const expectedBuf = Buffer.from(serverSecret, "utf8");

    // Guard timingSafeEqual against buffer length mismatch
    if (suppliedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(suppliedBuf, expectedBuf)) {
        console.warn(`[SECURITY AUDIT] Recovery access rejected: Invalid recovery token from IP: ${clientIp} (length: ${suppliedBuf.length}) for ${req.method} ${req.originalUrl}`);
        return res.status(403).json({
            success: false,
            code: "INVALID_RECOVERY_TOKEN",
            error: "Invalid administrative recovery token."
        });
    }

    console.log(`[SECURITY AUDIT] Recovery access granted from IP: ${clientIp} for ${req.method} ${req.originalUrl}`);
    next();
}

// Middleware: Verify Student Firebase Authentication
async function requireStudentAuth(req, res, next) {
    let token = null;
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7).trim();
    } else if (req.cookies?.auth_token) {
        token = req.cookies.auth_token;
    } else if (req.cookies?.admin_session) {
        token = req.cookies.admin_session;
    }

    if (!token) {
        return res.status(401).json({
            success: false,
            error: "Authentication required: A valid Firebase ID token is required."
        });
    }

    const claims = await verifyFirebaseIdToken(token);
    if (!claims || !claims.sub) {
        return res.status(401).json({
            success: false,
            error: "Invalid or expired Firebase authentication token."
        });
    }

    let role = "user";
    let permissions = {};
    try {
        const userDoc = await UniversalFirestoreService.getDocument("users", claims.sub);
        if (userDoc && userDoc.role) {
            role = userDoc.role;
        }
        if (userDoc && userDoc.permissions && typeof userDoc.permissions === "object") {
            permissions = userDoc.permissions;
        }
    } catch (err) {
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            console.warn(`[MockTest API] Student auth quota exceeded for ${claims.sub}`);
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Exam attempts and state mutations are temporarily paused. Please retry in a few moments.",
                retryAfter
            });
        }
        // Fall back to ordinary user
    }

    req.user = {
        uid: claims.sub,
        email: claims.email || "",
        role,
        permissions
    };

    next();
}

// -------------------------------------------------------------
// 1. List Published Mock Tests (with Search, Year Sort & Pagination)
// -------------------------------------------------------------
router.get("/", async (req, res) => {
    try {
        const { examId, search, sort, page, limit } = req.query;

        const rawLimit = limit !== undefined && limit !== null && limit !== "" ? parseInt(limit, 10) : null;
        const validLimit = rawLimit && !isNaN(rawLimit) && rawLimit > 0 ? rawLimit : null;

        const result = await MockTestService.listPublishedTests({
            examId: typeof examId === "string" ? examId.trim() : null,
            search: typeof search === "string" ? search.trim() : null,
            sort: typeof sort === "string" ? sort.trim() : "desc",
            page: page ? parseInt(page, 10) || 1 : 1,
            limit: validLimit
        });

        if (validLimit && result && !Array.isArray(result) && Array.isArray(result.tests)) {
            res.json({
                success: true,
                count: result.tests.length,
                total: result.total,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                tests: result.tests
            });
        } else {
            const testsArray = Array.isArray(result) ? result : (result?.tests || []);
            res.json({
                success: true,
                count: testsArray.length,
                total: testsArray.length,
                tests: testsArray
            });
        }
    } catch (err) {
        console.error("[MockTest API] Error listing tests:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Unable to load mock test catalog. Please try again shortly.",
                retryAfter
            });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 1b. List Authenticated Student's Attempt History
// -------------------------------------------------------------
router.get("/user/attempts", requireStudentAuth, async (req, res) => {
    try {
        const { testId } = req.query;
        const attempts = await MockTestService.listUserAttempts({
            userId: req.user.uid,
            testId: testId || null
        });
        res.json({
            success: true,
            count: attempts.length,
            attempts
        });
    } catch (err) {
        console.error("[MockTest API] Error listing user attempts:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Unable to list user attempts. Please try again shortly.",
                retryAfter
            });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get("/:testId/user-attempts", requireStudentAuth, async (req, res) => {
    try {
        const { testId } = req.params;
        const attempts = await MockTestService.listUserAttempts({
            userId: req.user.uid,
            testId
        });
        res.json({
            success: true,
            testId,
            count: attempts.length,
            attempts
        });
    } catch (err) {
        console.error("[MockTest API] Error listing test attempts:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Unable to list test attempts. Please try again shortly.",
                retryAfter
            });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 2. Get Test Details & Questions (Answer keys strictly stripped)
// -------------------------------------------------------------
router.get("/:testId", requireStudentAuth, async (req, res) => {
    try {
        const { testId } = req.params;
        const { language } = req.query;
        const details = await MockTestService.getTestForStudent(testId, {
            callerRole: req.user.role,
            language: language || null
        });

        if (!details) {
            return res.status(404).json({
                success: false,
                error: `Test '${testId}' not found or is currently unpublished.`
            });
        }

        res.json({
            success: true,
            ...details
        });
    } catch (err) {
        console.error("[MockTest API] Error getting test details:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Unable to load mock test questions. Please try again shortly.",
                retryAfter
            });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 3. Start Test Attempt
// -------------------------------------------------------------
router.post("/:testId/attempts", requireStudentAuth, checkMaintenanceMode, async (req, res) => {
    try {
        const { testId } = req.params;
        const { language } = req.body || {};
        // SECURITY: Student UID is derived strictly from verified token (never client body)
        const userId = req.user.uid;

        const attempt = await MockTestService.startAttempt({ testId, userId, language });
        res.status(201).json({
            success: true,
            attempt
        });
    } catch (err) {
        console.error("[MockTest API] Error starting attempt:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Unable to start mock test attempt. Please try again shortly.",
                retryAfter
            });
        }
        const status = err.statusCode || ((err.message.includes("not available") || err.message.includes("not exist")) ? 404 : 400);
        res.status(status).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 4. Retrieve Active Attempt
// -------------------------------------------------------------
router.get("/attempts/:attemptId", requireStudentAuth, async (req, res) => {
    try {
        const { attemptId } = req.params;
        const attempt = await MockTestService.getAttempt({
            attemptId,
            userId: req.user.uid,
            callerRole: req.user.role
        });

        if (!attempt) {
            return res.status(404).json({ success: false, error: "Attempt not found" });
        }

        res.json({ success: true, attempt });
    } catch (err) {
        console.error("[MockTest API] Error retrieving attempt:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Unable to retrieve attempt. Please try again shortly.",
                retryAfter
            });
        }
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 5. Autosave Student Answers
// -------------------------------------------------------------
router.put("/attempts/:attemptId", requireStudentAuth, checkMaintenanceMode, async (req, res) => {
    try {
        const { attemptId } = req.params;
        const { answers, markedForReview, expectedUpdateTime } = req.body || {};

        const result = await MockTestService.autosaveAttempt({
            attemptId,
            userId: req.user.uid,
            answers,
            markedForReview,
            expectedUpdateTime: expectedUpdateTime || req.headers["if-match"]
        });

        res.json(result);
    } catch (err) {
        console.error("[MockTest API] Error autosaving attempt:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Autosave temporarily paused. Please retry in a moment.",
                retryAfter
            });
        }
        const status = (err.code === "ATTEMPT_ALREADY_SUBMITTED" || err.code === "CONCURRENT_MODIFICATION" || err.code === "STALE_AUTOSAVE") 
            ? 409 
            : (err.statusCode || 400);
        res.status(status).json({ success: false, error: err.message, code: err.code });
    }
});

// -------------------------------------------------------------
// 6. Submit Test Attempt & Calculate Server Score
// -------------------------------------------------------------
router.post("/attempts/:attemptId/submit", requireStudentAuth, checkMaintenanceMode, async (req, res) => {
    try {
        const { attemptId } = req.params;
        const { answers } = req.body || {};
        // SECURITY: Any client-supplied scores are completely ignored!
        const result = await MockTestService.submitAttempt({
            attemptId,
            userId: req.user.uid,
            answers
        });

        res.json({
            success: true,
            result
        });
    } catch (err) {
        console.error("[MockTest API] Error submitting attempt:", err.message);
        if (err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
            const retryAfter = err.retryAfter || 30;
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                code: "FIRESTORE_QUOTA_EXHAUSTED",
                error: "Database read quota exceeded. Unable to submit attempt. Please retry in a few moments.",
                retryAfter
            });
        }
        const status = err.statusCode || (err.code === "ALREADY_EXISTS" || err.code === "SUBMISSION_PAYLOAD_CONFLICT" || err.code === "CONCURRENT_MODIFICATION" ? 409 : 500);
        res.status(status).json({ success: false, error: err.message, code: err.code });
    }
});

// -------------------------------------------------------------
// 7. Retrieve Evaluated Test Result
// -------------------------------------------------------------
router.get("/results/:resultId", requireStudentAuth, async (req, res) => {
    try {
        const { resultId } = req.params;
        const result = await MockTestService.getResult({
            resultId,
            userId: req.user.uid,
            callerRole: req.user.role
        });

        if (!result) {
            return res.status(404).json({ success: false, error: "Result not found" });
        }

        res.json({ success: true, result });
    } catch (err) {
        console.error("[MockTest API] Error retrieving result:", err.message);
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 8. Retrieve Test Attempt Paper in Review Mode (Selective Answer Key Exposure)
// -------------------------------------------------------------
router.get("/attempts/:attemptId/review", requireStudentAuth, async (req, res) => {
    try {
        const { attemptId } = req.params;
        const reviewData = await MockTestService.getReviewForAttempt({
            attemptId,
            userId: req.user.uid,
            callerRole: req.user.role
        });

        res.json({
            success: true,
            ...reviewData
        });
    } catch (err) {
        console.error("[MockTest API] Error retrieving review:", err.message);
        const status = err.statusCode || (err.message.includes("not found") ? 404 : (err.message.includes("Access Denied") ? 403 : 400));
        res.status(status).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 9. Dedicated Administrative Recovery Endpoint
// -------------------------------------------------------------
router.post("/recovery/status", verifyRecoveryAuth, (req, res) => {
    res.json({
        success: true,
        recoveryEndpointActive: true,
        maintenanceModeActive: fs.existsSync(path.resolve(process.cwd(), ".maintenance")) || process.env.MAINTENANCE_MODE === "true",
        timestamp: new Date().toISOString()
    });
});

export default router;
