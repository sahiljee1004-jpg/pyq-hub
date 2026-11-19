import { createPublicKey, createSign, verify as verifySignature } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || null;
const FIREBASE_ISSUER = FIREBASE_PROJECT_ID ? `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` : null;
const FIREBASE_SIGNING_KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let signingKeys = [];
let signingKeysExpiresAt = 0;
let signingKeysRequest = null;

async function getSigningKeys() {
    if (signingKeys.length && Date.now() < signingKeysExpiresAt) {
        return signingKeys;
    }
    if (signingKeysRequest) {
        return signingKeysRequest;
    }

    signingKeysRequest = (async () => {
        const response = await fetch(FIREBASE_SIGNING_KEYS_URL);
        if (!response.ok) {
            throw new Error(`Firebase signing key request failed (${response.status})`);
        }

        const body = await response.json();
        if (!Array.isArray(body.keys)) {
            throw new Error("Firebase signing key response was invalid");
        }

        const cacheControl = response.headers.get("cache-control") || "";
        const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1]) || 3600;
        signingKeys = body.keys;
        signingKeysExpiresAt = Date.now() + maxAge * 1000;
        return signingKeys;
    })();

    try {
        return await signingKeysRequest;
    } finally {
        signingKeysRequest = null;
    }
}

let testPublicKey = null;
export function registerTestPublicKey(key) {
    testPublicKey = key;
}

export async function verifyFirebaseIdToken(token) {
    if (typeof token !== "string" || token.length > 16384) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    try {
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

        const now = Math.floor(Date.now() / 1000);
        const expectedProjectId = process.env.FIREBASE_PROJECT_ID || null;
        if (!expectedProjectId) return null;
        const expectedIssuer = `https://securetoken.google.com/${expectedProjectId}`;
        if (claims.iss !== expectedIssuer
            || claims.aud !== expectedProjectId
            || typeof claims.sub !== "string"
            || claims.sub.length === 0
            || claims.sub.length > 128
            || !Number.isFinite(claims.exp)
            || claims.exp <= now
            || !Number.isFinite(claims.iat)
            || claims.iat > now + 60) {
            return null;
        }

        let publicKey;
        if (process.env.NODE_ENV === "test" && header.kid === "test-rsa-key" && testPublicKey) {
            publicKey = testPublicKey;
        } else {
            const key = (await getSigningKeys()).find((candidate) => candidate.kid === header.kid);
            if (!key) return null;
            publicKey = createPublicKey({ key, format: "jwk" });
        }
        const validSignature = verifySignature(
            "RSA-SHA256",
            Buffer.from(`${parts[0]}.${parts[1]}`),
            publicKey,
            Buffer.from(parts[2], "base64url")
        );
        return validSignature ? claims : null;
    } catch (error) {
        console.warn("Firebase ID token verification failed:", error.message);
        return null;
    }
}

let cachedServerAccessToken = null;
let cachedServerTokenExpiresAt = 0;

function loadServiceAccountKey() {
    // 1. Explicit env var for service account JSON or file path
    const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (saEnv && typeof saEnv === "string") {
        try {
            const trimmed = saEnv.trim();
            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                return JSON.parse(trimmed);
            }
            const resolvedPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
            if (fs.existsSync(resolvedPath)) {
                return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
            }
            if (trimmed.startsWith("{")) {
                // Potential multiline JSON truncated by dotenv
                const envFile = path.resolve(process.cwd(), ".env");
                if (fs.existsSync(envFile)) {
                    const envText = fs.readFileSync(envFile, "utf8");
                    const match = envText.match(/FIREBASE_SERVICE_ACCOUNT=(\{[\s\S]*?\n\})/);
                    if (match) {
                        return JSON.parse(match[1]);
                    }
                }
            }
        } catch (e) {
            console.warn("[Firebase Security] Failed to parse FIREBASE_SERVICE_ACCOUNT:", e.message);
        }
    }

    // 2. GOOGLE_APPLICATION_CREDENTIALS file path
    const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (gacPath && typeof gacPath === "string") {
        try {
            const trimmed = gacPath.trim();
            const resolvedPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
            if (fs.existsSync(resolvedPath)) {
                return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
            }
        } catch (e) {
            console.warn("[Firebase Security] Failed to parse GOOGLE_APPLICATION_CREDENTIALS:", e.message);
        }
    }

    // REMOVED INSECURE FALLBACK:
    // Automatic loading of ./serviceAccountKey.json from workspace root is disabled for security.
    // Credentials MUST be explicitly supplied via FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS.
    return null;
}

/**
 * Check if a value is a valid numeric GCP Project Number.
 * GCP project numbers are numeric strings of 6 to 16 digits (e.g. "766070215379").
 */
