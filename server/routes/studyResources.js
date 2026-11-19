import express from "express";
import {
    verifyFirebaseIdToken,
    getFirestoreServerAuthHeaders,
    getFirestoreBaseUrl,
    getFirestoreCommitUrl,
    validateProjectIdFormat
} from "../services/firebaseTokenService.js";

const router = express.Router();

function getActiveProjectId() {
    const id = process.env.FIREBASE_PROJECT_ID;
    if (!id || typeof id !== "string" || !id.trim()) {
        throw new Error("[Study Resources API Security] FATAL: FIREBASE_PROJECT_ID is mandatory. Implicit production fallback is strictly forbidden.");
    }
    return validateProjectIdFormat(id, "FIREBASE_PROJECT_ID");
}

// In-Memory Caches for Abuse Protection & Deduplication
const ipRequestWindowMap = new Map(); // ip -> { count, resetTime }
const sessionDeduplicationMap = new Map(); // key -> timestamp

const MAX_REQUESTS_PER_MINUTE = 25; // Max 25 counter requests per IP/min
const VIEW_DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000; // 5 min view dedup window
const DOWNLOAD_DEDUPLICATION_WINDOW_MS = 60 * 1000; // 1 min download dedup window

// Helper: Sanitize string input against path traversal & injection
function sanitizeId(id) {
    if (typeof id !== "string") return null;
    const clean = id.trim();
    if (!clean || clean.length > 128 || clean.includes("..") || clean.includes("/") || clean.includes("\\")) {
        return null;
    }
    return clean;
}

// Helper: Extract Primary Event Identity (Firebase Auth UID when available, else Session UUID)
// Explicitly validates Bearer token if provided and rejects invalid tokens with 401.
async function extractPrimaryIdentity(req) {
    // 1. Check Bearer ID Token in Authorization Header
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (authHeader && typeof authHeader === "string") {
        const trimmedAuth = authHeader.trim();
        if (!trimmedAuth.startsWith("Bearer ")) {
            const err = new Error("Malformed Authorization header. Format must be 'Bearer <token>'.");
            err.statusCode = 401;
            throw err;
        }
        const rawToken = trimmedAuth.substring(7).trim();
        if (!rawToken) {
            const err = new Error("Empty Bearer token provided in Authorization header.");
            err.statusCode = 401;
            throw err;
        }
        const claims = await verifyFirebaseIdToken(rawToken);
        const cleanUid = sanitizeId(claims?.sub);
        if (!cleanUid) {
            const err = new Error("Invalid, malformed, or expired authentication token.");
            err.statusCode = 401;
            throw err;
        }
        return { identity: `uid:${cleanUid}`, uid: cleanUid };
    }

    // 2. Fallback to Client Session ID (anonymous installation / session UUID)
    const bodySessionId = req.body && req.body.clientSessionId;
    const cleanSession = sanitizeId(bodySessionId);
    if (cleanSession) {
        return { identity: `session:${cleanSession}`, uid: null };
    }

    // 3. Fallback to Client IP if no session ID provided
    const clientIp = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown_ip";
    return { identity: `ip_fallback:${clientIp}`, uid: null };
}

// Middleware: Abuse Protection (IP-based Rate Limiter)
function checkRateLimit(req, res, next) {
    const clientIp = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown_ip";
    const now = Date.now();

    let rateData = ipRequestWindowMap.get(clientIp);
    if (!rateData || now > rateData.resetTime) {
        rateData = { count: 1, resetTime: now + 60 * 1000 };
        ipRequestWindowMap.set(clientIp, rateData);
    } else {
        rateData.count++;
    }

    if (rateData.count > MAX_REQUESTS_PER_MINUTE) {
        console.warn(`[Study Resources API Security] IP ${clientIp} exceeded rate limit (${rateData.count} reqs/min). Blocking.`);
        return res.status(429).json({
            success: false,
            error: "Rate limit exceeded. Too many requests from this IP."
        });
    }

    next();
}

function getChapterDocumentPath(ids) {
    return `studyResources/${ids.examId}/subjects/${ids.subjectId}/chapters/${ids.chapterId}`;
}

// Helper: Verify chapter document existence in Firestore
async function verifyChapterExists(documentPath) {
    const encodedPath = documentPath.split("/").map(encodeURIComponent).join("/");
    const projectId = getActiveProjectId();
    const firestoreBase = getFirestoreBaseUrl(projectId);
    const docUrl = `${firestoreBase}/${encodedPath}`;

    const authHeaders = await getFirestoreServerAuthHeaders(projectId);
    const headers = authHeaders ? { ...authHeaders } : {};

    const response = await fetch(docUrl, { method: "GET", headers });
    if (response.status === 404) {
        return false;
    }
    if (!response.ok) {
        if (response.status === 403) {
            const err = new Error("Database read permission denied.");
            err.statusCode = 500;
            throw err;
        }
        return false;
    }
    return true;
}

