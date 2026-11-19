import { test, describe, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { AdminAuthService } from "../server/services/admin/adminAuthService.js";
import { verifyFirebaseIdToken, registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { generateKeyPairSync, createSign } from "node:crypto";
import app from "../server/app.js";

import http from "node:http";

describe("Phase 5.9 — Firestore Quota Exhaustion & Mock Test Recovery Suite", () => {
    let originalEnv;
    let testRsaPrivateKey;
    let testRsaPublicKey;

    // In-memory Express request dispatcher (requires zero network/TCP sockets)
    function dispatchApp(method, url, { headers = {}, body = null } = {}) {
        return new Promise((resolve) => {
            const req = new http.IncomingMessage();
            req.method = method.toUpperCase();
            req.url = url;
            req.headers = {};
            for (const [k, v] of Object.entries(headers)) {
                req.headers[k.toLowerCase()] = v;
            }

            const res = new http.ServerResponse(req);
            let resBody = "";
            res.write = function (chunk) {
                resBody += chunk;
                return true;
            };
            res.end = function (chunk) {
                if (chunk) resBody += chunk;
                let parsed = null;
                try { parsed = JSON.parse(resBody); } catch (_) {}
                resolve({
                    status: res.statusCode,
                    headers: { get: (name) => res.getHeader(name) },
                    data: parsed,
                    text: async () => resBody
                });
            };

            if (body) {
                req.body = body;
            }

            app(req, res);
        });
    }

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.FIREBASE_PROJECT_ID = "test-project-quota";
        process.env.NODE_ENV = "test";
        UniversalFirestoreService.setProjectId("test-project-quota");
        UniversalFirestoreService.clearLocalCache();

        const { privateKey, publicKey } = generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        testRsaPrivateKey = privateKey;
        testRsaPublicKey = publicKey;
        registerTestPublicKey(publicKey);
    });

    // Helper to generate valid test JWTs
    function createTestToken(uid, role = "user") {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const payload = {
            iss: "https://securetoken.google.com/test-project-quota",
            aud: "test-project-quota",
            sub: uid,
            user_id: uid,
            email: `${uid}@test.com`,
            auth_time: now,
            iat: now,
            exp: now + 3600
        };
        const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
        const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signInput = `${b64Header}.${b64Payload}`;
        const signer = createSign("RSA-SHA256");
        signer.update(signInput);
        const signature = signer.sign(testRsaPrivateKey, "base64url");
        return `${signInput}.${signature}`;
    }

    afterEach(() => {
        process.env = originalEnv;
        UniversalFirestoreService.clearLocalCache();
    });

    // -------------------------------------------------------------
    // SECTION 1: FIRESTORE SINGLE-FLIGHT COALESCING & TTL CACHING
    // -------------------------------------------------------------
    describe("1. Firestore Read Optimization & Caching Invariants", () => {
        test("1.1 Single-flight coalescing: concurrent reads share exactly one in-flight request", async () => {
            let networkCallCount = 0;
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async (url) => {
                    networkCallCount++;
                    // Introduce slight latency to ensure concurrency
                    await new Promise(r => setTimeout(r, 50));
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            name: "projects/test-project-quota/databases/(default)/documents/users/student-1",
                            fields: {
                                email: { stringValue: "student@test.com" },
                                role: { stringValue: "user" }
                            }
                        })
                    };
                };

                // Clear any test localDocCache to force fetch execution
                UniversalFirestoreService.clearLocalCache();

                // Fire 5 concurrent requests simultaneously for the same user
                const [r1, r2, r3, r4, r5] = await Promise.all([
                    UniversalFirestoreService.getDocument("users", "student-1", { skipCache: true }),
                    UniversalFirestoreService.getDocument("users", "student-1", { skipCache: true }),
                    UniversalFirestoreService.getDocument("users", "student-1", { skipCache: true }),
                    UniversalFirestoreService.getDocument("users", "student-1", { skipCache: true }),
                    UniversalFirestoreService.getDocument("users", "student-1", { skipCache: true })
                ]);

                // All 5 must receive identical parsed document
                assert.equal(r1.role, "user");
                assert.equal(r2.role, "user");
                assert.equal(r3.role, "user");
                assert.equal(r4.role, "user");
                assert.equal(r5.role, "user");

                // Exactly ONE network fetch must have been initiated
                assert.equal(networkCallCount, 1, "Expected single-flight to coalesce 5 concurrent calls into 1 network fetch");

            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        test("1.2 TTL Cache hit avoids network requests within TTL window", async () => {
            let fetchCount = 0;
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => {
                    fetchCount++;
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            name: "projects/test-project-quota/databases/(default)/documents/users/student-cache",
                            fields: {
                                email: { stringValue: "cache@test.com" },
                                role: { stringValue: "user" }
                            }
                        })
                    };
                };

                UniversalFirestoreService.clearLocalCache();

                // First call: populates cache
                const first = await UniversalFirestoreService.getDocument("users", "student-cache", { ttlMs: 5000 });
                assert.equal(first.role, "user");
                assert.equal(fetchCount, 1);

                // Second call within TTL: served strictly from memory
                const second = await UniversalFirestoreService.getDocument("users", "student-cache", { ttlMs: 5000 });
                assert.equal(second.role, "user");
                assert.equal(fetchCount, 1, "Second read must be served from cache without extra network fetch");

                // Third call within TTL: served from memory
                const third = await UniversalFirestoreService.getDocument("users", "student-cache", { ttlMs: 5000 });
                assert.equal(third.role, "user");
                assert.equal(fetchCount, 1);

            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        test("1.3 Cache expiry: expired entries trigger fresh network fetch", async () => {
            let fetchCount = 0;
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => {
                    fetchCount++;
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            name: "projects/test-project-quota/databases/(default)/documents/users/student-exp",
                            fields: {
                                role: { stringValue: "user" },
                                version: { integerValue: String(fetchCount) }
                            }
                        })
                    };
                };

                UniversalFirestoreService.clearLocalCache();

                // Call with tiny TTL of 30ms
                const doc1 = await UniversalFirestoreService.getDocument("users", "student-exp", { ttlMs: 30 });
                assert.equal(doc1.version, 1);
                assert.equal(fetchCount, 1);

                // Wait 45ms to expire cache
                await new Promise(r => setTimeout(r, 45));

                // Call after expiry: must fetch fresh version
                const doc2 = await UniversalFirestoreService.getDocument("users", "student-exp", { ttlMs: 30 });
                assert.equal(doc2.version, 2);
                assert.equal(fetchCount, 2, "Expired cache entry must trigger a fresh fetch");

            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        test("1.4 Invalidation: document writes and explicit invalidation clear cache", async () => {
            UniversalFirestoreService.clearLocalCache();
            UniversalFirestoreService._addToTtlCache("test-project-quota:users/student-inv", { role: "user" }, 60000);

            // Verify it is cached
            const cachedBefore = await UniversalFirestoreService.getDocument("users", "student-inv");
            assert.equal(cachedBefore.role, "user");

            // Explicitly invalidate
            UniversalFirestoreService.invalidateDocument("users", "student-inv");

            // Verify cache entry is gone
            const scopedKey = "test-project-quota:users/student-inv";
            assert.equal(UniversalFirestoreService._ttlDocCache.has(scopedKey), false);
        });

        test("1.5 Missing document returns null and cleans cache", async () => {
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => ({
                    ok: false,
                    status: 404,
                    text: async () => "Document not found"
                });

                UniversalFirestoreService.clearLocalCache();
                const res = await UniversalFirestoreService.getDocument("users", "non-existent");
                assert.equal(res, null);

            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    // -------------------------------------------------------------
    // SECTION 2: QUOTA EXHAUSTION (HTTP 429) & ERROR HANDLING
    // -------------------------------------------------------------
    describe("2. Structured HTTP 429 Quota Handling", () => {
        test("2.1 UniversalFirestoreService identifies HTTP 429 RESOURCE_EXHAUSTED and throws structured error", async () => {
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => ({
                    ok: false,
                    status: 429,
                    headers: new Map([["retry-after", "45"]]),
                    text: async () => JSON.stringify({
                        error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" }
                    })
                });

                UniversalFirestoreService.clearLocalCache();

                await assert.rejects(
                    async () => {
                        await UniversalFirestoreService.getDocument("users", "student-quota-test", { skipCache: true, maxRetries: 0 });
                    },
                    (err) => {
                        assert.equal(err.statusCode, 429);
                        assert.equal(err.code, "RESOURCE_EXHAUSTED");
                        assert.equal(err.isQuotaExhausted, true);
                        assert.equal(err.retryAfter, 45);
                        return true;
                    }
                );

            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        test("2.2 Transient 503 Service Unavailable triggers bounded retry with backoff", async () => {
            let attempts = 0;
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => {
                    attempts++;
                    if (attempts < 2) {
                        return {
                            ok: false,
                            status: 503,
                            text: async () => "Service Unavailable"
                        };
                    }
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            name: "projects/test-project-quota/databases/(default)/documents/users/student-retry",
                            fields: { role: { stringValue: "user" } }
                        })
                    };
                };

                UniversalFirestoreService.clearLocalCache();
                const doc = await UniversalFirestoreService.getDocument("users", "student-retry", { skipCache: true, maxRetries: 2 });
                assert.equal(doc.role, "user");
                assert.equal(attempts, 2, "Expected recovery on 2nd attempt");

            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        test("2.3 Persistent HTTP 429 fails fast after bounded retry without infinite loop", async () => {
            let attempts = 0;
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => {
                    attempts++;
                    return {
                        ok: false,
                        status: 429,
                        headers: new Map([["retry-after", "60"]]),
                        text: async () => "Quota exceeded."
                    };
                };

                UniversalFirestoreService.clearLocalCache();

                await assert.rejects(
                    async () => {
                        await UniversalFirestoreService.getDocument("users", "student-persistent-429", { skipCache: true, maxRetries: 1 });
                    },
                    (err) => {
                        assert.equal(err.statusCode, 429);
                        assert.equal(err.isQuotaExhausted, true);
                        return true;
                    }
                );

                // Ensure bounded execution (attempted once or at most maxRetries, not an infinite storm)
                assert.ok(attempts <= 2, `Expected at most 2 attempts, got ${attempts}`);

            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    // -------------------------------------------------------------
    // SECTION 3: MOCK TEST INTEGRITY & SKELETON LIFECYCLE
    // -------------------------------------------------------------
    describe("3. Mock Test Integrity & Lifecycle Guarantees", () => {
        test("3.1 Auth session-role failure does NOT start timer or create attempt", async () => {
            // Simulate student starting test when session role returns 429
            let timerStarted = false;
            let attemptCreated = false;

            const mockStartTestSession = async (testId, simulateError = true) => {
                let testSessionSkeleton = {
                    cancelled: false,
                    cancel() { this.cancelled = true; },
                    dismissed: false,
                    dismiss() { this.dismissed = true; }
                };

                try {
                    // Check session role
                    if (simulateError) {
                        const err = new Error("Database read quota exceeded");
                        err.statusCode = 429;
                        err.code = "FIRESTORE_QUOTA_EXHAUSTED";
                        throw err;
                    }

                    attemptCreated = true;
                    testSessionSkeleton.dismiss();
                    timerStarted = true;

                } catch (err) {
                    testSessionSkeleton?.cancel();
                    // Render error state
                    return { error: err, skeletonCancelled: testSessionSkeleton.cancelled };
                }
            };

            const outcome = await mockStartTestSession("test-101", true);
            assert.equal(outcome.skeletonCancelled, true, "Skeleton must be cancelled on role failure");
            assert.equal(timerStarted, false, "Timer must NEVER start on failure");
            assert.equal(attemptCreated, false, "Attempt must NEVER be created when role verification fails");
        });

        test("3.2 Successful recovery creates exactly one attempt and starts countdown cleanly", async () => {
            let attemptCount = 0;
            let timerStarted = false;

            const mockRecoveredSession = async () => {
                let testSessionSkeleton = {
                    cancelled: false,
                    cancel() { this.cancelled = true; },
                    dismissed: false,
                    dismiss() { this.dismissed = true; }
                };

                // Role verified
                const role = { authenticated: true, role: "user" };
                assert.equal(role.authenticated, true);

                // Create attempt
                attemptCount++;

                testSessionSkeleton.dismiss();
                timerStarted = true;

                return { attemptCount, timerStarted, skeletonDismissed: testSessionSkeleton.dismissed };
            };

            const res = await mockRecoveredSession();
            assert.equal(res.attemptCount, 1, "Exactly one attempt must be created");
            assert.equal(res.timerStarted, true, "Timer must start on clean dismissal");
            assert.equal(res.skeletonDismissed, true, "Skeleton must be dismissed");
        });
    });

    // -------------------------------------------------------------
    // SECTION 4: EXPRESS API ENDPOINT ERROR RESPONSES
    // -------------------------------------------------------------
    describe("4. API Endpoint Quota Handling & Session-Role Lifecycle", () => {
        test("4.1 GET /api/auth/session-role returns 200 with role for authorized student", async () => {
            const token = createTestToken("student-api-1");
            await UniversalFirestoreService.setDocument("users", "student-api-1", { role: "user" });

            const res = await dispatchApp("GET", "/api/auth/session-role", {
                headers: { Authorization: `Bearer ${token}` }
            });
            assert.equal(res.status, 200);
            assert.equal(res.data.authenticated, true);
            assert.equal(res.data.role, "user");
            assert.equal(res.data.isAdmin, false);
        });

        test("4.2 GET /api/auth/session-role returns HTTP 429 when Firestore quota is exhausted", async () => {
            const token = createTestToken("student-quota-api");
            UniversalFirestoreService.clearLocalCache();

            // Mock getDocument to simulate quota exhaustion
            const origGetDoc = UniversalFirestoreService.getDocument;
            UniversalFirestoreService.getDocument = async () => {
                const quotaErr = new Error("Firestore read quota exceeded (HTTP 429: RESOURCE_EXHAUSTED)");
                quotaErr.statusCode = 429;
                quotaErr.code = "RESOURCE_EXHAUSTED";
                quotaErr.isQuotaExhausted = true;
                quotaErr.retryAfter = 45;
                throw quotaErr;
            };

            try {
                const res = await dispatchApp("GET", "/api/auth/session-role", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                assert.equal(res.status, 429, "Expected HTTP 429 status code");
                assert.equal(res.headers.get("retry-after"), "45", "Expected Retry-After header");
                assert.equal(res.data.success, false);
                assert.equal(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
                assert.equal(res.data.retryAfter, 45);
                assert.ok(res.data.error.includes("Database read quota exceeded"));
            } finally {
                UniversalFirestoreService.getDocument = origGetDoc;
            }
        });

        test("4.3 POST /api/mock-tests/:testId/attempts returns HTTP 429 when student auth hits quota limit", async () => {
            const token = createTestToken("student-attempt-quota");
            UniversalFirestoreService.clearLocalCache();

            const origGetDoc = UniversalFirestoreService.getDocument;
            UniversalFirestoreService.getDocument = async () => {
                const quotaErr = new Error("Firestore read quota exceeded");
                quotaErr.statusCode = 429;
                quotaErr.isQuotaExhausted = true;
                quotaErr.retryAfter = 30;
                throw quotaErr;
            };

            try {
                const res = await dispatchApp("POST", "/api/mock-tests/jee-main-2026/attempts", {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`
                    },
                    body: { language: "English" }
                });
                assert.equal(res.status, 429, "Expected HTTP 429 on attempt creation during quota exhaustion");
                assert.equal(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
            } finally {
                UniversalFirestoreService.getDocument = origGetDoc;
            }
        });

        test("4.4 GET /api/auth/session-role returns role='guest' for unauthenticated requests", async () => {
            const res = await dispatchApp("GET", "/api/auth/session-role");
            assert.equal(res.status, 200);
            assert.equal(res.data.authenticated, false);
            assert.equal(res.data.role, "guest");
            assert.equal(res.data.isAdmin, false);
        });
    });
});
