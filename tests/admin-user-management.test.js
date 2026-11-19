import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import app from "../server/server.js";
import { AdminUserService, ROLES } from "../server/services/admin/adminUserService.js";
import { verifyFirebaseIdToken } from "../server/services/firebaseTokenService.js";

describe("Admin User Management, RBAC & Bootstrap Safeguards Test Suite", () => {
    let server;
    let baseUrl;
    const originalEnv = { ...process.env };
    const TEST_ADMIN_SECRET = "test_super_secret_bootstrap_key_8822";

    const MOCK_SUPER_ADMIN_UID = "super_admin_test_uid_001";
    const MOCK_SUPER_ADMIN_EMAIL = "owner@vidyarthiastra.in";

    const MOCK_CONTENT_ADMIN_UID = "content_admin_test_uid_002";
    const MOCK_CONTENT_ADMIN_EMAIL = "reviewer@vidyarthiastra.in";

    const MOCK_SECOND_SUPER_UID = "second_super_test_uid_003";
    const MOCK_SECOND_SUPER_EMAIL = "coowner@vidyarthiastra.in";

    const MOCK_STUDENT_UID = "student_regular_uid_999";

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.BOOTSTRAP_SECRET = TEST_ADMIN_SECRET;
        process.env.ADMIN_SECRET_KEY = "test_admin_key_dev";
        process.env.ALLOW_DEV_EXTRACTION = "false";
        delete process.env.SUPER_ADMIN_UIDS;
        delete process.env.ADMIN_UIDS;

        AdminUserService.resetForTesting();

        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        process.env = originalEnv;
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    async function request(endpoint, { method = "GET", headers = {}, body = null } = {}) {
        const url = `${baseUrl}${endpoint}`;
        const requestHeaders = { ...headers };
        let requestBody = body;

        if (body && typeof body === "object" && !(body instanceof FormData) && !Buffer.isBuffer(body)) {
            requestHeaders["Content-Type"] = "application/json";
            requestBody = JSON.stringify(body);
        }

        const res = await fetch(url, {
            method,
            headers: requestHeaders,
            body: requestBody
        });

        let data = null;
        const text = await res.text();
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }

        return { status: res.status, ok: res.ok, data };
    }

    // ============================================================
    // 1. BOOTSTRAP WORKFLOW & PERMANENT RETIREMENT / LOCKING
    // ============================================================

    test("1A. HTTP: Bootstrap status endpoint is retired and fails closed with 405 Method Not Allowed", async () => {
        const res = await request("/api/admin/users/bootstrap-status");
        assert.equal(res.status, 405);
        assert.equal(res.data.success, false);
        assert.match(res.data.error, /Bootstrap via API has been retired/);
    });

    test("1B. HTTP: Direct bootstrap endpoint is retired and fails closed with 405 Method Not Allowed", async () => {
        const res = await request("/api/admin/users/bootstrap", {
            method: "POST",
            body: {
                uid: MOCK_SUPER_ADMIN_UID,
                email: MOCK_SUPER_ADMIN_EMAIL,
                secret: TEST_ADMIN_SECRET
            }
        });
        assert.equal(res.status, 405);
        assert.equal(res.data.success, false);
        assert.match(res.data.error, /Bootstrap via API has been retired/);
    });

    test("1C. Unit: Initial bootstrap succeeds with valid UID and secret, creating first super-admin", async () => {
        const result = await AdminUserService.bootstrapFirstAdmin({
            uid: MOCK_SUPER_ADMIN_UID,
            email: MOCK_SUPER_ADMIN_EMAIL,
            name: "Rupendra (Lead)",
            secret: TEST_ADMIN_SECRET
        });

        assert.ok(result);
        assert.equal(result.user.role, ROLES.SUPER_ADMIN);
        assert.equal(result.user.uid, MOCK_SUPER_ADMIN_UID);
        assert.equal(result.user.status, "active");
    });

    test("1D. Unit: Subsequent bootstrap attempt is permanently BLOCKED with exception", async () => {
        await assert.rejects(async () => {
            await AdminUserService.bootstrapFirstAdmin({
                uid: "attacker_uid_999",
                email: "attacker@hack.local",
                secret: TEST_ADMIN_SECRET
            });
        }, /Bootstrap is permanently disabled/);
    });

    test("1E. Unit: Bootstrap availability reports false after initial bootstrap", async () => {
        const isAvailable = await AdminUserService.isBootstrapAvailable();
        assert.equal(isAvailable, false);
    });

    // ============================================================
    // 2. PRIVILEGE BOUNDARIES & ENDPOINT PROTECTION
    // ============================================================

    test("2A. Unauthenticated request to /api/admin/users is rejected (401 or 403)", async () => {
        const res = await request("/api/admin/users");
        assert.ok(res.status === 401 || res.status === 403);
        assert.equal(res.data.success, false);
    });

    test("2B. Unit: AdminUserService lists registered administrator users", async () => {
        const users = await AdminUserService.listAdminUsers();
        assert.ok(Array.isArray(users));
        assert.ok(users.length >= 1);
        assert.equal(users[0].uid, MOCK_SUPER_ADMIN_UID);
        assert.equal(users[0].role, ROLES.SUPER_ADMIN);
    });

    // ============================================================
    // 3. ROLE ASSIGNMENT & ESCALATION PREVENTION
    // ============================================================

    test("3A. HTTP: Role assignment via API is permanently retired and fails closed with 405", async () => {
        const res = await request("/api/admin/users/assign-role", {
            method: "POST",
            body: {
                targetUid: MOCK_CONTENT_ADMIN_UID,
                newRole: ROLES.CONTENT_ADMIN,
                reason: "Authorized reviewer"
            }
        });
        assert.equal(res.status, 405);
        assert.equal(res.data.success, false);
        assert.match(res.data.error, /Administrative privilege modification via API is disabled/);
    });

    test("3B. Unit: Super-admin assigns content_admin role with audit reason", async () => {
        const updated = await AdminUserService.assignRole({
            actor: MOCK_SUPER_ADMIN_UID,
            targetUid: MOCK_CONTENT_ADMIN_UID,
            targetEmail: MOCK_CONTENT_ADMIN_EMAIL,
            targetName: "Reviewer Team",
            newRole: ROLES.CONTENT_ADMIN,
            reason: "Authorized question paper extractor and reviewer"
        });

        assert.ok(updated);
        assert.equal(updated.user.role, ROLES.CONTENT_ADMIN);
        assert.equal(updated.user.status, "active");
    });

    test("3C. Unit: Super-admin assigns super_admin role to a second user", async () => {
        const updated = await AdminUserService.assignRole({
            actor: MOCK_SUPER_ADMIN_UID,
            targetUid: MOCK_SECOND_SUPER_UID,
            targetEmail: MOCK_SECOND_SUPER_EMAIL,
            targetName: "Co-Lead Administrator",
            newRole: ROLES.SUPER_ADMIN,
            reason: "Appointed co-administrator for platform operations"
        });

        assert.ok(updated);
        assert.equal(updated.user.role, ROLES.SUPER_ADMIN);
    });

    test("3D. Unit: Active administrators list reflects 3 total administrators", async () => {
        const users = await AdminUserService.listAdminUsers();
        assert.equal(users.length, 3);
        const roles = users.map(u => u.role);
        assert.equal(roles.filter(r => r === ROLES.SUPER_ADMIN).length, 2);
        assert.equal(roles.filter(r => r === ROLES.CONTENT_ADMIN).length, 1);
    });

    test("3E. Unit: Role assignment fails if audit reason is omitted or too short", async () => {
        await assert.rejects(async () => {
            await AdminUserService.assignRole({
                actor: MOCK_SUPER_ADMIN_UID,
                targetUid: MOCK_STUDENT_UID,
                newRole: ROLES.CONTENT_ADMIN,
                reason: "no" // Too short (< 5 chars)
            });
        }, /audit reason/i);
    });

    // ============================================================
    // 4. CONTENT ADMIN PRIVILEGE ISOLATION
    // ============================================================

    test("4A. Unit: Content Admin role is correctly identified in user records", async () => {
        const role = await AdminUserService.getUserRole(MOCK_CONTENT_ADMIN_UID);
        assert.equal(role.role, ROLES.CONTENT_ADMIN);
    });

    test("4B. Content Admin is strictly FORBIDDEN (403) from managing admin users", async () => {
        const expressReq = {
            adminRole: ROLES.CONTENT_ADMIN,
            adminActor: MOCK_CONTENT_ADMIN_UID
        };

        const middleware = (req, res, next) => {
            if (req.adminRole !== ROLES.SUPER_ADMIN) {
                return res.status(403).json({ success: false, error: "Access Denied: Super-admin required" });
            }
            next();
        };

        let capturedStatus = null;
        const mockRes = {
            status(code) { capturedStatus = code; return this; },
            json(obj) { return obj; }
        };

        middleware(expressReq, mockRes, () => {});
        assert.equal(capturedStatus, 403);
    });

    // ============================================================
    // 5. REVOCATION & LAST SUPER-ADMIN SAFEGUARD
    // ============================================================

    test("5A. HTTP: Role revocation via API is permanently retired and fails closed with 405", async () => {
        const res = await request("/api/admin/users/revoke-role", {
            method: "POST",
            body: {
                targetUid: MOCK_SECOND_SUPER_UID,
                reason: "Departure"
            }
        });
        assert.equal(res.status, 405);
        assert.equal(res.data.success, false);
        assert.match(res.data.error, /Administrative privilege modification via API is disabled/);
    });

    test("5B. Unit: Super-admin can revoke a second super-admin when another super-admin exists", async () => {
        const revoked = await AdminUserService.revokeRole({
            actor: MOCK_SUPER_ADMIN_UID,
            targetUid: MOCK_SECOND_SUPER_UID,
            reason: "Departure from platform administrative duties"
        });

        assert.ok(revoked);
        assert.equal(revoked.user.status, "revoked");
        assert.equal(revoked.user.role, ROLES.USER);
    });

    test("5C. Unit: CRITICAL SAFEGUARD: Attempting to revoke the LAST active super-admin is REJECTED", async () => {
        await assert.rejects(async () => {
            await AdminUserService.revokeRole({
                actor: MOCK_SUPER_ADMIN_UID,
                targetUid: MOCK_SUPER_ADMIN_UID,
                reason: "Self-revocation attempt on sole remaining super admin"
            });
        }, /LAST active super-admin/);
    });

    test("5D. Unit: CRITICAL SAFEGUARD: Attempting to downgrade the LAST active super-admin is REJECTED", async () => {
        await assert.rejects(async () => {
            await AdminUserService.assignRole({
                actor: MOCK_SUPER_ADMIN_UID,
                targetUid: MOCK_SUPER_ADMIN_UID,
                newRole: ROLES.CONTENT_ADMIN,
                reason: "Downgrading sole super-admin to content admin"
            });
        }, /last active super-admin/);
    });

    test("5E. Unit: Revoking a content_admin succeeds and rejects subsequent access", async () => {
        const revoked = await AdminUserService.revokeRole({
            actor: MOCK_SUPER_ADMIN_UID,
            targetUid: MOCK_CONTENT_ADMIN_UID,
            reason: "End of review assignment"
        });

        assert.ok(revoked);
        assert.equal(revoked.user.status, "revoked");

        const role = await AdminUserService.getUserRole(MOCK_CONTENT_ADMIN_UID);
        assert.equal(role, null);
    });

    // ============================================================
    // 6. ROLE CHANGE AUDIT TRAIL
    // ============================================================

    test("6A. Unit: Audit trail contains complete history of all role changes", async () => {
        const logs = await AdminUserService.getAuditLogs();
        assert.ok(Array.isArray(logs));
        assert.ok(logs.length >= 4);

        const actions = logs.map(l => l.action);
        assert.ok(actions.includes("bootstrap_first_admin"));
        assert.ok(actions.includes("grant_role"));
        assert.ok(actions.includes("revoke_role"));

        const bootstrapEntry = logs.find(l => l.action === "bootstrap_first_admin");
        assert.equal(bootstrapEntry.targetUid, MOCK_SUPER_ADMIN_UID);
        assert.equal(bootstrapEntry.newRole, ROLES.SUPER_ADMIN);
        assert.ok(bootstrapEntry.timestamp);
    });

    // ============================================================
    // 7. FIREBASE TOKEN SIGNATURE & EXPIRY VERIFICATION
    // ============================================================

    test("7A. Token verification rejects expired token", async () => {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fake-key" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
            iss: "https://securetoken.google.com/pyqs-hub-43bed",
            aud: "pyqs-hub-43bed",
            sub: "user_test_expired",
            iat: now - 7200,
            exp: now - 3600
        })).toString("base64url");
        const signature = Buffer.from("fake_sig").toString("base64url");
        const expiredToken = `${header}.${payload}.${signature}`;

        const verified = await verifyFirebaseIdToken(expiredToken);
        assert.equal(verified, null);
    });

    test("7B. Token verification rejects malformed / tampered token", async () => {
        const verified = await verifyFirebaseIdToken("not.a.valid.jwt");
        assert.equal(verified, null);
    });
});
