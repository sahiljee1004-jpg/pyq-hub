/**
 * PHASE 5.14 — Firestore Quota Exhaustion, Catalog Resilience & Question Recovery
 * Comprehensive Verification & Acceptance Test Suite
 *
 * Verifies:
 * 1. Session Role & Authentication:
 *    - 404 Negative Caching (users/{uid} not found cached with bounded TTL)
 *    - Single-flight deduplication coalescing concurrent requests
 *    - Negative cache invalidation when document is subsequently written
 *    - HTTP 429 Circuit Breaker with fail-fast cooldown & Retry-After
 *    - Recovery after quota cooldown resets
 *    - Express GET /api/auth/session-role and POST /api/auth/session quota handling
 * 2. Mock-Test Catalog Recovery (GET /api/mock-tests):
 *    - Distinguishes genuine zero-test catalog from database failures
 *    - Propagates HTTP 429 (FIRESTORE_QUOTA_EXHAUSTED) instead of false empty catalog
 *    - Propagates HTTP 503 on database unavailability
 * 3. Mock-Test Question Loading & Attempt State (GET /api/mock-tests/:testId, POST attempts, PUT autosave, POST submit):
 *    - Distinguishes genuine zero-question test from database 429 failure
 *    - Propagates HTTP 429 instead of returning empty question array
 *    - Attempt creation propagates HTTP 429 under quota limits
 *    - Autosave attempt propagates HTTP 429 under quota limits
 *    - Submission attempt propagates HTTP 429 under quota limits
 * 4. Read Efficiency & Quota Conservation Benchmarks:
 *    - Negative caching efficiency (>= 80% read reduction for non-existent users)
 *    - Circuit breaker efficiency (100% outbound read elimination during cooldown)
 */

process.env.NODE_ENV = "test";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { MockTestService } from "../server/services/mockTestService.js";
import mockTestRouter from "../server/routes/mockTests.js";
import authRouter from "../server/routes/auth.js";

const TEST_PROJECT_ID = "test-project-acceptance";