export function isNumericProjectNumber(val) {
    if (val === null || val === undefined) return false;
    const str = String(val).trim();
    return /^\d{6,16}$/.test(str);
}

/**
 * Validate that a value is a valid numeric GCP Project Number.
 * Validates project numbers strictly independently from project IDs.
 */
export function validateProjectNumberFormat(projectNumber, paramName = "projectNumber") {
    if (projectNumber === null || projectNumber === undefined) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} is mandatory and cannot be null or undefined.`);
    }
    const str = String(projectNumber).trim();
    if (!/^\d{6,16}$/.test(str)) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} '${projectNumber}' is malformed. Numeric project numbers must contain only 6 to 16 digits.`);
    }
    return str;
}

/**
 * Strict GCP Project ID format and ambiguity validator.
 * Rejects missing, blank, malformed, uppercase, whitespace-containing,
 * or ambiguous placeholder project IDs.
 * Never validates numeric project numbers as project IDs.
 */
export function validateProjectIdFormat(projectId, paramName = "expectedProjectId") {
    if (projectId === null || projectId === undefined) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} is mandatory and cannot be null or undefined.`);
    }
    if (typeof projectId !== "string") {
        throw new Error(`[Firebase Security] FATAL: ${paramName} must be a string, received ${typeof projectId}.`);
    }
    const trimmed = projectId.trim();
    if (trimmed.length === 0) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} cannot be blank or whitespace.`);
    }

    // Explicitly separate project numbers from project IDs:
    // Purely numeric strings are project numbers and must NEVER be validated as project IDs.
    if (/^\d+$/.test(trimmed)) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} '${trimmed}' is a numeric project number, not a GCP project ID. Project IDs and numeric project numbers must be validated independently.`);
    }

    // Explicitly reject strictly non-project placeholder literals
    const AMBIGUOUS = new Set([
        "undefined",
        "null",
        "none",
        "default",
        "(default)",
        "true",
        "false",
        "[object object]",
        "any",
        "*",
        "all"
    ]);
    if (AMBIGUOUS.has(trimmed.toLowerCase())) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} '${trimmed}' is ambiguous or a generic placeholder. An explicit, concrete project ID is required.`);
    }

    if (/\s/.test(trimmed)) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} '${trimmed}' contains whitespace, which is invalid for a GCP project ID.`);
    }
    if (/[A-Z]/.test(trimmed)) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} '${trimmed}' contains uppercase characters. GCP project IDs must be strictly lowercase.`);
    }

    // Google Cloud Project ID rules:
    // 4 to 30 characters, lowercase letters, digits, and hyphens.
    // Must start with a lowercase letter, and cannot end with a hyphen.
    const GCP_PROJECT_ID_REGEX = /^[a-z][a-z0-9-]{2,28}[a-z0-9]$/;
    if (!GCP_PROJECT_ID_REGEX.test(trimmed)) {
        throw new Error(`[Firebase Security] FATAL: ${paramName} '${trimmed}' is malformed. Must start with a lowercase letter, contain only lowercase letters, digits, and hyphens, and be 4 to 30 characters long.`);
    }

    return trimmed;
}

export const KNOWN_PROJECT_MAPPINGS = Object.freeze({
    "pyqs-hub-43bed": "766070215379"
});

export const KNOWN_NUMBER_MAPPINGS = Object.freeze({
    "766070215379": "pyqs-hub-43bed"
});

/**
 * Verify both project ID and project number independently when either or both are available.
 * Cross-checks their mapping and enforces production isolation.
 */
export function verifyProjectIdentity({ projectId = null, projectNumber = null, expectedProjectId = null, expectedProjectNumber = null } = {}) {
    let validatedId = null;
    let validatedNumber = null;

    if (projectId !== null && projectId !== undefined) {
        validatedId = validateProjectIdFormat(projectId, "projectId");
    }
    if (projectNumber !== null && projectNumber !== undefined) {
        validatedNumber = validateProjectNumberFormat(projectNumber, "projectNumber");
    }

    if (expectedProjectId) {
        const validatedExpectedId = validateProjectIdFormat(expectedProjectId, "expectedProjectId");
        if (validatedId && validatedId !== validatedExpectedId) {
            throw new Error(`[Firebase Security] FATAL: Project ID '${validatedId}' does not match expected '${validatedExpectedId}'!`);
        }
    }

    if (expectedProjectNumber) {
        const validatedExpectedNum = validateProjectNumberFormat(expectedProjectNumber, "expectedProjectNumber");
        if (validatedNumber && validatedNumber !== validatedExpectedNum) {
            throw new Error(`[Firebase Security] FATAL: Project number '${validatedNumber}' does not match expected '${validatedExpectedNum}'!`);
        }
    }

    // Cross-check known production mappings
    if (validatedId === "pyqs-hub-43bed") {
        if (validatedNumber && validatedNumber !== "766070215379") {
            throw new Error(`[Firebase Security] FATAL: Production project ID 'pyqs-hub-43bed' is mapped to number '766070215379', but received '${validatedNumber}'!`);
        }
    }
    if (validatedNumber === "766070215379") {
        if (validatedId && validatedId !== "pyqs-hub-43bed") {
            throw new Error(`[Firebase Security] FATAL: Production project number '766070215379' detected with non-production project ID '${validatedId}'! Production isolation violation.`);
        }
    }

    return {
        projectId: validatedId,
        projectNumber: validatedNumber
    };
}