// Core Atomic Increment Engine
async function performAtomicIncrement(req, resourceIds, fieldName) {
    // 1. Strict parameter validation
    const ids = Object.fromEntries(Object.entries(resourceIds || {}).map(([key, value]) => [key, sanitizeId(value)]));
    if (!ids.examId || !ids.subjectId || !ids.chapterId) {
        const err = new Error("Invalid or malformed Study Resources hierarchy ID provided (examId, subjectId, and chapterId are required).");
        err.statusCode = 400;
        throw err;
    }

    // 2. Strict field validation
    if (fieldName !== "viewCount" && fieldName !== "downloadCount") {
        const err = new Error("Invalid field specified for increment. Permitted fields: viewCount, downloadCount.");
        err.statusCode = 400;
        throw err;
    }

    // 3. Primary Event Identity & User Token Verification
    const authInfo = await extractPrimaryIdentity(req);
    const primaryIdentity = authInfo.identity;
    const dedupWindow = fieldName === "viewCount" ? VIEW_DEDUPLICATION_WINDOW_MS : DOWNLOAD_DEDUPLICATION_WINDOW_MS;
    const documentPath = getChapterDocumentPath(ids);
    const cleanId = `${ids.examId}/${ids.subjectId}/${ids.chapterId}`;
    const dedupKey = `${primaryIdentity}:${documentPath}:${fieldName}`;
    const lastTimestamp = sessionDeduplicationMap.get(dedupKey);
    const now = Date.now();

    // Deduplication check
    if (lastTimestamp && (now - lastTimestamp) < dedupWindow) {
        console.log(`[Study Resources API Security] Deduplicated repeated ${fieldName} event for Identity [${primaryIdentity}] on resource [${cleanId}].`);
        return { deduplicated: true, field: fieldName, identity: primaryIdentity };
    }

    const projectId = getActiveProjectId();

    // 4. Privileged Server Authorization Check
    const serverAuthHeaders = await getFirestoreServerAuthHeaders(projectId);
    if (!serverAuthHeaders && !process.env.FIRESTORE_EMULATOR_HOST) {
        console.error(`[Study Resources API Security] Privileged database credentials not configured for server-side atomic increment.`);
        const err = new Error("Server configuration error: Privileged database credentials not configured.");
        err.statusCode = 500;
        throw err;
    }

    // 5. Chapter Existence Check
    const exists = await verifyChapterExists(documentPath);
    if (!exists) {
        const err = new Error(`Target study chapter document does not exist in Firestore (${cleanId}).`);
        err.statusCode = 404;
        throw err;
    }

    // 6. Perform REST Commit Transform with server credentials
    const firestoreDocumentPath = `projects/${projectId}/databases/(default)/documents/${documentPath}`;
    const commitUrl = getFirestoreCommitUrl(projectId);

    const commitBody = {
        writes: [
            {
                transform: {
                    document: firestoreDocumentPath,
                    fieldTransforms: [{
                        fieldPath: fieldName,
                        increment: { integerValue: "1" }
                    }]
                }
            }
        ]
    };

    const commitHeaders = {
        "Content-Type": "application/json",
        ...(serverAuthHeaders || {})
    };

    const response = await fetch(commitUrl, {
        method: "POST",
        headers: commitHeaders,
        body: JSON.stringify(commitBody)
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`[Study Resources API Security] Firestore commit failed (${response.status}):`, errText);
        if (response.status === 403) {
            const err = new Error("Database write permission denied: Server lacks required permissions.");
            err.statusCode = 500;
            throw err;
        }
        const err = new Error(`Database commit operation failed with status ${response.status}.`);
        err.statusCode = 502;
        throw err;
    }

    const commitData = await response.json();
    const newCountStr = commitData?.writeResults?.[0]?.transformResults?.[0]?.integerValue;
    const storedCount = newCountStr != null ? Number(newCountStr) : undefined;

    // Register successful event in primary identity deduplication map
    sessionDeduplicationMap.set(dedupKey, now);
    return { deduplicated: false, field: fieldName, identity: primaryIdentity, storedCount };
}

function sendErrorResponse(res, error, actionName) {
    const statusCode = error.statusCode || 500;
    console.error(`[Study Resources API] ${actionName} error (${statusCode}):`, error.message);
    res.status(statusCode).json({
        success: false,
        error: error.message
    });
}

// POST /api/study-resources/increment-view
router.post("/increment-view", checkRateLimit, async (req, res) => {
    try {
        const result = await performAtomicIncrement(req, req.body || {}, "viewCount");
        res.json({
            success: true,
            field: "viewCount",
            increment: result.deduplicated ? 0 : 1,
            deduplicated: result.deduplicated,
            identity: result.identity,
            storedCount: result.storedCount
        });
    } catch (error) {
        sendErrorResponse(res, error, "View increment");
    }
});

// POST /api/study-resources/increment-download
router.post("/increment-download", checkRateLimit, async (req, res) => {
    try {
        const result = await performAtomicIncrement(req, req.body || {}, "downloadCount");
        res.json({
            success: true,
            field: "downloadCount",
            increment: result.deduplicated ? 0 : 1,
            deduplicated: result.deduplicated,
            identity: result.identity,
            storedCount: result.storedCount
        });
    } catch (error) {
        sendErrorResponse(res, error, "Download increment");
    }
});

export default router;