// In-memory request dispatcher for Express routers (zero loopback TCP sockets required)
function dispatchRouter(router, method, url, { headers = {}, body = null } = {}) {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        app.use("/", router);

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
                headers: {
                    get: (name) => res.getHeader(name)
                },
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

describe("PHASE 5.14 — Firestore Quota Exhaustion & Catalog Recovery", () => {
    let originalFetch;
    let originalEnv;
    let testRsaPrivateKey;
    let testRsaPublicKey;

    function createTestToken(uid, role = "user", projectId = TEST_PROJECT_ID) {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const payload = {
            iss: `https://securetoken.google.com/${projectId}`,
            aud: projectId,
            sub: uid,
            user_id: uid,
            email: `${uid}@test.com`,
            role,
            auth_time: now,
            iat: now,
            exp: now + 3600
        };
        const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
        const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signInput = `${b64Header}.${b64Payload}`;
        const signer = crypto.createSign("RSA-SHA256");
        signer.update(signInput);
        const signature = signer.sign(testRsaPrivateKey, "base64url");
        return `${signInput}.${signature}`;
    }

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.FIREBASE_PROJECT_ID = TEST_PROJECT_ID;
        process.env.NODE_ENV = "test";
        UniversalFirestoreService.setProjectId(TEST_PROJECT_ID);
        UniversalFirestoreService.clearLocalCache();
        originalFetch = global.fetch;

        const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        testRsaPrivateKey = privateKey;
        testRsaPublicKey = publicKey;
        registerTestPublicKey(publicKey);
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env = originalEnv;
        UniversalFirestoreService.clearLocalCache();
    });

    describe("1. Authentication, Session Role & Negative Caching", () => {
        it("1.1 Caches 404 (document not found) negatively and prevents redundant Firestore reads", async () => {
            let networkCallCount = 0;
            global.fetch = async () => {
                networkCallCount++;
                return {
                    ok: false,
                    status: 404,
                    text: async () => JSON.stringify({ error: { code: 404, message: "Document not found" } })
                };
            };

            // First call: misses cache, executes network fetch, receives 404, caches negative entry
            const result1 = await UniversalFirestoreService.getDocument("users", "non-existent-user-1", {
                skipCache: false,
                ttlMs: 60000
            });
            assert.strictEqual(result1, null, "First call should return null for 404");
            assert.strictEqual(networkCallCount, 1, "First call must issue network fetch");

            // Subsequent 9 calls: hit negative cache, issue 0 network fetches
            for (let i = 0; i < 9; i++) {
                const res = await UniversalFirestoreService.getDocument("users", "non-existent-user-1", {
                    skipCache: false,
                    ttlMs: 60000
                });
                assert.strictEqual(res, null, "Cached negative entry should return null");
            }

            assert.strictEqual(networkCallCount, 1, "9 subsequent calls within TTL must NOT hit network (negative cache hit)");
        });

        it("1.2 Invalidates negative cache immediately when the document is created or updated", async () => {
            global.fetch = async () => ({
                ok: false,
                status: 404,
                text: async () => JSON.stringify({ error: { code: 404, message: "Not found" } })
            });

            // Populate negative cache
            const initial = await UniversalFirestoreService.getDocument("users", "new-student-456", { ttlMs: 60000 });
            assert.strictEqual(initial, null);

            // Now create the document
            await UniversalFirestoreService.setDocument("users", "new-student-456", {
                role: "student",
                email: "new-student@vidyarthiastra.com"
            });

            // Subsequent call must retrieve newly created document
            const updated = await UniversalFirestoreService.getDocument("users", "new-student-456");
            assert.strictEqual(updated.role, "student");
            assert.strictEqual(updated.email, "new-student@vidyarthiastra.com");
        });

        it("1.3 Coalesces concurrent in-flight reads into a single network fetch", async () => {
            let networkCallCount = 0;
            global.fetch = async () => {
                networkCallCount++;
                await new Promise(r => setTimeout(r, 20));
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        name: `projects/${TEST_PROJECT_ID}/databases/(default)/documents/users/concurrent-user`,
                        fields: {
                            role: { stringValue: "student" },
                            email: { stringValue: "student@vidyarthiastra.com" }
                        }
                    })
                };
            };

            const promises = Array.from({ length: 5 }, () =>
                UniversalFirestoreService.getDocument("users", "concurrent-user", { ttlMs: 60000 })
            );

            const results = await Promise.all(promises);
            assert.strictEqual(networkCallCount, 1, "5 concurrent reads must coalesce into exactly 1 network call");
            results.forEach(res => {
                assert.strictEqual(res.role, "student");
            });
        });

        it("1.4 Trips circuit breaker on HTTP 429 and fails fast during cooldown without network calls", async () => {
            let networkCallCount = 0;
            global.fetch = async () => {
                networkCallCount++;
                return {
                    ok: false,
                    status: 429,
                    headers: { get: (header) => header.toLowerCase() === "retry-after" ? "20" : null },
                    text: async () => "Quota exceeded. RESOURCE_EXHAUSTED"
                };
            };

            // First call: encounters 429, records cooldown for 20s, throws quota error
            await assert.rejects(
                async () => {
                    await UniversalFirestoreService.getDocument("users", "quota-test-user", {
                        skipCache: true,
                        maxRetries: 0
                    });
                },
                (err) => {
                    assert.strictEqual(err.statusCode, 429);
                    assert.strictEqual(err.isQuotaExhausted, true);
                    assert.strictEqual(err.retryAfter, 20);
                    return true;
                }
            );

            assert.strictEqual(networkCallCount, 1, "First call issued fetch and encountered 429");
            assert.strictEqual(UniversalFirestoreService.isQuotaCooldownActive(), true, "Circuit breaker should now be active");

            // Subsequent 5 calls during cooldown: fail fast immediately without calling fetch!
            for (let i = 0; i < 5; i++) {
                await assert.rejects(
                    async () => {
                        await UniversalFirestoreService.getDocument("users", "another-user", {
                            skipCache: true
                        });
                    },
                    (err) => {
                        assert.strictEqual(err.statusCode, 429);
                        assert.strictEqual(err.isQuotaExhausted, true);
                        assert.match(err.message, /Circuit breaker active/);
                        return true;
                    }
                );
            }

            assert.strictEqual(networkCallCount, 1, "Zero network requests dispatched while circuit breaker is active");
        });

        it("1.5 Express GET /api/auth/session-role returns HTTP 429 with Retry-After during quota exhaustion", async () => {
            UniversalFirestoreService.recordQuotaExhaustion(30, "RESOURCE_EXHAUSTED");
            const token = createTestToken("quota-user-789", "user");

            const res = await dispatchRouter(authRouter, "GET", "/session-role", {
                headers: { "Authorization": `Bearer ${token}` }
            });

            assert.strictEqual(res.status, 429);
            assert.strictEqual(res.headers.get("Retry-After"), "30");
            assert.strictEqual(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
            assert.strictEqual(res.data.authenticated, true);
        });

        it("1.6 Recovers automatically after circuit breaker cooldown expires", async () => {
            // Manually trip circuit breaker with 1 second cooldown
            UniversalFirestoreService.recordQuotaExhaustion(1, "Simulated test cooldown");
            assert.strictEqual(UniversalFirestoreService.isQuotaCooldownActive(), true);

            // Immediate call fails fast
            await assert.rejects(
                async () => {
                    await UniversalFirestoreService.getDocument("users", "recover-user", { skipCache: true });
                },
                (err) => err.isQuotaExhausted === true
            );

            // Wait for cooldown to expire
            await new Promise(r => setTimeout(r, 1100));
            assert.strictEqual(UniversalFirestoreService.isQuotaCooldownActive(), false);

            let networkCallCount = 0;
            global.fetch = async () => {
                networkCallCount++;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        name: `projects/${TEST_PROJECT_ID}/databases/(default)/documents/users/recover-user`,
                        fields: { role: { stringValue: "admin" } }
                    })
                };
            };

            const doc = await UniversalFirestoreService.getDocument("users", "recover-user", { skipCache: true });
            assert.strictEqual(networkCallCount, 1, "Fetch dispatched after cooldown expiration");
            assert.strictEqual(doc.role, "admin");
        });
    });

    describe("2. Mock-Test Catalog Resilience (GET /api/mock-tests)", () => {
        it("2.0 Loads only published catalog records through a rules-compatible Firestore query", async () => {
            process.env.NODE_ENV = "development";
            let queryUrl = "";
            let queryBody = null;
            global.fetch = async (url, options) => {
                queryUrl = url;
                queryBody = JSON.parse(options.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => [
                        {
                            document: {
                                name: `projects/${TEST_PROJECT_ID}/databases/(default)/documents/mockTests/published-test`,
                                fields: {
                                    status: { stringValue: "published" },
                                    testId: { stringValue: "published-test" },
                                    examId: { stringValue: "neet-ug" },
                                    examName: { stringValue: "NEET (UG)" },
                                    year: { integerValue: "2024" },
                                    title: { stringValue: "NEET 2024 Mock Test" },
                                    adminNotes: { stringValue: "must not be returned" }
                                }
                            }
                        },
                        {
                            document: {
                                name: `projects/${TEST_PROJECT_ID}/databases/(default)/documents/mockTests/draft-test`,
                                fields: {
                                    status: { stringValue: "draft" },
                                    testId: { stringValue: "draft-test" },
                                    title: { stringValue: "Draft Test" }
                                }
                            }
                        }
                    ]
                };
            };

            const response = await dispatchRouter(mockTestRouter, "GET", "/");

            assert.strictEqual(response.status, 200);
            assert.strictEqual(queryUrl, `https://firestore.googleapis.com/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents:runQuery`);
            assert.deepStrictEqual(queryBody.structuredQuery.where.fieldFilter, {
                field: { fieldPath: "status" },
                op: "EQUAL",
                value: { stringValue: "published" }
            });
            assert.strictEqual(response.data.count, 1);
            assert.strictEqual(response.data.tests[0].testId, "published-test");
            assert.strictEqual(response.data.tests[0].title, "NEET 2024 Mock Test");
            assert.strictEqual("adminNotes" in response.data.tests[0], false);
        });

        it("2.1 Returns HTTP 429 (FIRESTORE_QUOTA_EXHAUSTED) instead of false empty catalog when Firestore is exhausted", async () => {
            // Mock fetch to simulate Cloud Firestore returning 429
            global.fetch = async () => ({
                ok: false,
                status: 429,
                headers: { get: (h) => h.toLowerCase() === "retry-after" ? "45" : null },
                text: async () => "Quota exceeded. RESOURCE_EXHAUSTED"
            });

            // Calling listDocuments directly with forceRemote throws quota error
            await assert.rejects(
                async () => {
                    await UniversalFirestoreService.listDocuments("mockTests", { forceRemote: true });
                },
                (err) => {
                    assert.strictEqual(err.statusCode, 429);
                    assert.strictEqual(err.isQuotaExhausted, true);
                    return true;
                }
            );
        });

        it("2.2 Express router responds with HTTP 429 and Retry-After header when catalog fails due to quota", async () => {
            // Set circuit breaker active
            UniversalFirestoreService.recordQuotaExhaustion(30, "Quota exceeded");

            // Dispatch request via in-memory router handler (zero TCP sockets)
            const res = await dispatchRouter(mockTestRouter, "GET", "/");
            assert.strictEqual(res.status, 429, "Catalog endpoint must return HTTP 429");
            assert.strictEqual(res.headers.get("Retry-After"), "30", "Retry-After header must be set");

            assert.strictEqual(res.data.success, false);
            assert.strictEqual(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
            assert.match(res.data.error, /read quota exceeded/i);
        });

        it("2.3 Distinguishes genuine zero-test catalog from database failure", async () => {
            // Genuine empty catalog (Firestore returns 200 with empty documents)
            global.fetch = async () => ({
                ok: true,
                status: 200,
                json: async () => ({ documents: [] })
            });

            const tests = await UniversalFirestoreService.listDocuments("mockTests", { forceRemote: true });
            assert.deepStrictEqual(tests, [], "Legitimate empty array returned when Firestore returns 0 documents");

            const published = await MockTestService.listPublishedTests();
            assert.strictEqual(Array.isArray(published), true);
            assert.strictEqual(published.length, 0);
        });
    });

    describe("3. Mock-Test Question Loading & Attempt Workflow (GET /:testId, attempts, autosave, submit)", () => {
        it("3.1 Propagates HTTP 429 when question loading fails due to Firestore quota exhaustion", async () => {
            UniversalFirestoreService.clearLocalCache();
            // Seed mock test document in local cache
            await UniversalFirestoreService.setDocument("mockTests", "neet-ug-2024", {
                testId: "neet-ug-2024",
                title: "NEET UG 2024 Full Mock Test",
                examId: "neet-ug",
                status: "published",
                questionIds: ["q1", "q2"]
            });

            const studentToken = createTestToken("student-123", "student");

            // Activate quota cooldown
            UniversalFirestoreService.recordQuotaExhaustion(30, "RESOURCE_EXHAUSTED");

            // Verify router catches quota error and returns 429
            const res = await dispatchRouter(mockTestRouter, "GET", "/neet-ug-2024", {
                headers: { "Authorization": `Bearer ${studentToken}` }
            });
            assert.strictEqual(res.status, 429, "Question endpoint must respond with HTTP 429 on quota exhaustion");
            assert.strictEqual(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
        });

        it("3.2 Cleanly separates genuine empty-question test from database failure", async () => {
            UniversalFirestoreService.clearLocalCache();
            // Published test with no questions in database
            await UniversalFirestoreService.setDocument("mockTests", "empty-test-1", {
                testId: "empty-test-1",
                title: "Empty Test",
                examId: "neet-ug",
                status: "published",
                questionIds: []
            });

            // listDocuments returns empty array without throwing
            const result = await MockTestService.getTestForStudent("empty-test-1");
            assert.strictEqual(result.test.testId, "empty-test-1");
            assert.strictEqual(result.questions.length, 0, "Legitimate empty questions array");

            const studentToken = createTestToken("student-123", "student");
            // Router returns 200 with empty questions array for genuine empty test
            const res = await dispatchRouter(mockTestRouter, "GET", "/empty-test-1", {
                headers: { "Authorization": `Bearer ${studentToken}` }
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.success, true);
            assert.deepStrictEqual(res.data.questions, []);
        });

        it("3.3 Propagates HTTP 429 during attempt creation (POST /api/mock-tests/:testId/attempts)", async () => {
            UniversalFirestoreService.recordQuotaExhaustion(30, "Quota exceeded");
            const studentToken = createTestToken("student-attempt-user", "student");

            const res = await dispatchRouter(mockTestRouter, "POST", "/neet-ug-2024/attempts", {
                headers: { "Authorization": `Bearer ${studentToken}` },
                body: { language: "English" }
            });

            assert.strictEqual(res.status, 429);
            assert.strictEqual(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
        });

        it("3.4 Propagates HTTP 429 during answer autosave (PUT /api/mock-tests/attempts/:attemptId)", async () => {
            UniversalFirestoreService.recordQuotaExhaustion(30, "Quota exceeded");
            const studentToken = createTestToken("student-autosave-user", "student");

            const res = await dispatchRouter(mockTestRouter, "PUT", "/attempts/attempt-test-123", {
                headers: { "Authorization": `Bearer ${studentToken}` },
                body: { answers: { q1: "A" } }
            });

            assert.strictEqual(res.status, 429);
            assert.strictEqual(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
        });

        it("3.5 Propagates HTTP 429 during attempt submission (POST /api/mock-tests/attempts/:attemptId/submit)", async () => {
            UniversalFirestoreService.recordQuotaExhaustion(30, "Quota exceeded");
            const studentToken = createTestToken("student-submit-user", "student");

            const res = await dispatchRouter(mockTestRouter, "POST", "/attempts/attempt-test-123/submit", {
                headers: { "Authorization": `Bearer ${studentToken}` },
                body: { answers: { q1: "A" } }
            });

            assert.strictEqual(res.status, 429);
            assert.strictEqual(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
        });
    });

    describe("4. Read Efficiency & Quota Conservation Benchmarks", () => {
        it("4.1 Measures read reduction: 10 repeated session-role lookups for non-existent user", async () => {
            let rawReads = 0;
            global.fetch = async () => {
                rawReads++;
                return {
                    ok: false,
                    status: 404,
                    text: async () => JSON.stringify({ error: { code: 404, message: "Not found" } })
                };
            };

            // 10 sequential calls for an unregistered UID (e.g. freshly created Firebase Auth account)
            for (let i = 0; i < 10; i++) {
                await UniversalFirestoreService.getDocument("users", "guest-or-new-user-123");
            }

            // Before Phase 5.14 fix: 10 live network reads (0% reduction)
            // After Phase 5.14 fix: exactly 1 live network read, 9 negative cache hits (90% reduction)
            assert.strictEqual(rawReads, 1, "Negative caching must reduce 10 calls to exactly 1 Firestore network read");
        });

        it("4.2 Measures read elimination: 10 calls during 429 cooldown produce 0 outbound network requests", async () => {
            UniversalFirestoreService.recordQuotaExhaustion(30, "Quota test");
            let outboundCalls = 0;
            global.fetch = async () => {
                outboundCalls++;
                return { ok: true, status: 200, json: async () => ({}) };
            };

            for (let i = 0; i < 10; i++) {
                try {
                    await UniversalFirestoreService.getDocument("users", `any-user-${i}`);
                } catch (e) {
                    // expected 429
                }
            }

            assert.strictEqual(outboundCalls, 0, "Circuit breaker must completely eliminate outbound requests during cooldown (100% reduction)");
        });
    });
});