/**
 * Validate that loaded service account credentials match target project and enforce strict staging/production isolation.
 * Staging and production credentials CANNOT be interchanged.
 * expectedProjectId is mandatory and cannot be inferred from optional environment variables.
 */
export function validateServiceAccountCredentials(sa, expectedProjectId, options = {}) {
    // 1. Mandatory expectedProjectId validation
    const validatedTarget = validateProjectIdFormat(expectedProjectId, "expectedProjectId");

    // 2. Mandatory credential validation
    if (!sa || typeof sa !== "object") {
        throw new Error("[Firebase Security] FATAL: Service account credential object is missing or invalid.");
    }
    if (!sa.project_id || typeof sa.project_id !== "string" || !sa.project_id.trim()) {
        throw new Error("[Firebase Security] FATAL: Service account credential is missing mandatory 'project_id' field.");
    }
    const saProj = validateProjectIdFormat(sa.project_id, "service account project_id");

    let saNumber = null;
    if (sa.project_number) {
        saNumber = validateProjectNumberFormat(sa.project_number, "service account project_number");
    }

    const isProductionCredential = (saProj === "pyqs-hub-43bed" || saNumber === "766070215379" || sa.client_email?.includes("pyqs-hub-43bed"));
    const isTargetingProduction = (validatedTarget === "pyqs-hub-43bed");

    // 3. Staging and production credentials cannot be interchanged
    if (isProductionCredential && !isTargetingProduction) {
        throw new Error(`[Firebase Security] FATAL: Production service account '${sa.client_email || saProj}' cannot be used with non-production project '${validatedTarget}'! Production isolation violation.`);
    }

    if (!isProductionCredential && isTargetingProduction) {
        throw new Error(`[Firebase Security] FATAL: Non-production / staging service account '${sa.client_email || saProj}' cannot be used with production target '${validatedTarget}'! Staging and production credentials cannot be interchanged.`);
    }

    // 4. Strict Exact Project ID Match
    if (saProj !== validatedTarget) {
        throw new Error(`[Firebase Security] FATAL: Service account project_id '${saProj}' does not match target FIREBASE_PROJECT_ID '${validatedTarget}'! Cross-project credential usage is strictly blocked.`);
    }

    // 5. Verify independent project identity and cross-mapping
    verifyProjectIdentity({
        projectId: saProj,
        projectNumber: saNumber,
        expectedProjectId: validatedTarget,
        expectedProjectNumber: options.expectedProjectNumber || null
    });

    return sa;
}

export function getFirebaseConfigDiagnostics(expectedProjectId = null) {
    const sa = loadServiceAccountKey();
    let effectiveProjectId = null;
    if (expectedProjectId) {
        effectiveProjectId = validateProjectIdFormat(expectedProjectId, "expectedProjectId");
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID.trim()) {
        effectiveProjectId = process.env.FIREBASE_PROJECT_ID.trim();
    }
    return {
        targetProjectId: effectiveProjectId,
        isEmulatorActive: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
        emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || null,
        hasServiceAccount: Boolean(sa && (sa.client_email || sa.project_id)),
        serviceAccountEmail: sa?.client_email || null,
        serviceAccountProjectId: sa?.project_id || null,
        matchesProjectId: Boolean(effectiveProjectId && sa?.project_id && sa.project_id === effectiveProjectId)
    };
}

export function getFirestoreBaseUrl(projectId = null) {
    const target = projectId || process.env.FIREBASE_PROJECT_ID;
    if (!target) {
        throw new Error("[Firebase Security] FATAL: projectId is mandatory for getFirestoreBaseUrl. No project ID configured.");
    }
    const validated = validateProjectIdFormat(target, "projectId");
    if (process.env.FIRESTORE_EMULATOR_HOST) {
        return `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${validated}/databases/(default)/documents`;
    }
    return `https://firestore.googleapis.com/v1/projects/${validated}/databases/(default)/documents`;
}

