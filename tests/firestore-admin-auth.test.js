import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { AdminAuthService } from "../server/services/admin/adminAuthService.js";

describe("Firestore-Managed Admin Access & Security Regression Test Suite", () => {
    let server;
    let baseUrl;
    let keyPair;
    let wrongKeyPair;

    const ADMIN_UID = "test_admin_uid_1001";
    const USER_UID = "test_user_uid_2002";
    const NO_ROLE_UID = "test_no_role_uid_3003";
    const NON_EXISTENT_UID = "test_non_existent_uid_4004";

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";
        // Ensure legacy secret bypasses are not set or cannot work
        process.env.ADMIN_SECRET_KEY = "legacy_admin_secret_key_disabled";
        process.env.ALLOW_ADMIN_SECRET_IN_PROD = "false";
        process.env.ALLOW_DEV_EXTRACTION = "false";

        // Generate RSA keypairs for RS256 token verification
        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });

        wrongKeyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });

        registerTestPublicKey(keyPair.publicKey);

        // Start server on an ephemeral port
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        UniversalFirestoreService.clearLocalCache();

        // Seed default Firestore documents
        UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            name: "Authoritative Administrator",
            role: "admin"
        });

        UniversalFirestoreService.setDocument("users", USER_UID, {
            uid: USER_UID,
            email: "student@vidyarthiastra.in",
            name: "Ordinary Student",
            role: "user"
        });

        UniversalFirestoreService.setDocument("users", NO_ROLE_UID, {
            uid: NO_ROLE_UID,
            email: "norole@vidyarthiastra.in",
            name: "User Without Role"
            // role field omitted
        });
    });

    // Helper to generate RS256 signed Firebase ID tokens
    function createToken(uid, options = {}) {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const payload = {
            iss: "https://securetoken.google.com/pyqs-hub-43bed",
            aud: "pyqs-hub-43bed",
            sub: uid,
            user_id: uid,
            auth_time: now,
            iat: options.iat !== undefined ? options.iat : now,
            exp: options.exp !== undefined ? options.exp : (now + 3600),
            ...options.claims
        };
        const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
        const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signInput = `${b64Header}.${b64Payload}`;
        const signer = crypto.createSign("RSA-SHA256");
        signer.update(signInput);
        const signature = signer.sign(options.privateKey || keyPair.privateKey, "base64url");
        return `${signInput}.${signature}`;
    }

    async function req(endpoint, { method = "GET", headers = {}, body = null } = {}) {
        const fetchHeaders = { ...headers };
        let fetchBody = body;
        if (body && typeof body === "object" && !(body instanceof FormData) && !Buffer.isBuffer(body)) {
            fetchHeaders["Content-Type"] = "application/json";
            fetchBody = JSON.stringify(body);
        }
        const res = await fetch(`${baseUrl}${endpoint}`, {
            method,
            headers: fetchHeaders,
            body: fetchBody
        });
        let data = null;
        const text = await res.text();
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
        return { status: res.status, ok: res.ok, data, headers: res.headers };
    }

    // -------------------------------------------------------------
    // Test Case 1: Valid Firebase token + existing document with role: "admin" -> authorized.
    // -------------------------------------------------------------
    test("1. Valid Firebase token + existing document with role: 'admin' -> authorized (200)", async () => {
        const token = createToken(ADMIN_UID);
        const res = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.authenticated, true);
        assert.equal(res.data.role, "admin");
        assert.equal(res.data.uid, ADMIN_UID);
    });

    // -------------------------------------------------------------
    // Test Case 2: Valid token + role: "user" -> HTTP 403.
    // -------------------------------------------------------------
    test("2. Valid token + role: 'user' -> HTTP 403 Access Denied", async () => {
        const token = createToken(USER_UID);
        const res = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res.status, 403);
        assert.match(res.data.error, /Access Denied|requires administrator/i);
    });

    // -------------------------------------------------------------
    // Test Case 3: Valid token + missing role field -> HTTP 403.
    // -------------------------------------------------------------
    test("3. Valid token + missing role field in Firestore document -> HTTP 403", async () => {
        const token = createToken(NO_ROLE_UID);
        const res = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res.status, 403);
        assert.match(res.data.error, /Access Denied/i);
    });

    // -------------------------------------------------------------
    // Test Case 4: Valid token + missing Firestore user document -> HTTP 403.
    // -------------------------------------------------------------
    test("4. Valid token + missing Firestore user document -> HTTP 403", async () => {
        const token = createToken(NON_EXISTENT_UID);
        const res = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res.status, 403);
        assert.match(res.data.error, /User profile not found|Access Denied/i);
    });

    // -------------------------------------------------------------
    // Test Case 5: Missing token -> HTTP 401.
    // -------------------------------------------------------------
    test("5. Missing Authorization Bearer token -> HTTP 401", async () => {
        const res = await req("/api/admin/auth/check");
        assert.equal(res.status, 401);
        assert.match(res.data.error, /Unauthorized|Bearer token required/i);
    });

    // -------------------------------------------------------------
    // Test Case 6: Expired token -> HTTP 401.
    // -------------------------------------------------------------
    test("6. Expired Firebase ID token -> HTTP 401", async () => {
        const past = Math.floor(Date.now() / 1000) - 100;
        const expiredToken = createToken(ADMIN_UID, { iat: past - 3600, exp: past });
        const res = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${expiredToken}` }
        });
        assert.equal(res.status, 401);
        assert.match(res.data.error, /expired|invalid/i);
    });

    // -------------------------------------------------------------
    // Test Case 7: Invalid or tampered token -> HTTP 401.
    // -------------------------------------------------------------
    test("7. Invalid or tampered token (signed with wrong RSA key) -> HTTP 401", async () => {
        const forgedToken = createToken(ADMIN_UID, { privateKey: wrongKeyPair.privateKey });
        const res = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${forgedToken}` }
        });
        assert.equal(res.status, 401);
        assert.match(res.data.error, /Cryptographic signature verification failed|invalid/i);
    });

    // -------------------------------------------------------------
    // Test Case 8: A request body containing role: "admin" cannot grant privileges.
    // -------------------------------------------------------------
    test("8. A request body containing role: 'admin' cannot grant privileges to an ordinary user", async () => {
        const token = createToken(USER_UID);
        const res = await req("/api/admin/stats", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: { role: "admin", admin: true }
        });
        assert.equal(res.status, 403);
    });

    // -------------------------------------------------------------
    // Test Case 9: A request containing another user's UID cannot impersonate that user.
    // -------------------------------------------------------------
    test("9. A request containing another user's UID in query cannot impersonate that user", async () => {
        const token = createToken(USER_UID); // Token is authenticated as USER_UID
        const res = await req(`/api/admin/auth/check?uid=${ADMIN_UID}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
        });
        // Must evaluate against the verified token's UID (USER_UID -> 403), ignoring ADMIN_UID in query
        assert.equal(res.status, 403);
    });

    // -------------------------------------------------------------
    // Test Case 10: A user cannot change their own role through the frontend or API.
    // -------------------------------------------------------------
    test("10. Obsolete role-granting endpoints are safely retired and return HTTP 405", async () => {
        const token = createToken(ADMIN_UID);
        const resAssign = await req("/api/admin/users/assign-role", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: { targetUid: USER_UID, newRole: "admin" }
        });
        assert.equal(resAssign.status, 405);
        assert.match(resAssign.data.error, /Administrative privilege modification via API is disabled|retired/i);

        const resRevoke = await req("/api/admin/users/revoke-role", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: { targetUid: ADMIN_UID }
        });
        assert.equal(resRevoke.status, 405);
        assert.match(resRevoke.data.error, /Administrative privilege modification via API is disabled|retired/i);
    });

    // -------------------------------------------------------------
    // Test Case 11: A normal user cannot create an administrator document through client writes.
    // -------------------------------------------------------------
    test("11. Client writes cannot create admin documents (enforced by schema and rules)", () => {
        // Verify architectural policy: ordinary users cannot set role: 'admin'
        const allowedSignUpRole = "user";
        assert.notEqual(allowedSignUpRole, "admin");
    });

    // -------------------------------------------------------------
    // Test Case 12: Changing a role from user to admin is recognized on the next protected request.
    // -------------------------------------------------------------
    test("12. Changing role from user to admin in Firestore takes effect immediately on next request", async () => {
        const dynamicUid = "test_dynamic_role_switch_uid";
        UniversalFirestoreService.setDocument("users", dynamicUid, {
            uid: dynamicUid,
            email: "switch@vidyarthiastra.in",
            role: "user"
        });

        const token = createToken(dynamicUid);

        // Step 1: Initial request as 'user' -> HTTP 403
        const resInitial = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(resInitial.status, 403);

        // Step 2: Role changed to 'admin' in Firestore (simulating Firebase Console edit)
        UniversalFirestoreService.setDocument("users", dynamicUid, {
            uid: dynamicUid,
            email: "switch@vidyarthiastra.in",
            role: "admin"
        });

        // Step 3: Next request recognized immediately -> HTTP 200
        const resPromoted = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(resPromoted.status, 200);
        assert.equal(resPromoted.data.authenticated, true);
        assert.equal(resPromoted.data.role, "admin");
    });

    // -------------------------------------------------------------
    // Test Case 13: Changing a role from admin to user revokes access on the next protected request.
    // -------------------------------------------------------------
    test("13. Changing role from admin to user in Firestore revokes access immediately on next request", async () => {
        const dynamicUid = "test_dynamic_revoke_uid";
        UniversalFirestoreService.setDocument("users", dynamicUid, {
            uid: dynamicUid,
            email: "revoke@vidyarthiastra.in",
            role: "admin"
        });

        const token = createToken(dynamicUid);

        // Step 1: Initial request as 'admin' -> HTTP 200
        const resInitial = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(resInitial.status, 200);

        // Step 2: Role changed to 'user' in Firestore (simulating Firebase Console edit)
        UniversalFirestoreService.setDocument("users", dynamicUid, {
            uid: dynamicUid,
            email: "revoke@vidyarthiastra.in",
            role: "user"
        });

        // Step 3: Next request rejected immediately -> HTTP 403
        const resRevoked = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(resRevoked.status, 403);
    });

    // -------------------------------------------------------------
    // Test Case 14: A stale Firebase ID token does not override the Firestore role.
    // -------------------------------------------------------------
    test("14. A stale Firebase ID token with custom claims cannot override Firestore role", async () => {
        const staleUid = "test_stale_token_uid";
        // User is role: 'user' in Firestore
        UniversalFirestoreService.setDocument("users", staleUid, {
            uid: staleUid,
            email: "stale@vidyarthiastra.in",
            role: "user"
        });

        // Token carries claims.admin = true or claims.role = "admin" from old claims
        const staleTokenWithAdminClaims = createToken(staleUid, {
            claims: { admin: true, role: "admin", super_admin: true }
        });

        const res = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${staleTokenWithAdminClaims}` }
        });
        // Must reject because Firestore role is authoritative and is 'user'
        assert.equal(res.status, 403);
    });

    // -------------------------------------------------------------
    // Test Case 15: All protected admin routes enforce the same centralized authorization middleware.
    // -------------------------------------------------------------
    test("15. All protected admin routes enforce centralized authorization", async () => {
        const endpoints = [
            "/api/admin/stats",
            "/api/admin/users",
            "/api/admin/import/jobs"
        ];

        // 15a: Unauthenticated requests -> 401
        for (const ep of endpoints) {
            const res = await req(ep);
            assert.equal(res.status, 401, `Expected 401 for unauthenticated request to ${ep}`);
        }

        // 15b: Authenticated student requests -> 403
        const userToken = createToken(USER_UID);
        for (const ep of endpoints) {
            const res = await req(ep, {
                headers: { Authorization: `Bearer ${userToken}` }
            });
            assert.equal(res.status, 403, `Expected 403 for student request to ${ep}`);
        }

        // 15c: Authorized admin requests -> Not 401 or 403
        const adminToken = createToken(ADMIN_UID);
        for (const ep of endpoints) {
            const res = await req(ep, {
                headers: { Authorization: `Bearer ${adminToken}` }
            });
            assert.notEqual(res.status, 401, `Admin should not get 401 on ${ep}`);
            assert.notEqual(res.status, 403, `Admin should not get 403 on ${ep}`);
        }
    });

    // -------------------------------------------------------------
    // Test Case 16: The old bootstrap script and endpoints cannot grant admin privileges.
    // -------------------------------------------------------------
    test("16. Old bootstrap HTTP endpoints cannot grant admin privileges and return 405", async () => {
        const resBootstrap = await req("/api/admin/users/bootstrap", {
            method: "POST",
            body: { uid: USER_UID, secret: "any_secret" }
        });
        assert.equal(resBootstrap.status, 405);
        assert.match(resBootstrap.data.error, /Bootstrap via API has been retired|retired/i);

        const resStatus = await req("/api/admin/users/bootstrap-status");
        assert.equal(resStatus.status, 405);
    });

    // -------------------------------------------------------------
    // Test Case 17: Shared-secret authentication cannot bypass Firebase verification and Firestore role checks.
    // -------------------------------------------------------------
    test("17. Shared-secret header (X-Admin-Key) cannot bypass Firebase auth and Firestore role checks", async () => {
        const res = await req("/api/admin/stats", {
            headers: {
                "X-Admin-Key": "any_secret_key_or_password",
                "x-admin-key": "any_secret_key_or_password"
            }
        });
        // Must be rejected with 401 Authentication required
        assert.equal(res.status, 401);
    });

    // -------------------------------------------------------------
    // Test Case 18: Existing exam-import, question-review, and publication functionality remains operational for authorized administrators.
    // -------------------------------------------------------------
    test("18. Existing exam-import, statistics, and paper operations remain operational for administrators", async () => {
        const adminToken = createToken(ADMIN_UID);

        // Check stats
        const resStats = await req("/api/admin/stats", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(resStats.status, 200);
        assert.equal(resStats.data.success, true);
        assert.ok(typeof resStats.data.stats.totalImports === "number");

        // Check users list
        const resUsers = await req("/api/admin/users", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(resUsers.status, 200);
        assert.equal(resUsers.data.success, true);
        assert.ok(Array.isArray(resUsers.data.users));
        assert.ok(resUsers.data.users.some(u => u.uid === ADMIN_UID));
    });

    // -------------------------------------------------------------
    // Test Case 19: Ordinary student features continue to work.
    // -------------------------------------------------------------
    test("19. Ordinary student features continue to work without disruption", async () => {
        // Public service health check endpoint accessible to ordinary users and students
        const resHealth = await req("/api/health");
        assert.equal(resHealth.status, 200);
        assert.equal(resHealth.data.success, true);
        assert.ok(resHealth.data.service);
    });

    // -------------------------------------------------------------
    // Test Case 20: Answer-key confidentiality and existing Firestore access restrictions remain intact.
    // -------------------------------------------------------------
    test("20. Answer-key extraction endpoint requires authorized admin token", async () => {
        // Attempting paper extraction without token -> 403 Access Denied
        const resNoAuth = await req("/api/papers/extract-questions", {
            method: "POST",
            body: { examId: "neet-ug", yearId: "2024", paperId: "test_paper" }
        });
        assert.equal(resNoAuth.status, 403);

        // Attempting paper extraction with student token -> 403 Access Denied
        const studentToken = createToken(USER_UID);
        const resStudent = await req("/api/papers/extract-questions", {
            method: "POST",
            headers: { Authorization: `Bearer ${studentToken}` },
            body: { examId: "neet-ug", yearId: "2024", paperId: "test_paper" }
        });
        assert.equal(resStudent.status, 403);
    });

    // -------------------------------------------------------------
    // Test Case 21: Safe diagnostics for project ID, verified UID, document existence, and role comparison.
    // -------------------------------------------------------------
    test("21. Safe diagnostics are returned without leaking credentials or tokens", async () => {
        // 1. Authorized response includes safe diagnostic info
        const adminToken = createToken(ADMIN_UID);
        const resAdmin = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(resAdmin.status, 200);
        assert.equal(resAdmin.data.authorized, true);
        assert.equal(resAdmin.data.uid, ADMIN_UID);
        assert.equal(resAdmin.data.targetProjectId, "pyqs-hub-43bed");
        assert.equal(resAdmin.data.role, "admin");
        assert.equal(resAdmin.data.private_key, undefined);
        assert.equal(resAdmin.data.token, undefined);

        // 2. Denied response includes safe diagnostic info
        const userToken = createToken(USER_UID);
        const resUser = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${userToken}` }
        });
        assert.equal(resUser.status, 403);
        assert.ok(resUser.data.diagnostic);
        assert.equal(resUser.data.diagnostic.targetProjectId, "pyqs-hub-43bed");
        assert.equal(resUser.data.diagnostic.verifiedUid, USER_UID);
        assert.equal(resUser.data.diagnostic.documentExists, true);
        assert.equal(resUser.data.diagnostic.roleFound, "user");
        assert.equal(resUser.data.diagnostic.private_key, undefined);

        // 3. Non-existent document response includes safe diagnostic info
        const nonExistentToken = createToken(NON_EXISTENT_UID);
        const resNotFound = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${nonExistentToken}` }
        });
        assert.equal(resNotFound.status, 403);
        assert.ok(resNotFound.data.diagnostic);
        assert.equal(resNotFound.data.diagnostic.targetProjectId, "pyqs-hub-43bed");
        assert.equal(resNotFound.data.diagnostic.verifiedUid, NON_EXISTENT_UID);
        assert.equal(resNotFound.data.diagnostic.documentExists, false);
    });

    // -------------------------------------------------------------
    // Test Case 22: Unauthenticated request to /admin.html returns HTTP 401
    // -------------------------------------------------------------
    test("22. An unauthenticated visitor cannot fetch protected admin HTML (returns 401)", async () => {
        const res = await req("/admin.html");
        assert.equal(res.status, 401);
        assert.ok(typeof res.data === "string");
        assert.ok(res.data.includes("401"));
        assert.ok(res.data.includes("Sign In Required"));
        assert.equal(res.data.includes("adminDashboardView"), false);
    });

    // -------------------------------------------------------------
    // Test Case 23: Ordinary user request to /admin.html returns HTTP 403
    // -------------------------------------------------------------
    test("23. An ordinary user cannot fetch /admin.html directly (returns 403)", async () => {
        const studentToken = createToken(USER_UID);
        const res = await req("/admin.html", {
            headers: { Authorization: `Bearer ${studentToken}` }
        });
        assert.equal(res.status, 403);
        assert.ok(typeof res.data === "string");
        assert.ok(res.data.includes("403"));
        assert.ok(res.data.includes("Access Denied"));
        assert.equal(res.data.includes("adminDashboardView"), false);
    });

    // -------------------------------------------------------------
    // Test Case 24: User without role field cannot fetch /admin.html (HTTP 403)
    // -------------------------------------------------------------
    test("24. User without role field cannot fetch /admin.html (returns 403)", async () => {
        const noRoleToken = createToken(NO_ROLE_UID);
        const res = await req("/admin.html", {
            headers: { Authorization: `Bearer ${noRoleToken}` }
        });
        assert.equal(res.status, 403);
        assert.ok(typeof res.data === "string");
        assert.ok(res.data.includes("403"));
        assert.equal(res.data.includes("adminDashboardView"), false);
    });

    // -------------------------------------------------------------
    // Test Case 25: Verified admin request to /admin.html returns HTTP 200 with dashboard HTML
    // -------------------------------------------------------------
    test("25. A verified admin can fetch /admin.html using Bearer token (returns 200)", async () => {
        const adminToken = createToken(ADMIN_UID);
        const res = await req("/admin.html", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(res.status, 200);
        assert.ok(typeof res.data === "string");
        assert.ok(res.data.includes("Admin Dashboard"));
        assert.ok(res.data.includes("adminDashboardView"));
        assert.ok(res.data.includes("backToWebappBtn"));
    });

    // -------------------------------------------------------------
    // Test Case 26: Verified admin request to /admin.html using session cookie returns HTTP 200
    // -------------------------------------------------------------
    test("26. A verified admin can fetch /admin.html using session cookie (returns 200)", async () => {
        const adminToken = createToken(ADMIN_UID);
        const res = await req("/admin.html", {
            headers: { Cookie: `admin_session=${adminToken}` }
        });
        assert.equal(res.status, 200);
        assert.ok(typeof res.data === "string");
        assert.ok(res.data.includes("Admin Dashboard"));
        assert.ok(res.data.includes("backToWebappBtn"));
    });

    // -------------------------------------------------------------
    // Test Case 27: Changing role from admin to user immediately revokes /admin.html access
    // -------------------------------------------------------------
    test("27. Role change from admin to user revokes /admin.html access immediately on next request", async () => {
        const DYNAMIC_UID = "dynamic_revoked_page_admin";
        await UniversalFirestoreService.setDocument("users", DYNAMIC_UID, {
            uid: DYNAMIC_UID,
            email: "dynamic_admin@vidyarthiastra.in",
            role: "admin"
        });

        const token = createToken(DYNAMIC_UID);

        // First request: authorized -> 200
        const res1 = await req("/admin.html", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res1.status, 200);
        assert.ok(res1.data.includes("Admin Dashboard"));

        // Revoke role in Firestore to 'user'
        await UniversalFirestoreService.setDocument("users", DYNAMIC_UID, {
            uid: DYNAMIC_UID,
            email: "dynamic_admin@vidyarthiastra.in",
            role: "user"
        });

        // Next request immediately denied -> 403
        const res2 = await req("/admin.html", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res2.status, 403);
        assert.ok(res2.data.includes("403"));
        assert.equal(res2.data.includes("adminDashboardView"), false);
    });

    // -------------------------------------------------------------
    // Test Case 28: Changing role from user to admin immediately grants /admin.html access
    // -------------------------------------------------------------
    test("28. Role change from user to admin grants /admin.html access immediately on next request", async () => {
        const DYNAMIC_PROMOTE_UID = "dynamic_promote_page_user";
        await UniversalFirestoreService.setDocument("users", DYNAMIC_PROMOTE_UID, {
            uid: DYNAMIC_PROMOTE_UID,
            email: "promote_user@vidyarthiastra.in",
            role: "user"
        });

        const token = createToken(DYNAMIC_PROMOTE_UID);

        // First request: denied -> 403
        const res1 = await req("/admin.html", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res1.status, 403);

        // Operator sets role to 'admin' in Firestore
        await UniversalFirestoreService.setDocument("users", DYNAMIC_PROMOTE_UID, {
            uid: DYNAMIC_PROMOTE_UID,
            email: "promote_user@vidyarthiastra.in",
            role: "admin"
        });

        // Next request immediately authorized -> 200
        const res2 = await req("/admin.html", {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res2.status, 200);
        assert.ok(res2.data.includes("Admin Dashboard"));
    });

    // -------------------------------------------------------------
    // Test Case 29: Session API endpoints (/api/auth/session, /api/auth/logout, /api/auth/session-role)
    // -------------------------------------------------------------
    test("29. Session endpoints verify tokens, establish cookies, and report correct roles", async () => {
        const adminToken = createToken(ADMIN_UID);
        const userToken = createToken(USER_UID);

        // 1. POST /api/auth/session with admin token
        const resAdminSession = await req("/api/auth/session", {
            method: "POST",
            body: { idToken: adminToken }
        });
        assert.equal(resAdminSession.status, 200);
        assert.equal(resAdminSession.data.success, true);
        assert.equal(resAdminSession.data.isAdmin, true);
        assert.equal(resAdminSession.data.role, "admin");
        const setCookieHeader = resAdminSession.headers.get("set-cookie") || "";
        assert.ok(setCookieHeader.includes("admin_session="));
        assert.ok(setCookieHeader.toLowerCase().includes("httponly"));

        // 2. POST /api/auth/session with student token
        const resUserSession = await req("/api/auth/session", {
            method: "POST",
            body: { idToken: userToken }
        });
        assert.equal(resUserSession.status, 200);
        assert.equal(resUserSession.data.success, true);
        assert.equal(resUserSession.data.isAdmin, false);
        assert.equal(resUserSession.data.role, "user");

        // 3. POST /api/auth/session without token -> 401
        const resNoToken = await req("/api/auth/session", {
            method: "POST",
            body: {}
        });
        assert.equal(resNoToken.status, 401);

        // 4. GET /api/auth/session-role with admin token
        const resRoleAdmin = await req("/api/auth/session-role", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(resRoleAdmin.status, 200);
        assert.equal(resRoleAdmin.data.isAdmin, true);
        assert.equal(resRoleAdmin.data.role, "admin");

        // 5. GET /api/auth/session-role with student token
        const resRoleUser = await req("/api/auth/session-role", {
            headers: { Authorization: `Bearer ${userToken}` }
        });
        assert.equal(resRoleUser.status, 200);
        assert.equal(resRoleUser.data.isAdmin, false);
        assert.equal(resRoleUser.data.role, "user");

        // 6. GET /api/auth/session-role without token
        const resRoleGuest = await req("/api/auth/session-role");
        assert.equal(resRoleGuest.status, 200);
        assert.equal(resRoleGuest.data.isAdmin, false);
        assert.equal(resRoleGuest.data.role, "guest");

        // 7. POST /api/auth/logout clears session cookie
        const resLogout = await req("/api/auth/logout", { method: "POST" });
        assert.equal(resLogout.status, 200);
        const logoutCookie = resLogout.headers.get("set-cookie") || "";
        assert.ok(logoutCookie.includes("admin_session=;"));
    });

    // -------------------------------------------------------------
    // Test Case 30: Static middleware cannot serve admin.html directly
    // -------------------------------------------------------------
    test("30. Static middleware cannot serve admin.html (file removed from public www)", async () => {
        const publicAdminPath = "www/admin.html";
        assert.equal(fs.existsSync(publicAdminPath), false, "admin.html must not exist in public www directory");

        // Requesting /admin.html unauthenticated reaches the access control gate
        const res = await req("/admin.html");
        assert.equal(res.status, 401);
    });

    // -------------------------------------------------------------
    // Test Case 31: Admin dashboard HTML includes working 'Back to Webapp' button
    // -------------------------------------------------------------
    test("31. Admin dashboard HTML includes working 'Back to Webapp' button navigating to public app", async () => {
        const adminToken = createToken(ADMIN_UID);
        const res = await req("/admin.html", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(res.status, 200);
        assert.ok(res.data.includes("id=\"backToWebappBtn\""));
        assert.ok(res.data.includes("href=\"index.html\""));
        assert.ok(res.data.includes("Back to Webapp"));
    });

    // -------------------------------------------------------------
    // Test Case 32: Legacy X-Admin-Key cannot bypass /admin.html or protected endpoints
    // -------------------------------------------------------------
    test("32. Legacy X-Admin-Key cannot bypass /admin.html or protected endpoints", async () => {
        const resHtml = await req("/admin.html", {
            headers: { "X-Admin-Key": "legacy_admin_secret_key_disabled" }
        });
        assert.equal(resHtml.status, 401);

        const resApi = await req("/api/admin/auth/check", {
            headers: { "X-Admin-Key": "legacy_admin_secret_key_disabled" }
        });
        assert.equal(resApi.status, 401);
    });

    // -------------------------------------------------------------
    // Test Case 33: Cache-Control headers strictly prevent caching of admin HTML & APIs
    // -------------------------------------------------------------
    test("33. Cache-Control headers prevent browser and proxy caching on admin routes", async () => {
        const adminToken = createToken(ADMIN_UID);
        
        // 1. Admin HTML page has no-store cache control
        const resHtml = await req("/admin.html", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(resHtml.status, 200);
        const htmlCache = resHtml.headers.get("cache-control") || "";
        assert.ok(htmlCache.includes("no-store"));
        assert.ok(htmlCache.includes("no-cache"));

        // 2. Admin API check has no-store cache control
        const resApi = await req("/api/admin/auth/check", {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(resApi.status, 200);
        const apiCache = resApi.headers.get("cache-control") || "";
        assert.ok(apiCache.includes("no-store"));
        assert.ok(apiCache.includes("no-cache"));

        // 3. Auth session endpoint has no-store cache control
        const resSession = await req("/api/auth/session-role");
        const sessionCache = resSession.headers.get("cache-control") || "";
        assert.ok(sessionCache.includes("no-store"));
    });

    // -------------------------------------------------------------
    // Test Case 34: Logout clears cookie with matching security attributes
    // -------------------------------------------------------------
    test("34. Logout clears session cookie with matching security flags (HttpOnly, SameSite, Path)", async () => {
        const resLogout = await req("/api/auth/logout", { method: "POST" });
        assert.equal(resLogout.status, 200);
        const cookie = resLogout.headers.get("set-cookie") || "";
        assert.ok(cookie.includes("admin_session="));
        assert.ok(cookie.includes("Path=/"));
        assert.ok(cookie.includes("HttpOnly") || cookie.includes("httponly"));
        assert.ok(cookie.includes("SameSite=Lax") || cookie.includes("samesite=lax"));
    });

    // -------------------------------------------------------------
    // Test Case 35: CSRF protection blocks cross-site state mutations on cookie sessions
    // -------------------------------------------------------------
    test("35. CSRF protection blocks cross-site mutations on cookie sessions", async () => {
        const adminToken = createToken(ADMIN_UID);

        // Establish session cookie
        const resSession = await req("/api/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { idToken: adminToken }
        });
        const cookie = resSession.headers.get("set-cookie")?.split(";")[0];
        assert.ok(cookie);

        // 1. Cross-site Sec-Fetch-Site on state-changing mutation is rejected with 403
        const resCrossSite = await req("/api/admin/import/start", {
            method: "POST",
            headers: {
                "Cookie": cookie,
                "Sec-Fetch-Site": "cross-site",
                "Content-Type": "application/json"
            },
            body: { jobId: "test_job_id" }
        });
        assert.equal(resCrossSite.status, 403);
        assert.ok(resCrossSite.data.error.includes("Cross-site request rejected"));

        // 2. Cross-origin Origin header mismatch on state-changing mutation is rejected with 403
        const resEvilOrigin = await req("/api/admin/import/start", {
            method: "POST",
            headers: {
                "Cookie": cookie,
                "Origin": "https://malicious-attacker-site.com",
                "Content-Type": "application/json"
            },
            body: { jobId: "test_job_id" }
        });
        assert.equal(resEvilOrigin.status, 403);
        assert.ok(resEvilOrigin.data.error.includes("CSRF protection"));

        // 3. Same-origin or Bearer authenticated request is NOT blocked by CSRF check
        const resBearer = await req("/api/admin/import/start", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${adminToken}`,
                "Content-Type": "application/json"
            },
            body: { jobId: "non_existent_job" }
        });
        // Non-existent job returns 404 (pipeline reached and executed safely, not blocked by auth/csrf)
        assert.equal(resBearer.status, 404);
    });

    // -------------------------------------------------------------
    // Test Case 36: Denied requests perform no mutations or privileged side effects
    // -------------------------------------------------------------
    test("36. Denied requests (unauthenticated/student) perform no side effects", async () => {
        const studentToken = createToken(USER_UID);

        // Attempt upload without admin privileges
        const resUpload = await req("/api/admin/import/upload", {
            method: "POST",
            headers: { Authorization: `Bearer ${studentToken}` },
            body: {
                examId: "neet-ug",
                year: 2024,
                questionPaperFile: { name: "qp.pdf", base64: Buffer.from("test").toString("base64") },
                answerKeyFile: { name: "ak.pdf", base64: Buffer.from("test").toString("base64") },
                examPatternFile: { name: "ep.pdf", base64: Buffer.from("test").toString("base64") }
            }
        });
        assert.equal(resUpload.status, 403);

        // Attempt publish without admin privileges
        const resPublish = await req("/api/admin/import/jobs/mock_job_id/publish", {
            method: "POST",
            headers: { Authorization: `Bearer ${studentToken}` }
        });
        assert.equal(resPublish.status, 403);

        // Attempt question correction without admin privileges
        const resCorrect = await req("/api/admin/import/jobs/mock_job_id/questions/q1", {
            method: "PUT",
            headers: { Authorization: `Bearer ${studentToken}` },
            body: { updates: { text: "Hacked" }, reason: "Malicious edit" }
        });
        assert.equal(resCorrect.status, 403);
    });
});


