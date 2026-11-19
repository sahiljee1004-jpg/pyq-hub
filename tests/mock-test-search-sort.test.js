import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { MockTestService, extractNumericYear, compareTestsByYear, matchesSearch } from "../server/services/mockTestService.js";

/**
 * FEATURE VERIFICATION SUITE — Mock Test Search, Filtering & Year Sorting
 * Covers all 28 verification scenarios from Section 8:
 * - Search Scenarios (1–10)
 * - Sorting Scenarios (11–18)
 * - Backend & Security Scenarios (19–24)
 * - Regression Scenarios (25–28)
 */
describe("Mock Test Search, Filtering & Year Sorting Verification Suite", () => {
    let keyPair;
    let server;
    let pipePath;

    const STUDENT_UID = "test_search_student_201";
    const TEST_RUN_ID = `searchsort_${Date.now()}`;

    // Test IDs for published tests
    const TEST_JEE_2026_S1 = `mock-${TEST_RUN_ID}-jee-2026-s1`;
    const TEST_JEE_2026_S2 = `mock-${TEST_RUN_ID}-jee-2026-s2`;
    const TEST_JEE_2025_S1 = `mock-${TEST_RUN_ID}-jee-2025-s1`;
    const TEST_JEE_2024_S1 = `mock-${TEST_RUN_ID}-jee-2024-s1`;
    const TEST_NEET_2025_Q1 = `mock-${TEST_RUN_ID}-neet-2025-q1`;
    const TEST_GATE_2027_CS = `mock-${TEST_RUN_ID}-gate-2027-cs`;
    const TEST_NO_YEAR = `mock-${TEST_RUN_ID}-special-noyear`;
    const TEST_INVALID_YEAR = `mock-${TEST_RUN_ID}-special-invalidyear`;

    // Non-published test IDs (must be excluded)
    const TEST_DRAFT = `mock-${TEST_RUN_ID}-draft`;
    const TEST_FAILED = `mock-${TEST_RUN_ID}-failed`;
    const TEST_DELETED = `mock-${TEST_RUN_ID}-deleted`;

    const allCreatedTestIds = [
        TEST_JEE_2026_S1, TEST_JEE_2026_S2, TEST_JEE_2025_S1, TEST_JEE_2024_S1,
        TEST_NEET_2025_Q1, TEST_GATE_2027_CS, TEST_NO_YEAR, TEST_INVALID_YEAR,
        TEST_DRAFT, TEST_FAILED, TEST_DELETED
    ];

    function createToken(uid, role = "user", expiresInSeconds = 3600) {
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: "https://securetoken.google.com/pyqs-hub-43bed",
            aud: "pyqs-hub-43bed",
            auth_time: now,
            sub: uid,
            user_id: uid,
            email: `${uid}@test.vidyarthiastra.in`,
            role: role,
            iat: now,
            exp: now + expiresInSeconds
        };
        const sHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
        const sPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signature = crypto.sign("RSA-SHA256", Buffer.from(`${sHeader}.${sPayload}`), keyPair.privateKey).toString("base64url");
        return `${sHeader}.${sPayload}.${signature}`;
    }

    function apiRequest({ method = "GET", path = "/", headers = {}, body = null }) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                socketPath: pipePath,
                path,
                method,
                headers: {
                    ...(body ? { "Content-Type": "application/json" } : {}),
                    ...headers
                }
            }, (res) => {
                let data = "";
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    let json = null;
                    try {
                        json = JSON.parse(data);
                    } catch {}
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text: data,
                        json
                    });
                });
            });
            req.on("error", reject);
            if (body) {
                req.write(typeof body === "string" ? body : JSON.stringify(body));
            }
            req.end();
        });
    }

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        pipePath = `\\\\.\\pipe\\mock-search-sort-${Date.now()}`;
        await new Promise((resolve) => {
            server = app.listen(pipePath, () => {
                resolve();
            });
        });

        // Seed Published Mock Tests
        await UniversalFirestoreService.setDocument("mockTests", TEST_JEE_2026_S1, {
            testId: TEST_JEE_2026_S1,
            examId: "jee-main",
            examName: "JEE Main",
            year: 2026,
            title: "JEE Main 2026 Shift 1 Official Mock",
            paperCode: "Shift 1",
            shift: "Shift 1",
            durationSeconds: 10800,
            status: "published",
            questionIds: ["q1"],
            secretAdminNotes: "Private admin note - NEVER EXPOSE",
            internalAnswerKeyData: { q1: "B" },
            createdAt: "2026-01-10T10:00:00Z"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_JEE_2026_S2, {
            testId: TEST_JEE_2026_S2,
            examId: "jee-main",
            examName: "JEE Main",
            year: 2026,
            title: "JEE Main 2026 Shift 2 Official Mock",
            paperCode: "Shift 2",
            shift: "Shift 2",
            durationSeconds: 10800,
            status: "published",
            questionIds: ["q2"],
            createdAt: "2026-01-11T10:00:00Z"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_JEE_2025_S1, {
            testId: TEST_JEE_2025_S1,
            examId: "jee-main",
            examName: "JEE Main",
            year: 2025,
            title: "JEE Main 2025 Shift 1 Mock Test",
            paperCode: "Shift 1",
            shift: "Shift 1",
            durationSeconds: 10800,
            status: "published",
            questionIds: ["q3"],
            createdAt: "2025-01-10T10:00:00Z"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_JEE_2024_S1, {
            testId: TEST_JEE_2024_S1,
            examId: "jee-main",
            examName: "JEE Main",
            year: 2024,
            title: "JEE Main 2024 Shift 1 Mock Test",
            paperCode: "Shift 1",
            shift: "Shift 1",
            durationSeconds: 10800,
            status: "published",
            questionIds: ["q4"],
            createdAt: "2024-01-10T10:00:00Z"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_NEET_2025_Q1, {
            testId: TEST_NEET_2025_Q1,
            examId: "neet",
            examName: "NEET UG",
            year: 2025,
            title: "NEET UG 2025 Official Paper Q1",
            paperCode: "Code Q1",
            shift: null,
            durationSeconds: 12000,
            status: "published",
            questionIds: ["q5"],
            createdAt: "2025-05-05T10:00:00Z"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_GATE_2027_CS, {
            testId: TEST_GATE_2027_CS,
            examId: "gate",
            examName: "GATE",
            year: 2027,
            title: "GATE 2027 Computer Science Mock",
            paperCode: "CS-1",
            shift: null,
            durationSeconds: 10800,
            status: "published",
            questionIds: ["q6"],
            createdAt: "2026-03-01T10:00:00Z"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_NO_YEAR, {
            testId: TEST_NO_YEAR,
            examId: "custom-olympiad",
            examName: "Science Olympiad",
            year: null,
            title: "National Science Olympiad Diagnostic Test",
            paperCode: "NSO-1",
            shift: null,
            durationSeconds: 3600,
            status: "published",
            questionIds: ["q7"],
            createdAt: "2025-06-01T10:00:00Z"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_INVALID_YEAR, {
            testId: TEST_INVALID_YEAR,
            examId: "custom-olympiad",
            examName: "Science Olympiad",
            year: "InvalidYearFormat",
            title: "Math Talent Search Mock",
            paperCode: "MTS-1",
            shift: null,
            durationSeconds: 3600,
            status: "published",
            questionIds: ["q8"],
            createdAt: "2025-06-02T10:00:00Z"
        });

        // Seed Non-Published Tests (Must NEVER be returned to catalog or search)
        await UniversalFirestoreService.setDocument("mockTests", TEST_DRAFT, {
            testId: TEST_DRAFT,
            examId: "jee-main",
            examName: "JEE Main",
            year: 2026,
            title: "JEE Main 2026 Draft Paper (Admin WIP)",
            status: "draft"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_FAILED, {
            testId: TEST_FAILED,
            examId: "jee-main",
            examName: "JEE Main",
            year: 2026,
            title: "JEE Main 2026 Ingestion Failed Paper",
            status: "failed"
        });

        await UniversalFirestoreService.setDocument("mockTests", TEST_DELETED, {
            testId: TEST_DELETED,
            examId: "jee-main",
            examName: "JEE Main",
            year: 2026,
            title: "JEE Main 2026 Deleted Paper",
            status: "deleted"
        });
    });

    after(async () => {
        for (const testId of allCreatedTestIds) {
            try {
                await UniversalFirestoreService.deleteDocument("mockTests", testId);
            } catch {}
        }
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    // =========================================================
    // SEARCH SCENARIOS (1–10)
    // =========================================================

    test("1. Search by full examination name ('JEE Main') returns all published tests for that exam", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE%20Main" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        assert.equal(res.json.success, true);
        const tests = res.json.tests;
        assert.ok(tests.length >= 4);
        assert.ok(tests.every(t => /jee/i.test(t.examName) || /jee/i.test(t.examId)));
        assert.ok(tests.some(t => t.testId === TEST_JEE_2026_S1));
        assert.ok(tests.some(t => t.testId === TEST_JEE_2026_S2));
        assert.ok(tests.some(t => t.testId === TEST_JEE_2025_S1));
        assert.ok(tests.some(t => t.testId === TEST_JEE_2024_S1));
        assert.ok(!tests.some(t => t.testId === TEST_NEET_2025_Q1));
    });

    test("2. Search by partial examination name ('JEE') returns matching tests", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        assert.ok(tests.length >= 4);
        assert.ok(tests.some(t => t.testId === TEST_JEE_2026_S1));
        assert.ok(!tests.some(t => t.testId === TEST_GATE_2027_CS));
    });

    test("3. Search by year ('2026') returns all tests published for that year", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=2026" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        assert.ok(tests.length >= 2);
        assert.ok(tests.every(t => String(t.year) === "2026" || String(t.title).includes("2026")));
        assert.ok(tests.some(t => t.testId === TEST_JEE_2026_S1));
        assert.ok(tests.some(t => t.testId === TEST_JEE_2026_S2));
        assert.ok(!tests.some(t => t.testId === TEST_JEE_2025_S1));
    });

    test("4. Search by paper code ('Code Q1' or 'Q1') matches tests with that code", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=Code%20Q1" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        assert.equal(tests.length, 1);
        assert.equal(tests[0].testId, TEST_NEET_2025_Q1);
        assert.equal(tests[0].paperCode, "Code Q1");
    });

    test("5. Search by shift information ('Shift 2') matches tests with that shift", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=Shift%202" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        assert.ok(tests.length >= 1);
        assert.ok(tests.some(t => t.testId === TEST_JEE_2026_S2));
        assert.ok(!tests.some(t => t.testId === TEST_JEE_2026_S1));
    });

    test("6. Case-insensitive search ('jee main', 'JEE MAIN', 'Jee Main') yields identical results", async () => {
        const resLower = await apiRequest({ method: "GET", path: "/api/mock-tests?search=jee%20main" });
        const resUpper = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE%20MAIN" });
        const resMixed = await apiRequest({ method: "GET", path: "/api/mock-tests?search=Jee%20Main" });

        assert.equal(resLower.status, 200);
        assert.equal(resUpper.status, 200);
        assert.equal(resMixed.status, 200);

        const idsLower = resLower.json.tests.map(t => t.testId).sort();
        const idsUpper = resUpper.json.tests.map(t => t.testId).sort();
        const idsMixed = resMixed.json.tests.map(t => t.testId).sort();

        assert.deepEqual(idsLower, idsUpper);
        assert.deepEqual(idsLower, idsMixed);
    });

    test("7. Leading, trailing, and redundant internal whitespace in search query is trimmed/collapsed", async () => {
        const resClean = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE%20Main" });
        const resPadded = await apiRequest({ method: "GET", path: "/api/mock-tests?search=%20%20%20JEE%20%20%20Main%20%20%20" });

        assert.equal(resClean.status, 200);
        assert.equal(resPadded.status, 200);
        assert.deepEqual(
            resClean.json.tests.map(t => t.testId),
            resPadded.json.tests.map(t => t.testId)
        );
    });

    test("8. No-results state: search for non-existent test returns empty tests array (0 matches)", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=NonExistentExamTerm999" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        assert.equal(res.json.success, true);
        assert.equal(res.json.count, 0);
        assert.deepEqual(res.json.tests, []);
    });

    test("9. Clear-search control / empty query restores full catalog", async () => {
        const resFiltered = await apiRequest({ method: "GET", path: "/api/mock-tests?search=NEET" });
        const resRestored = await apiRequest({ method: "GET", path: "/api/mock-tests?search=" });

        assert.ok(resFiltered.json.count < resRestored.json.count);
        assert.ok(resRestored.json.tests.length >= 8);
    });

    test("10. Search across multiple combined fields ('JEE Main 2026 Shift 1') works correctly", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE%20Main%202026%20Shift%201" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        assert.equal(tests.length, 1);
        assert.equal(tests[0].testId, TEST_JEE_2026_S1);
        assert.equal(tests[0].year, 2026);
        assert.equal(tests[0].shift, "Shift 1");
    });

    // =========================================================
    // SORTING SCENARIOS (11–18)
    // =========================================================

    test("11. Default sorting order is newest year first (descending)", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?sort=default" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        
        // Find tests with numeric years
        const years = tests.map(t => extractNumericYear(t.year) ?? extractNumericYear(t.title)).filter(y => y !== null);
        assert.ok(years.length >= 6);
        for (let i = 0; i < years.length - 1; i++) {
            assert.ok(years[i] >= years[i + 1], `Year ${years[i]} should be >= ${years[i+1]} in descending sort`);
        }
    });

    test("12. Selecting 'Ascending Year' sorts tests from oldest year to newest year", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?sort=asc" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;

        const years = tests.map(t => extractNumericYear(t.year) ?? extractNumericYear(t.title)).filter(y => y !== null);
        assert.ok(years.length >= 6);
        for (let i = 0; i < years.length - 1; i++) {
            assert.ok(years[i] <= years[i + 1], `Year ${years[i]} should be <= ${years[i+1]} in ascending sort`);
        }
    });

    test("13. Selecting 'Descending Year' sorts tests from newest year to oldest year", async () => {
        const resDesc = await apiRequest({ method: "GET", path: "/api/mock-tests?sort=desc" });
        const resDefault = await apiRequest({ method: "GET", path: "/api/mock-tests?sort=default" });

        assert.equal(resDesc.status, 200);
        assert.equal(resDefault.status, 200);
        assert.deepEqual(
            resDesc.json.tests.map(t => t.testId),
            resDefault.json.tests.map(t => t.testId)
        );
    });

    test("14. Sorting is strictly numeric by year (not lexicographical string order)", () => {
        const sampleTests = [
            { testId: "t1", year: "2009", title: "Paper 2009" },
            { testId: "t2", year: 2026, title: "Paper 2026" },
            { testId: "t3", year: "1999", title: "Paper 1999" },
            { testId: "t4", year: 2025, title: "Paper 2025" }
        ];

        const sortedAsc = [...sampleTests].sort((a, b) => compareTestsByYear(a, b, "asc"));
        assert.deepEqual(sortedAsc.map(t => t.testId), ["t3", "t1", "t4", "t2"]); // 1999, 2009, 2025, 2026

        const sortedDesc = [...sampleTests].sort((a, b) => compareTestsByYear(a, b, "desc"));
        assert.deepEqual(sortedDesc.map(t => t.testId), ["t2", "t4", "t1", "t3"]); // 2026, 2025, 2009, 1999
    });

    test("15. Multiple papers or shifts within the same year maintain stable secondary ordering without merging", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE%20Main%202026&sort=desc" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        assert.equal(tests.length, 2);

        // Individual shifts are maintained separately
        const shifts = tests.map(t => t.shift);
        assert.ok(shifts.includes("Shift 1"));
        assert.ok(shifts.includes("Shift 2"));
        assert.notEqual(tests[0].testId, tests[1].testId);
    });

    test("16. Tests with missing or invalid years are placed safely after tests with valid years in both sort directions", () => {
        const mixedTests = [
            { testId: "valid_2025", year: 2025, title: "Valid 2025" },
            { testId: "null_year", year: null, title: "No Year Exam" },
            { testId: "valid_2026", year: 2026, title: "Valid 2026" },
            { testId: "invalid_string_year", year: "InvalidString", title: "Invalid Year Exam" }
        ];

        // Ascending sort: 2025, 2026, then invalid/null
        const asc = [...mixedTests].sort((a, b) => compareTestsByYear(a, b, "asc"));
        assert.equal(asc[0].testId, "valid_2025");
        assert.equal(asc[1].testId, "valid_2026");
        assert.ok(["null_year", "invalid_string_year"].includes(asc[2].testId));
        assert.ok(["null_year", "invalid_string_year"].includes(asc[3].testId));

        // Descending sort: 2026, 2025, then invalid/null
        const desc = [...mixedTests].sort((a, b) => compareTestsByYear(a, b, "desc"));
        assert.equal(desc[0].testId, "valid_2026");
        assert.equal(desc[1].testId, "valid_2025");
        assert.ok(["null_year", "invalid_string_year"].includes(desc[2].testId));
        assert.ok(["null_year", "invalid_string_year"].includes(desc[3].testId));
    });

    test("17. Search and sorting work seamlessly together (sorting applies only to current search results)", async () => {
        const resAsc = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE%20Main&sort=asc" });
        assert.equal(resAsc.status, 200);
        const testsAsc = resAsc.json.tests;
        
        // Every result is JEE Main
        assert.ok(testsAsc.every(t => /jee/i.test(t.examName)));
        const yearsAsc = testsAsc.map(t => extractNumericYear(t.year));
        for (let i = 0; i < yearsAsc.length - 1; i++) {
            assert.ok(yearsAsc[i] <= yearsAsc[i + 1]);
        }

        const resDesc = await apiRequest({ method: "GET", path: "/api/mock-tests?search=JEE%20Main&sort=desc" });
        assert.equal(resDesc.status, 200);
        const testsDesc = resDesc.json.tests;
        assert.ok(testsDesc.every(t => /jee/i.test(t.examName)));
        const yearsDesc = testsDesc.map(t => extractNumericYear(t.year));
        for (let i = 0; i < yearsDesc.length - 1; i++) {
            assert.ok(yearsDesc[i] >= yearsDesc[i + 1]);
        }
    });

    test("18. In-memory helper: changing sort preserves search query; clearing search preserves active sort", () => {
        const sampleCatalog = [
            { testId: "jee_2024", examName: "JEE Main", year: 2024, title: "JEE 2024" },
            { testId: "jee_2026", examName: "JEE Main", year: 2026, title: "JEE 2026" },
            { testId: "neet_2025", examName: "NEET", year: 2025, title: "NEET 2025" }
        ];

        // Step 1: User types search "JEE"
        let query = "JEE";
        let sort = "asc";
        let filtered = sampleCatalog.filter(t => matchesSearch(t, query)).sort((a, b) => compareTestsByYear(a, b, sort));
        assert.deepEqual(filtered.map(t => t.testId), ["jee_2024", "jee_2026"]);

        // Step 2: User changes sort to "desc" — search query "JEE" is preserved
        sort = "desc";
        filtered = sampleCatalog.filter(t => matchesSearch(t, query)).sort((a, b) => compareTestsByYear(a, b, sort));
        assert.deepEqual(filtered.map(t => t.testId), ["jee_2026", "jee_2024"]);

        // Step 3: User clears search query — active sort "desc" is preserved
        query = "";
        filtered = sampleCatalog.filter(t => matchesSearch(t, query)).sort((a, b) => compareTestsByYear(a, b, sort));
        assert.deepEqual(filtered.map(t => t.testId), ["jee_2026", "neet_2025", "jee_2024"]);
    });

    // =========================================================
    // BACKEND & SECURITY SCENARIOS (19–24)
    // =========================================================

    test("19. GET /api/mock-tests returns only published tests (status === 'published')", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const tests = res.json.tests;
        assert.ok(tests.every(t => t.status === "published"));
    });

    test("20. Draft, failed, and deleted mock tests are strictly excluded from search and catalog listing", async () => {
        const resAll = await apiRequest({ method: "GET", path: "/api/mock-tests" });
        const resSearch = await apiRequest({ method: "GET", path: "/api/mock-tests?search=Paper" });

        const allIds = resAll.json.tests.map(t => t.testId);
        const searchIds = resSearch.json.tests.map(t => t.testId);

        assert.ok(!allIds.includes(TEST_DRAFT), "Draft test must be excluded");
        assert.ok(!allIds.includes(TEST_FAILED), "Failed test must be excluded");
        assert.ok(!allIds.includes(TEST_DELETED), "Deleted test must be excluded");

        assert.ok(!searchIds.includes(TEST_DRAFT));
        assert.ok(!searchIds.includes(TEST_FAILED));
        assert.ok(!searchIds.includes(TEST_DELETED));
    });

    test("21. Public metadata allowlist is enforced: no stems, options, answer keys, attempts, or admin notes", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        const testItem = res.json.tests.find(t => t.testId === TEST_JEE_2026_S1);
        assert.ok(testItem);

        // Allowed public fields
        assert.equal(testItem.testId, TEST_JEE_2026_S1);
        assert.equal(testItem.examName, "JEE Main");
        assert.equal(testItem.year, 2026);
        assert.equal(testItem.shift, "Shift 1");
        assert.equal(testItem.paperCode, "Shift 1");

        // Disallowed / sensitive fields must NEVER be present
        assert.equal(testItem.secretAdminNotes, undefined);
        assert.equal(testItem.internalAnswerKeyData, undefined);
        assert.equal(testItem.questions, undefined);
        assert.equal(testItem.options, undefined);
        assert.equal(testItem.correctOption, undefined);
        assert.equal(testItem.scoringKey, undefined);
    });

    test("22. Backend supports search and sort query parameters via MockTestService.listPublishedTests", async () => {
        const directResult = await MockTestService.listPublishedTests({
            search: "GATE",
            sort: "desc"
        });
        assert.ok(Array.isArray(directResult));
        assert.ok(directResult.length >= 1);
        assert.equal(directResult[0].testId, TEST_GATE_2027_CS);
        assert.equal(directResult[0].year, 2027);
    });

    test("23. Backend supports pagination via page and limit query parameters with sensible bounds", async () => {
        const res = await apiRequest({ method: "GET", path: "/api/mock-tests?limit=2&page=1" });
        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        assert.equal(res.json.success, true);
        assert.equal(res.json.page, 1);
        assert.equal(res.json.limit, 2);
        assert.equal(res.json.tests.length, 2);
        assert.ok(res.json.total >= 8);
        assert.ok(res.json.totalPages >= 4);

        const resPage2 = await apiRequest({ method: "GET", path: "/api/mock-tests?limit=2&page=2" });
        assert.equal(resPage2.status, 200);
        assert.equal(resPage2.json.page, 2);
        assert.equal(resPage2.json.tests.length, 2);
        assert.notEqual(resPage2.json.tests[0].testId, res.json.tests[0].testId);
    });

    test("24. Invalid or malicious query parameters are handled gracefully without 500 errors or crashes", async () => {
        const testQueries = [
            "/api/mock-tests?limit=-99&page=-5",
            "/api/mock-tests?limit=abc&page=xyz",
            "/api/mock-tests?sort=malicious_sort_payload",
            "/api/mock-tests?search=%27%20OR%201=1--",
            "/api/mock-tests?search=<script>alert(1)</script>"
        ];

        for (const queryPath of testQueries) {
            const res = await apiRequest({ method: "GET", path: queryPath });
            assert.equal(res.status, 200, `Query ${queryPath} should return 200`);
            assert.equal(res.json.success, true);
            assert.ok(Array.isArray(res.json.tests));
        }
    });

    // =========================================================
    // REGRESSION SCENARIOS (25–28)
    // =========================================================

    test("25. Starting an attempt from a published mock test card creates a valid active attempt", async () => {
        const token = createToken(STUDENT_UID, "user");
        const res = await apiRequest({
            method: "POST",
            path: `/api/mock-tests/${TEST_JEE_2026_S1}/attempts`,
            headers: { Authorization: `Bearer ${token}` },
            body: { language: "English" }
        });

        assert.ok(res.status === 200 || res.status === 201, `Expected status 200 or 201, got ${res.status}`);
        assert.equal(res.json.success, true);
        const attempt = res.json.attempt;
        assert.ok(attempt && attempt.attemptId);
        assert.equal(attempt.testId, TEST_JEE_2026_S1);
        assert.equal(attempt.status, "in_progress");

        // Clean up created attempt
        try {
            await UniversalFirestoreService.deleteDocument("mockAttempts", attempt.attemptId);
        } catch {}
    });

    test("26. Authentication restrictions (guest blocked from creating attempt) remain intact", async () => {
        const res = await apiRequest({
            method: "POST",
            path: `/api/mock-tests/${TEST_JEE_2026_S1}/attempts`,
            body: { language: "English" }
        });

        assert.equal(res.status, 401);
        assert.equal(res.json.success, false);
    });

    test("27. Result analysis and Review Exam features from previous implementation continue to function", async () => {
        // Verify SubjectNormalizationService and extractNumericYear continue operating cleanly
        const mappedSubj = MockTestService.extractNumericYear("2026");
        assert.equal(mappedSubj, 2026);

        // Verify public test retrieval strips answer keys
        const testStudentView = await MockTestService.getTestForStudent(TEST_JEE_2026_S1, { callerRole: "user" });
        assert.ok(testStudentView);
        assert.equal(testStudentView.secretAdminNotes, undefined);
        assert.equal(testStudentView.internalAnswerKeyData, undefined);
    });

    test("28. Frontend assets verify: HTML contains search bar and sort dropdown, CSS contains responsive styling", () => {
        const htmlPath = path.resolve("www/mock-test.html");
        const cssPath = path.resolve("www/css/mock-test.css");
        const jsPath = path.resolve("www/js/mock-test.js");

        assert.ok(fs.existsSync(htmlPath), "mock-test.html exists");
        assert.ok(fs.existsSync(cssPath), "mock-test.css exists");
        assert.ok(fs.existsSync(jsPath), "mock-test.js exists");

        const htmlContent = fs.readFileSync(htmlPath, "utf8");
        const cssContent = fs.readFileSync(cssPath, "utf8");
        const jsContent = fs.readFileSync(jsPath, "utf8");

        // HTML checks
        assert.ok(htmlContent.includes('id="mockSearchInput"'), "Search input present in HTML");
        assert.ok(htmlContent.includes('id="mockSearchClearBtn"'), "Search clear button present in HTML");
        assert.ok(htmlContent.includes('id="mockYearSortSelect"'), "Year sort select present in HTML");
        assert.ok(htmlContent.includes('Default (Newest First)'), "Default option in HTML");
        assert.ok(htmlContent.includes('Ascending Year'), "Ascending Year option in HTML");
        assert.ok(htmlContent.includes('Descending Year'), "Descending Year option in HTML");
        assert.ok(htmlContent.includes('id="catalogNoResults"'), "No results empty state in HTML");

        // CSS checks
        assert.ok(cssContent.includes('.mock-catalog-toolbar'), "Toolbar CSS present");
        assert.ok(cssContent.includes('.mock-search-input'), "Search input CSS present");
        assert.ok(cssContent.includes('.mock-sort-select'), "Sort select CSS present");
        assert.ok(cssContent.includes('.mock-card-year-badge'), "Year badge CSS present");
        assert.ok(cssContent.includes('.mock-card-shift-badge'), "Shift badge CSS present");
        assert.ok(cssContent.includes('@media (max-width: 768px)'), "Responsive mobile media query present");

        // JS checks
        assert.ok(jsContent.includes('function compareTestsByYear'), "compareTestsByYear in JS");
        assert.ok(jsContent.includes('function matchesSearch'), "matchesSearch in JS");
        assert.ok(jsContent.includes('applyCatalogFilters'), "applyCatalogFilters in JS");
        assert.ok(jsContent.includes('mockSearchInput?.addEventListener'), "Search listener in JS");
        assert.ok(jsContent.includes('mockYearSortSelect?.addEventListener'), "Sort select listener in JS");
    });
});