export function getFirestoreCommitUrl(projectId = null) {
    const target = projectId || process.env.FIREBASE_PROJECT_ID;
    if (!target) {
        throw new Error("[Firebase Security] FATAL: projectId is mandatory for getFirestoreCommitUrl. No project ID configured.");
    }
    const validated = validateProjectIdFormat(target, "projectId");
    if (process.env.FIRESTORE_EMULATOR_HOST) {
        return `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${validated}/databases/(default)/documents:commit`;
    }
    return `https://firestore.googleapis.com/v1/projects/${validated}/databases/(default)/documents:commit`;
}

export async function getFirestoreServerAuthHeaders(expectedProjectId = null) {
    // 0. Hard guard: Test and emulator shortcuts must NEVER leak into production execution
    if (process.env.NODE_ENV === "production") {
        if (process.env.FIRESTORE_EMULATOR_HOST) {
            throw new Error("[Firebase Security] FATAL: FIRESTORE_EMULATOR_HOST is strictly forbidden in NODE_ENV=production. Emulator paths cannot leak into production execution.");
        }
    }

    // Emulator bypass: Emulator accepts requests without OAuth token or with generic token
    if (process.env.FIRESTORE_EMULATOR_HOST) {
        const effectiveProject = expectedProjectId || process.env.FIREBASE_PROJECT_ID;
        if (effectiveProject) {
            const validated = validateProjectIdFormat(effectiveProject, "expectedProjectId");
            if (validated === "pyqs-hub-43bed") {
                throw new Error("[Firebase Security] FATAL: Production project 'pyqs-hub-43bed' cannot use emulator authentication bypass! Emulator bypass is restricted to non-production projects.");
            }
        }
        return { "Authorization": "Bearer owner" };
    }

    // In unit testing mode without cloud writes, do not use real service account keys or make cloud auth calls
    if (process.env.NODE_ENV === "test" && !process.env.ALLOW_STAGING_CLOUD_WRITES) {
        const effectiveProject = expectedProjectId || process.env.FIREBASE_PROJECT_ID;
        if (effectiveProject) {
            const validated = validateProjectIdFormat(effectiveProject, "expectedProjectId");
            if (validated === "pyqs-hub-43bed") {
                throw new Error("[Firebase Security] FATAL: Production project 'pyqs-hub-43bed' cannot use test auth shortcut! Fake test tokens are strictly forbidden for production.");
            }
        }
        return { "Authorization": "Bearer test-auth-token" };
    }

    // Direct Google OAuth access token if explicitly supplied
    if (process.env.GOOGLE_ACCESS_TOKEN) {
        return { "Authorization": `Bearer ${process.env.GOOGLE_ACCESS_TOKEN.trim()}` };
    }

    // Cached access token check
    if (cachedServerAccessToken && Date.now() < cachedServerTokenExpiresAt) {
        return { "Authorization": `Bearer ${cachedServerAccessToken}` };
    }

    // Cloud authentication requires mandatory, explicit expectedProjectId.
    // Never infer solely from an optional environment variable.
    if (!expectedProjectId) {
        throw new Error("[Firebase Security] FATAL: expectedProjectId is mandatory for cloud Firestore authentication. Inferring the expected project solely from optional environment variables is strictly forbidden.");
    }
    const validatedProject = validateProjectIdFormat(expectedProjectId, "expectedProjectId");

    const rawSa = loadServiceAccountKey();
    if (!rawSa || !rawSa.client_email || !rawSa.private_key) {
        return null;
    }

    const sa = validateServiceAccountCredentials(rawSa, validatedProject);

    try {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
            iss: sa.client_email,
            sub: sa.client_email,
            aud: sa.token_uri || "https://oauth2.googleapis.com/token",
            iat: now,
            exp: now + 3600,
            scope: "https://www.googleapis.com/auth/datastore"
        })).toString("base64url");

        const sign = createSign("RSA-SHA256");
        sign.update(`${header}.${payload}`);
        const signature = sign.sign(sa.private_key, "base64url");
        const jwt = `${header}.${payload}.${signature}`;

        const tokenUrl = sa.token_uri || "https://oauth2.googleapis.com/token";
        const tokenRes = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: jwt
            })
        });

        if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            console.error(`[Firebase Security] Service account OAuth2 token request rejected (${tokenRes.status}):`, errBody);
            return null;
        }

        const tokenData = await tokenRes.json();
        if (tokenData && tokenData.access_token) {
            cachedServerAccessToken = tokenData.access_token;
            const expiresIn = Number(tokenData.expires_in) || 3600;
            cachedServerTokenExpiresAt = Date.now() + Math.max(expiresIn - 120, 60) * 1000;
            return { "Authorization": `Bearer ${cachedServerAccessToken}` };
        }
    } catch (err) {
        console.error("[Firebase Security] Error exchanging service account JWT for access token:", err.message);
        return null;
    }

    return null;
}

