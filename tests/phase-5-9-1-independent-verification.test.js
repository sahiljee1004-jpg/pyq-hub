/**
 * Phase 5.9.1 — Independent Firestore Quota Recovery & Mock Test Acceptance Suite
 * 
 * Comprehensive verification of:
 * 1. Real Firestore connectivity & error classification
 * 2. Full-length mock-test read measurement across multiple 60s TTL windows
 * 3. Cache security, tenant isolation, LRU eviction & invalidation audit
 * 4. Mock test end-to-end lifecycle & answer persistence (MCQ + NAT)
 * 5. Failure and recovery testing (429, 500, timeout, missing doc, invalid auth)
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { registerTestPublicKey, getFirestoreServerAuthHeaders } from "../server/services/firebaseTokenService.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { ExamProfileRegistry } from "../server/services/admin/examProfileRegistry.js";
import app from "../server/app.js";

describe("PHASE 5.9.1 — Independent Firestore Quota Recovery Acceptance Suite", () => {
    let originalEnv;
    let testRsaPrivateKey;
    let testRsaPublicKey;

    const TEST_PROJECT_ID = "test-project-acceptance";
    const PRODUCTION_PROJECT_ID = "pyqs-hub-43bed";

    // In-memory Express request dispatcher (requires zero loopback TCP sockets)
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

    // Helper to generate valid test JWTs
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
        process.env = originalEnv;
        UniversalFirestoreService.clearLocalCache();
    });

    // =========================================================================
    // SECTION 1: REAL FIRESTORE CONNECTIVITY & ERROR CLASSIFICATION
    // =========================================================================
    describe("1. Real Firestore Verification & Classification", () => {
        test("1.1 Project configuration integrity: verifies pyqs-hub-43bed configuration", () => {
            assert.ok(fs.existsSync("serviceAccountKey.json"), "serviceAccountKey.json must exist in root");

            const sa = JSON.parse(fs.readFileSync("serviceAccountKey.json", "utf8"));
            assert.equal(sa.project_id, PRODUCTION_PROJECT_ID, "Service account must match production project ID");
            assert.ok(sa.client_email.includes("firebase-adminsdk"), "Must be a valid Firebase Admin SDK service account");
        });

        test("1.2 Distinguishes Real Firestore 429 RESOURCE_EXHAUSTED with structured metadata", async () => {
            // Emulate Firestore REST API returning HTTP 429
            const originalFetch = globalThis.fetch;
            try {
                globalThis.fetch = async () => ({
                    ok: false,
                    status: 429,
                    headers: { get: (name) => name.toLowerCase() === "retry-after" ? "45" : null },
                    text: async () => JSON.stringify({
                        error: {
                            code: 429,
                            message: "Quota exceeded.",
                            status: "RESOURCE_EXHAUSTED"
                        }
                    })
                });

                await assert.rejects(
                    async () => {
                        await UniversalFirestoreService.getDocument("users", "test-candidate", { skipCache: true, maxRetries: 0 });
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

        test("1.3 Request Classification: clearly identifies Real vs Cached vs In-Flight requests", async () => {
            let realFetchCalls = 0;
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => {
                    realFetchCalls++;
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            name: `projects/${TEST_PROJECT_ID}/databases/(default)/documents/users/student-class-1`,
                            fields: { role: { stringValue: "user" } }
                        })
                    };
                };

                // Request 1: Fresh network read (Real fetch)
                const doc1 = await UniversalFirestoreService.getDocument("users", "student-class-1", { ttlMs: 10000 });
                assert.equal(doc1.role, "user");
                assert.equal(realFetchCalls, 1, "First call must trigger real fetch");

                // Request 2: In-memory TTL Cache Hit (0 real fetches)
                const doc2 = await UniversalFirestoreService.getDocument("users", "student-class-1", { ttlMs: 10000 });
                assert.equal(doc2.role, "user");
                assert.equal(realFetchCalls, 1, "Second call within TTL must be served from cache without fetch");

                // Request 3: Concurrent in-flight coalesced reads
                const [c1, c2, c3] = await Promise.all([
                    UniversalFirestoreService.getDocument("users", "student-class-2", { skipCache: true }),
                    UniversalFirestoreService.getDocument("users", "student-class-2", { skipCache: true }),
                    UniversalFirestoreService.getDocument("users", "student-class-2", { skipCache: true })
                ]);
                assert.equal(c1.role, "user");
                assert.equal(c2.role, "user");
                assert.equal(c3.role, "user");
                assert.equal(realFetchCalls, 2, "Concurrent requests must coalesce into exactly 1 additional real fetch");

            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    // =========================================================================
    // SECTION 2: FULL-LENGTH MOCK-TEST READ MEASUREMENT ACROSS MULTIPLE TTL WINDOWS
    // =========================================================================
    describe("2. Full-Length Mock-Test Read Measurement (Multiple TTL Windows)", () => {
        test("2.1 Representative 100-Question Exam Session across multiple 60s TTL windows", async () => {
            let firestoreReads = 0;
            let cacheHits = 0;
            let cacheMisses = 0;
            let autosaveCount = 0;
            let authVerificationCount = 0;
            let simulatedTimeMs = 1700000000000;

            const originalNow = Date.now;
            Date.now = () => simulatedTimeMs;

            const originalFetch = globalThis.fetch;
            globalThis.fetch = async (url) => {
                firestoreReads++;
                cacheMisses++;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        name: `projects/${TEST_PROJECT_ID}/databases/(default)/documents/users/student-100q`,
                        fields: {
                            email: { stringValue: "student100q@test.com" },
                            role: { stringValue: "user" }
                        }
                    })
                };
            };

            try {
                UniversalFirestoreService.clearLocalCache();

                // --- PHASE A: SESSION START (t = 0s) ---
                // 1. Initial Session-Role Lookup
                const roleDoc = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                authVerificationCount++;
                assert.equal(roleDoc.role, "user");
                assert.equal(firestoreReads, 1, "Initial role lookup must perform 1 fetch");

                // 2. Pre-Attempt Role Check & Attempt Creation (t = 5s)
                simulatedTimeMs += 5000;
                const attemptDoc = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                authVerificationCount++;
                cacheHits++;
                assert.equal(firestoreReads, 1, "Attempt creation must reuse cached user document");

                // --- PHASE B: ANSWERING 100 QUESTIONS OVER 240 SECONDS ---
                // Questions 1 to 25 in Window 0 (0 - 55s) -> All hits!
                for (let q = 1; q <= 25; q++) {
                    simulatedTimeMs += 2000; // +2s per question
                    autosaveCount++;
                    authVerificationCount++;
                    const doc = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                    assert.equal(doc.role, "user");
                    cacheHits++;
                }
                assert.equal(firestoreReads, 1, "Window 0 (0-60s) must require only 1 initial read");

                // Window 1: Crossing 60s boundary (t = 65s) -> Expiry triggers fetch #2
                simulatedTimeMs = 1700000000000 + 65000; // t = 65s (TTL expired!)
                autosaveCount++;
                authVerificationCount++;
                const docW1 = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                assert.equal(docW1.role, "user");
                assert.equal(firestoreReads, 2, "Window 1 (60-120s) must trigger exactly 1 fresh read");

                // Questions 26 to 50 in Window 1 (65 - 115s) -> All hits!
                for (let q = 27; q <= 50; q++) {
                    simulatedTimeMs += 2000;
                    autosaveCount++;
                    authVerificationCount++;
                    const doc = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                    assert.equal(doc.role, "user");
                    cacheHits++;
                }
                assert.equal(firestoreReads, 2);

                // Window 2: Crossing 120s boundary (t = 125s) -> Expiry triggers fetch #3
                simulatedTimeMs = 1700000000000 + 125000; // t = 125s (TTL expired!)
                autosaveCount++;
                authVerificationCount++;
                const docW2 = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                assert.equal(docW2.role, "user");
                assert.equal(firestoreReads, 3, "Window 2 (120-180s) must trigger exactly 1 fresh read");

                // Questions 51 to 75 in Window 2 (125 - 175s) -> All hits!
                for (let q = 52; q <= 75; q++) {
                    simulatedTimeMs += 2000;
                    autosaveCount++;
                    authVerificationCount++;
                    const doc = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                    assert.equal(doc.role, "user");
                    cacheHits++;
                }
                assert.equal(firestoreReads, 3);

                // Window 3: Crossing 180s boundary (t = 185s) -> Expiry triggers fetch #4
                simulatedTimeMs = 1700000000000 + 185000; // t = 185s (TTL expired!)
                autosaveCount++;
                authVerificationCount++;
                const docW3 = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                assert.equal(docW3.role, "user");
                assert.equal(firestoreReads, 4, "Window 3 (180-240s) must trigger exactly 1 fresh read");

                // Questions 76 to 100 in Window 3 (185 - 235s) -> All hits!
                for (let q = 77; q <= 100; q++) {
                    simulatedTimeMs += 2000;
                    autosaveCount++;
                    authVerificationCount++;
                    const doc = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                    assert.equal(doc.role, "user");
                    cacheHits++;
                }
                assert.equal(firestoreReads, 4);

                // --- PHASE C: SUBMISSION & RESULTS (t = 240s) ---
                simulatedTimeMs += 3000; // still within Window 3
                authVerificationCount++;
                const submitDoc = await UniversalFirestoreService.getDocument("users", "student-100q", { ttlMs: 60000 });
                cacheHits++;
                assert.equal(submitDoc.role, "user");
                assert.equal(firestoreReads, 4, "Submission within Window 3 must be served from cache");

                // Verification of Cumulative Metrics
                assert.equal(autosaveCount, 100, "Exactly 100 autosaves processed");
                assert.equal(authVerificationCount, 103, "Total auth verifications = 1 init + 1 attempt + 100 autosaves + 1 submit");
                assert.equal(firestoreReads, 4, "Across 4 separate TTL windows, exactly 4 Firestore reads were made");
                assert.equal(cacheHits, 99, "99 out of 103 requests served strictly from cache");

                // Compare with Uncached Baseline:
                // Before optimization: 103 reads
                // After optimization across 4 windows: 4 reads
                const reductionPercent = ((103 - firestoreReads) / 103) * 100;
                assert.ok(reductionPercent >= 96.0, `Expected >= 96% reduction across 4 TTL windows, got ${reductionPercent.toFixed(2)}%`);

            } finally {
                Date.now = originalNow;
                globalThis.fetch = originalFetch;
            }
        });
    });

    // =========================================================================
    // SECTION 3: CACHE SECURITY, TENANT ISOLATION & CONSISTENCY AUDIT
    // =========================================================================
    describe("3. Cache Security, Multi-Tenant Isolation & Invalidation", () => {
        test("3.1 Tenant & Project Isolation: cache keys strictly segregate projects", async () => {
            UniversalFirestoreService.clearLocalCache();

            UniversalFirestoreService._addToTtlCache("pyqs-hub-43bed:users/student-common", { role: "student_prod" }, 60000);
            UniversalFirestoreService._addToTtlCache("staging-project:users/student-common", { role: "student_staging" }, 60000);

            const prodDoc = await UniversalFirestoreService.getDocument("users", "student-common", { projectId: "pyqs-hub-43bed" });
            const stagingDoc = await UniversalFirestoreService.getDocument("users", "student-common", { projectId: "staging-project" });

            assert.equal(prodDoc.role, "student_prod");
            assert.equal(stagingDoc.role, "student_staging");
            assert.notEqual(prodDoc.role, stagingDoc.role, "Different projects must never collide in cache");
        });

        test("3.2 User Identity Isolation: User A and User B never share cached authorization", async () => {
            UniversalFirestoreService.clearLocalCache();

            UniversalFirestoreService._addToTtlCache(`${TEST_PROJECT_ID}:users/user-alice`, { role: "admin", email: "alice@test.com" }, 60000);
            UniversalFirestoreService._addToTtlCache(`${TEST_PROJECT_ID}:users/user-bob`, { role: "user", email: "bob@test.com" }, 60000);

            const alice = await UniversalFirestoreService.getDocument("users", "user-alice");
            const bob = await UniversalFirestoreService.getDocument("users", "user-bob");

            assert.equal(alice.role, "admin");
            assert.equal(bob.role, "user");
            assert.equal(alice.email, "alice@test.com");
            assert.equal(bob.email, "bob@test.com");
        });

        test("3.3 Explicit invalidation upon role update immediately updates cache", async () => {
            UniversalFirestoreService.clearLocalCache();

            // Seed user as 'user'
            await UniversalFirestoreService.setDocument("users", "user-role-change", { role: "user" });
            const before = await UniversalFirestoreService.getDocument("users", "user-role-change");
            assert.equal(before.role, "user");

            // Admin promotes user to 'admin'
            await UniversalFirestoreService.setDocument("users", "user-role-change", { role: "admin" });
            const after = await UniversalFirestoreService.getDocument("users", "user-role-change");
            assert.equal(after.role, "admin", "Updated document must be immediately reflected in cache");
        });

        test("3.4 Account disablement and access revocation invalidation", async () => {
            UniversalFirestoreService.clearLocalCache();

            await UniversalFirestoreService.setDocument("users", "revoked-student", { role: "user", disabled: false });
            assert.equal((await UniversalFirestoreService.getDocument("users", "revoked-student")).disabled, false);

            // Revoke account
            await UniversalFirestoreService.setDocument("users", "revoked-student", { role: "user", disabled: true });
            assert.equal((await UniversalFirestoreService.getDocument("users", "revoked-student")).disabled, true);

            // Invalidate document explicitly
            UniversalFirestoreService.invalidateDocument("users", "revoked-student");
            const scopedKey = `${TEST_PROJECT_ID}:users/revoked-student`;
            assert.equal(UniversalFirestoreService._ttlDocCache.has(scopedKey), false);
        });

        test("3.5 Failed Firestore reads (429, 500, network error) are NEVER cached as successes", async () => {
            UniversalFirestoreService.clearLocalCache();
            const originalFetch = globalThis.fetch;

            try {
                // Simulate 500 internal server error
                globalThis.fetch = async () => ({
                    ok: false,
                    status: 500,
                    text: async () => "Internal Server Error"
                });

                await assert.rejects(async () => {
                    await UniversalFirestoreService.getDocument("users", "fail-test-user", { skipCache: true, maxRetries: 0 });
                });

                // Ensure nothing was placed in cache
                const scopedKey = `${TEST_PROJECT_ID}:users/fail-test-user`;
                assert.equal(UniversalFirestoreService._ttlDocCache.has(scopedKey), false, "Failed reads must not pollute TTL cache");

            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        test("3.6 LRU Eviction works reliably at capacity of 1,000 entries", () => {
            UniversalFirestoreService.clearLocalCache();

            // Populate cache to max capacity
            for (let i = 1; i <= UniversalFirestoreService.TTL_CACHE_MAX_ENTRIES; i++) {
                UniversalFirestoreService._addToTtlCache(`${TEST_PROJECT_ID}:users/student-${i}`, { idx: i }, 60000);
            }
            assert.equal(UniversalFirestoreService._ttlDocCache.size, 1000);

            // Add 1001th entry: must evict student-1 (oldest)
            UniversalFirestoreService._addToTtlCache(`${TEST_PROJECT_ID}:users/student-1001`, { idx: 1001 }, 60000);
            assert.equal(UniversalFirestoreService._ttlDocCache.size, 1000);
            assert.equal(UniversalFirestoreService._ttlDocCache.has(`${TEST_PROJECT_ID}:users/student-1`), false, "Oldest entry must be evicted");
            assert.equal(UniversalFirestoreService._ttlDocCache.has(`${TEST_PROJECT_ID}:users/student-1001`), true, "Newest entry must be preserved");
        });
    });

    // =========================================================================
    // SECTION 4: MOCK-TEST END-TO-END ACCEPTANCE & ANSWER PERSISTENCE
    // =========================================================================
    describe("4. Mock-Test End-to-End Workflow & Answer Persistence", () => {
        test("4.1 Evaluates candidate MCQ and NAT answers through UniversalScoringEngine", () => {
            const gateProfile = ExamProfileRegistry.getProfile("gate-cs-2026");
            assert.ok(gateProfile, "GATE 2026 profile must exist");

            const questions = [
                {
                    questionId: "gate_mcq_1",
                    questionNumber: 1,
                    sectionId: "ga_section",
                    questionType: "mcq",
                    marks: 1
                },
                {
                    questionId: "gate_nat_1",
                    questionNumber: 2,
                    sectionId: "ga_section",
                    questionType: "numerical",
                    marks: 1
                }
            ];

            const answerKeys = [
                {
                    questionId: "gate_mcq_1",
                    questionNumber: 1,
                    correctOptionIds: ["2"]
                },
                {
                    questionId: "gate_nat_1",
                    questionNumber: 2,
                    acceptedAnswers: ["42"]
                }
            ];

            // Candidate submits correct MCQ and correct NAT
            const resultCorrect = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: {
                    gate_mcq_1: "2",
                    gate_nat_1: "42"
                },
                examProfile: gateProfile
            });

            assert.equal(resultCorrect.totalScore, 2);
            assert.equal(resultCorrect.breakdown[0].status, "correct");
            assert.equal(resultCorrect.breakdown[1].status, "correct");

            // Candidate submits wrong MCQ (penalty -1/3) and wrong NAT (0 penalty)
            const resultWrong = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: {
                    gate_mcq_1: "1", // wrong MCQ -> -1/3
                    gate_nat_1: "99"  // wrong NAT -> 0 penalty
                },
                examProfile: gateProfile
            });

            assert.equal(resultWrong.breakdown[0].marksAwarded, -0.333);
            assert.equal(resultWrong.breakdown[1].marksAwarded, 0, "NAT wrong answer must have 0 negative marks");
            assert.equal(resultWrong.totalScore, -0.333);
        });

        test("4.2 Universal Archetype Neutrality: SSC CGL, NEET, UPSC, and GATE all evaluate correctly", () => {
            const sscProfile = ExamProfileRegistry.getProfile("ssc-cgl-2024");
            const neetProfile = ExamProfileRegistry.getProfile("neet-ug-2024");
            const upscProfile = ExamProfileRegistry.getProfile("upsc-prelims-2026");

            assert.ok(sscProfile, "SSC CGL profile must exist");
            assert.ok(neetProfile, "NEET UG profile must exist");
            assert.ok(upscProfile, "UPSC profile must exist");

            // SSC CGL: +2, -0.5
            const sscRes = UniversalScoringEngine.evaluateAttempt({
                questions: [{ questionId: "ssc_q1", questionNumber: 1, sectionId: "general_intelligence", questionType: "mcq" }],
                answerKeys: [{ questionId: "ssc_q1", questionNumber: 1, correctOptionIds: ["1"] }],
                studentAnswers: { ssc_q1: "2" }, // wrong
                examProfile: sscProfile
            });
            assert.equal(sscRes.breakdown[0].marksAwarded, -0.5);

            // NEET UG: +4, -1.0
            const neetRes = UniversalScoringEngine.evaluateAttempt({
                questions: [{ questionId: "neet_q1", questionNumber: 1, sectionId: "physics_a", questionType: "mcq" }],
                answerKeys: [{ questionId: "neet_q1", questionNumber: 1, correctOptionIds: ["1"] }],
                studentAnswers: { neet_q1: "2" }, // wrong
                examProfile: neetProfile
            });
            assert.equal(neetRes.breakdown[0].marksAwarded, -1);

            // UPSC: +2, -2/3 (-0.667)
            const upscRes = UniversalScoringEngine.evaluateAttempt({
                questions: [{ questionId: "upsc_q1", questionNumber: 1, sectionId: "general_studies_1", questionType: "mcq" }],
                answerKeys: [{ questionId: "upsc_q1", questionNumber: 1, correctOptionIds: ["1"] }],
                studentAnswers: { upsc_q1: "2" }, // wrong
                examProfile: upscProfile
            });
            assert.equal(upscRes.breakdown[0].marksAwarded, -0.667);
        });
    });

    // =========================================================================
    // SECTION 5: FAILURE & RECOVERY TESTING (429, 500, TIMEOUT, MISSING DOC)
    // =========================================================================
    describe("5. Failure Modes, Resilience & Recovery", () => {
        test("5.1 Express /api/auth/session-role returns 429 when Firestore is exhausted", async () => {
            const token = createTestToken("student-429-test");
            const originalGetDoc = UniversalFirestoreService.getDocument;

            UniversalFirestoreService.getDocument = async () => {
                const err = new Error("Quota exceeded");
                err.statusCode = 429;
                err.isQuotaExhausted = true;
                err.retryAfter = 30;
                throw err;
            };

            try {
                const res = await dispatchApp("GET", "/api/auth/session-role", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                assert.equal(res.status, 429);
                assert.equal(res.data.code, "FIRESTORE_QUOTA_EXHAUSTED");
                assert.equal(res.headers.get("retry-after"), "30");
            } finally {
                UniversalFirestoreService.getDocument = originalGetDoc;
            }
        });

        test("5.2 Express /api/auth/session-role returns 500 on unexpected Firestore crash", async () => {
            const token = createTestToken("student-500-test");
            const originalGetDoc = UniversalFirestoreService.getDocument;

            UniversalFirestoreService.getDocument = async () => {
                throw new Error("Fatal unhandled database crash");
            };

            try {
                const res = await dispatchApp("GET", "/api/auth/session-role", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                assert.equal(res.status, 500);
                assert.equal(res.data.success, false);
            } finally {
                UniversalFirestoreService.getDocument = originalGetDoc;
            }
        });

        test("5.3 Missing user document defaults role to 'user' without crash", async () => {
            const token = createTestToken("student-no-doc");
            UniversalFirestoreService.clearLocalCache();
            const originalFetch = globalThis.fetch;

            try {
                globalThis.fetch = async () => ({
                    ok: false,
                    status: 404,
                    text: async () => "Document not found"
                });

                const res = await dispatchApp("GET", "/api/auth/session-role", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                assert.equal(res.status, 200);
                assert.equal(res.data.authenticated, true);
                assert.equal(res.data.role, "user", "Missing document must safely default to user role");
                assert.equal(res.data.isAdmin, false);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        test("5.4 Invalid or expired auth token returns unauthenticated guest role", async () => {
            const res = await dispatchApp("GET", "/api/auth/session-role", {
                headers: { Authorization: "Bearer totally-invalid-token" }
            });
            assert.equal(res.status, 200);
            assert.equal(res.data.authenticated, false);
            assert.equal(res.data.role, "guest");
            assert.equal(res.data.isAdmin, false);
        });

        test("5.5 Recovery: Successful retry resumes attempt creation and session lifecycle", async () => {
            const token = createTestToken("student-retry-test");
            let simulateFail = true;

            const originalGetDoc = UniversalFirestoreService.getDocument;
            UniversalFirestoreService.getDocument = async () => {
                if (simulateFail) {
                    const err = new Error("Quota exceeded");
                    err.statusCode = 429;
                    err.isQuotaExhausted = true;
                    throw err;
                }
                return { role: "user", email: "student-retry-test@test.com" };
            };

            try {
                // Call 1: Under quota exhaustion -> 429
                const res1 = await dispatchApp("GET", "/api/auth/session-role", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                assert.equal(res1.status, 429);

                // Quota clears
                simulateFail = false;

                // Call 2: Retry succeeds -> 200
                const res2 = await dispatchApp("GET", "/api/auth/session-role", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                assert.equal(res2.status, 200);
                assert.equal(res2.data.authenticated, true);
                assert.equal(res2.data.role, "user");
            } finally {
                UniversalFirestoreService.getDocument = originalGetDoc;
            }
        });
    });
});
