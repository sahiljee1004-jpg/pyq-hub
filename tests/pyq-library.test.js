import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { PyqLibraryService, validateStorageUrl } from "../server/services/pyqLibraryService.js";

describe("Dedicated PYQ Library Examination-First Browsing Verification Suite", () => {
    let server;
    let pipePath;
    let keyPair;
    let wrongKeyPair;
    let originalFetch;

    const TEST_STUDENT_UID = "test_student_pyq_001";
    const TEST_STUDENT_EMAIL = "student@vidyarthiastra.in";

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "staging-vidyarthiastra";

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

        // Intercept globalThis.fetch for deterministic sandbox testing
        originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, options = {}) => {
            const urlStr = String(url);

            // 1. Mock Firestore aggregation count
            if (urlStr.includes("runAggregationQuery")) {
                return new Response(JSON.stringify([{
                    result: { aggregateFields: { totalPapers: { integerValue: "515" } } }
                }]), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 2. Mock Firestore collection group query (ordered by uploadedAt DESC)
            if (urlStr.includes("runQuery")) {
                return new Response(JSON.stringify([
                    {
                        document: {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2026/papers/paper-2026-s1",
                            fields: {
                                title: { stringValue: "JEE Main 2026 Shift 1" },
                                date: { stringValue: "24 January 2026" },
                                shift: { stringValue: "Shift 1" },
                                uploadedAt: { stringValue: "2026-01-25T10:00:00.000Z" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2026s1.pdf" }
                            },
                            createTime: "2026-01-25T10:00:00.000Z"
                        }
                    }
                ]), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 3. Mock Firestore exams collection
            if (urlStr.endsWith("/documents/exams")) {
                return new Response(JSON.stringify({
                    documents: [
                        { name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main", fields: { name: { stringValue: "JEE Main" } } },
                        { name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/NEET", fields: { name: { stringValue: "NEET" } } },
                        { name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/Gate", fields: { name: { stringValue: "Gate" } } }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 4. Mock Firestore years collection for JEE Main
            if (urlStr.includes("/exams/jee-main/years") && !urlStr.includes("/papers")) {
                return new Response(JSON.stringify({
                    documents: [
                        { name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2026" },
                        { name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2025" },
                        { name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2021" }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 5. Mock Firestore papers for year 2026 (3 papers)
            if (urlStr.includes("/exams/jee-main/years/2026/papers")) {
                return new Response(JSON.stringify({
                    documents: [
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2026/papers/jee-2026-s1",
                            fields: {
                                title: { stringValue: "JEE Main 2026 Shift 1" },
                                date: { stringValue: "24 January 2026" },
                                shift: { stringValue: "Shift 1" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2026s1.pdf" }
                            }
                        },
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2026/papers/jee-2026-s2",
                            fields: {
                                title: { stringValue: "JEE Main 2026 Shift 2" },
                                date: { stringValue: "24 January 2026" },
                                shift: { stringValue: "Shift 2" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2026s2.pdf" }
                            }
                        },
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2026/papers/jee-2026-s3",
                            fields: {
                                title: { stringValue: "JEE Main 2026 Shift 3" },
                                date: { stringValue: "25 January 2026" },
                                shift: { stringValue: "Shift 1" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2026s3.pdf" }
                            }
                        }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 6. Mock Firestore papers for year 2025 (3 papers)
            if (urlStr.includes("/exams/jee-main/years/2025/papers")) {
                return new Response(JSON.stringify({
                    documents: [
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2025/papers/jee-2025-s1",
                            fields: {
                                title: { stringValue: "JEE Main 2025 Shift 1" },
                                date: { stringValue: "22 January 2025" },
                                shift: { stringValue: "Shift 1" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2025s1.pdf" }
                            }
                        },
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2025/papers/jee-2025-s2",
                            fields: {
                                title: { stringValue: "JEE Main 2025 Shift 2" },
                                date: { stringValue: "22 January 2025" },
                                shift: { stringValue: "Shift 2" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2025s2.pdf" }
                            }
                        },
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2025/papers/jee-2025-s3",
                            fields: {
                                title: { stringValue: "JEE Main 2025 Shift 3" },
                                date: { stringValue: "23 January 2025" },
                                shift: { stringValue: "Shift 1" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2025s3.pdf" }
                            }
                        }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 7. Mock Firestore papers for year 2021 (1 paper)
            if (urlStr.includes("/exams/jee-main/years/2021/papers") && !urlStr.includes("Shift%201") && !urlStr.includes("Shift 1")) {
                return new Response(JSON.stringify({
                    documents: [
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2021/papers/16 March 2021 Shift 1",
                            fields: {
                                title: { stringValue: "16 March 2021 Shift 1" },
                                date: { stringValue: "16 March 2021" },
                                shift: { stringValue: "Shift 1" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2021s1.pdf" }
                            }
                        }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 8. Mock Firestore years collection for NEET
            if (urlStr.includes("/exams/NEET/years") && !urlStr.includes("/papers")) {
                return new Response(JSON.stringify({
                    documents: [
                        { name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/NEET/years/2025" }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 9. Mock Firestore papers for NEET 2025 (1 paper)
            if (urlStr.includes("/exams/NEET/years/2025/papers")) {
                return new Response(JSON.stringify({
                    documents: [
                        {
                            name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/NEET/years/2025/papers/paper-neet-2025",
                            fields: {
                                title: { stringValue: "NEET 2025 Paper Code Q1" },
                                date: { stringValue: "05 May 2025" },
                                uploadedAt: { stringValue: "2025-05-06T10:00:00.000Z" },
                                pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/neet2025.pdf" }
                            }
                        }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 10. Mock Gate: 0 years or 0 papers (test zero-paper exclusion)
            if (urlStr.includes("/exams/Gate/years")) {
                return new Response(JSON.stringify({ documents: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // 11. Mock Single Paper lookup
            if (urlStr.includes("/papers/16%20March%202021%20Shift%201") || urlStr.includes("/papers/16 March 2021 Shift 1")) {
                return new Response(JSON.stringify({
                    name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/jee-main/years/2021/papers/16 March 2021 Shift 1",
                    fields: {
                        title: { stringValue: "16 March 2021 Shift 1" },
                        date: { stringValue: "16 March 2021" },
                        shift: { stringValue: "Shift 1" },
                        pdfUrl: { stringValue: "https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/papers/jee2021s1.pdf" }
                    }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            if (urlStr.includes("NonExistentPaperId")) {
                return new Response("Not found", { status: 404 });
            }

            // 12. Mock Cloudinary PDF retrieval
            if (urlStr.includes("res.cloudinary.com") && urlStr.endsWith(".pdf")) {
                const pdfSample = Buffer.from("%PDF-1.4 sample PDF payload for testing %%EOF");
                return new Response(pdfSample, {
                    status: 200,
                    headers: {
                        "Content-Type": "application/pdf",
                        "Content-Length": String(pdfSample.length)
                    }
                });
            }

            return originalFetch(url, options);
        };

        // Start server on an IPC named pipe (Windows sandbox safe)
        pipePath = `\\\\.\\pipe\\test-pyq-suite-${Date.now()}`;
        await new Promise((resolve) => {
            server = app.listen(pipePath, () => resolve());
        });
    });

    after(async () => {
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    function createToken(uid, email = TEST_STUDENT_EMAIL, overrides = {}, kp = keyPair) {
        const now = Math.floor(Date.now() / 1000);
        const projectId = process.env.FIREBASE_PROJECT_ID || "staging-vidyarthiastra";
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-rsa-key" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
            iss: `https://securetoken.google.com/${projectId}`,
            aud: projectId,
            auth_time: now,
            user_id: uid,
            sub: uid,
            iat: now,
            exp: now + 3600,
            email: email,
            email_verified: true,
            ...overrides
        })).toString("base64url");
        const dataToSign = `${header}.${payload}`;
        const sign = crypto.createSign("RSA-SHA256");
        sign.update(dataToSign);
        const signature = sign.sign(kp.privateKey, "base64url");
        return `${dataToSign}.${signature}`;
    }

    function makeRequest(urlPath, options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                socketPath: pipePath,
                path: urlPath,
                method: options.method || "GET",
                headers: options.headers || {}
            }, (res) => {
                let text = "";
                res.on("data", chunk => text += chunk);
                res.on("end", () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text,
                        json: () => {
                            try { return JSON.parse(text); } catch (e) { return null; }
                        }
                    });
                });
            });
            req.on("error", reject);
            if (options.body) {
                req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
            }
            req.end();
        });
    }

    // ============================================================
    // SECTION 1: EXAMINATION-FIRST LAYOUT & UI CONSISTENCY
    // ============================================================

    test("1. GET /pyq-library.html serves valid HTML with Examination-First layout", async () => {
        const res = await makeRequest("/pyq-library.html");
        assert.equal(res.status, 200);
        assert.ok(res.text.includes("<!DOCTYPE html>"), "Is HTML document");
        assert.ok(res.text.includes("PYQ Library"), "Contains main title");
        assert.ok(res.text.includes("Find previous year question papers for JEE, NEET, SSC, Banking and other competitive examinations"), "Contains required tagline");
        assert.ok(res.text.includes("totalPyqCountNum"), "Contains total PYQ counter element");
        assert.ok(res.text.includes("pyqSearchInput"), "Contains search input element");
        assert.ok(res.text.includes("Browse Examinations"), "Contains Browse Examinations section");
        assert.ok(res.text.includes("examsSection"), "Contains examsSection container");
        assert.ok(res.text.includes("examsGrid"), "Contains examsGrid container");
        assert.ok(res.text.includes("yearsSection"), "Contains yearsSection container");
        assert.ok(res.text.includes("papersSection"), "Contains papersSection container");
        assert.ok(res.text.includes("pyqBreadcrumbsContainer"), "Contains breadcrumbs container");
        assert.ok(res.text.includes("paperViewer"), "Contains shared PDF viewer modal");
        assert.ok(res.text.includes("authRequiredModal"), "Contains Auth Required Modal for downloads");

        // REQUIREMENT: Must strictly NOT contain the removed latest 5 uploaded papers section
        assert.ok(!res.text.includes("Recently Added PYQs"), "Does not contain removed Recently Added PYQs section");
        assert.ok(!res.text.includes('id="recentSection"'), "Does not contain recentSection element");
    });

    test("2. Static CSS assets adhere to VidyarthiAstra light academic guidelines", () => {
        const cssPath = path.resolve("www/css/pyq-library.css");
        assert.ok(fs.existsSync(cssPath), "pyq-library.css exists");
        const css = fs.readFileSync(cssPath, "utf8");
        assert.ok(css.includes(".pyq-library-page"), "Defines main page container");
        assert.ok(css.includes("#f8fafc"), "Uses light academic background (#f8fafc)");
        assert.ok(css.includes("#ffffff"), "Uses white card surface (#ffffff)");
        assert.ok(css.includes("#2563eb"), "Uses primary blue accent (#2563eb)");
        assert.ok(css.includes(".pyq-exam-card"), "Defines exam card styles");
        assert.ok(css.includes(".pyq-year-card"), "Defines year card styles");
        assert.ok(css.includes(".pyq-breadcrumbs"), "Defines breadcrumb styles");
        assert.ok(css.includes(".pyq-back-nav-btn"), "Defines back button styles");
    });

    test("3. Global navigation contains ONLY Home, Contact, Profile (no feature links)", () => {
        const html = fs.readFileSync(path.resolve("www/pyq-library.html"), "utf8");
        const navBlockMatch = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(html);
        assert.ok(navBlockMatch, "Finds nav container");
        const navContent = navBlockMatch[1];

        // Must include only Home, Contact, Auth/Profile
        assert.ok(navContent.includes('href="index.html"'), "Links to Home");
        assert.ok(navContent.includes('href="contact.html"'), "Links to Contact");
        assert.ok(navContent.includes('id="authButton"'), "Includes Login/Signup button");

        // Must NOT include feature links
        assert.ok(!navContent.includes('href="mock-test.html"'), "No Mock Tests in top nav");
        assert.ok(!navContent.includes('href="live-updates.html"'), "No Live Updates in top nav");
        assert.ok(!navContent.includes('href="study-resources.html"'), "No Study Resources in top nav");
        assert.ok(!navContent.includes('href="ai-chat.html"'), "No AI Assistant in top nav");
        assert.ok(!navContent.includes('href="pyq-library.html"'), "No self-referential feature link in top nav");
    });

    // ============================================================
    // SECTION 2: STATS & AGGREGATION
    // ============================================================

    test("4. GET /api/papers/stats returns numeric paper count and caching metadata", async () => {
        const res = await makeRequest("/api/papers/stats");
        assert.equal(res.status, 200);
        const data = res.json();
        assert.equal(data.success, true);
        assert.equal(typeof data.totalPapers, "number");
        assert.ok(data.totalPapers > 0, "Total papers is a positive count");
        assert.equal(data.totalPapers, 515, "Matches expected catalog aggregation size (515)");
    });

    // ============================================================
    // SECTION 3: EXAMINATION-FIRST DIRECTORY API & ZERO-PAPER EXCLUSION
    // ============================================================

    test("5. GET /api/papers/exams dynamically returns examinations with > 0 papers", async () => {
        PyqLibraryService.invalidateAllCaches();
        const res = await makeRequest("/api/papers/exams");
        assert.equal(res.status, 200);
        const data = res.json();
        assert.equal(data.success, true);
        assert.ok(Array.isArray(data.exams), "Returns array of exams");

        const jee = data.exams.find(e => e.id === "jee-main");
        assert.ok(jee, "JEE Main is returned");
        assert.equal(jee.name, "JEE Main");
        assert.equal(jee.paperCount, 7, "JEE Main has 7 papers total (3 in 2026, 3 in 2025, 1 in 2021)");
        assert.equal(jee.yearCount, 3, "JEE Main has 3 years available");
        assert.equal(jee.yearRange, "2021 – 2026", "Computes clean year range 2021 – 2026");

        const neet = data.exams.find(e => e.id === "NEET");
        assert.ok(neet, "NEET is returned");
        assert.equal(neet.paperCount, 1, "NEET has 1 paper");
        assert.equal(neet.yearRange, "2025");
    });

    test("6. CORE REQUIREMENT: Examinations with zero available papers are strictly excluded", async () => {
        const res = await makeRequest("/api/papers/exams");
        const data = res.json();
        assert.equal(data.success, true);

        // Gate has 0 papers in Firestore mock
        const gate = data.exams.find(e => e.id.toLowerCase() === "gate" || e.name.toLowerCase() === "gate");
        assert.equal(gate, undefined, "Gate is strictly excluded because it has 0 available papers");

        // Every single returned examination MUST have paperCount > 0
        data.exams.forEach(exam => {
            assert.ok(exam.paperCount > 0, `Exam ${exam.id} must have > 0 papers`);
        });
    });

    test("7. GET /api/papers/exams?q= filters examination names case-insensitively", async () => {
        const resUpper = await makeRequest("/api/papers/exams?q=JEE%20MAIN");
        const resLower = await makeRequest("/api/papers/exams?q=jee%20main");
        const resNonExistent = await makeRequest("/api/papers/exams?q=NonExistentExamXYZ");

        const dataUpper = resUpper.json();
        const dataLower = resLower.json();
        const dataNone = resNonExistent.json();

        assert.equal(dataUpper.count, 1);
        assert.equal(dataUpper.exams[0].id, "jee-main");
        assert.equal(dataLower.count, 1);
        assert.equal(dataLower.exams[0].id, "jee-main");
        assert.equal(dataNone.count, 0);
    });

    // ============================================================
    // SECTION 4: YEAR SELECTION & PAPER RETRIEVAL
    // ============================================================

    test("8. GET /api/papers/years?examId= returns available years sorted descending", async () => {
        const res = await makeRequest("/api/papers/years?examId=jee-main");
        assert.equal(res.status, 200);
        const data = res.json();
        assert.equal(data.success, true);
        assert.equal(data.examId, "jee-main");
        assert.equal(data.count, 3);

        const yearNames = data.years.map(y => y.year);
        assert.deepEqual(yearNames, ["2026", "2025", "2021"], "Years are sorted in descending order");

        data.years.forEach(y => {
            assert.ok(y.paperCount > 0, `Year ${y.year} has > 0 papers`);
        });
    });

    test("9. Missing examId parameter in /api/papers/years returns HTTP 400", async () => {
        const res = await makeRequest("/api/papers/years");
        assert.equal(res.status, 400);
        const data = res.json();
        assert.equal(data.success, false);
    });

    test("10. GET /api/papers/by-year returns papers with pdfUrl redacted and hasPdf: true", async () => {
        const res = await makeRequest("/api/papers/by-year?examId=jee-main&yearId=2026&limit=10");
        assert.equal(res.status, 200);
        const data = res.json();
        assert.equal(data.success, true);
        assert.equal(data.examId, "jee-main");
        assert.equal(data.yearId, "2026");
        assert.equal(data.count, 3);
        assert.equal(data.totalPapers, 3);

        data.papers.forEach(p => {
            assert.equal(p.pdfUrl, undefined, "pdfUrl is strictly redacted from public paper payload");
            assert.equal(p.hasPdf, true, "hasPdf boolean indicator is provided");
            assert.ok(p.title, "Paper has title");
        });
    });

    test("11. GET /api/papers/by-year supports pagination with limit and offset cursor", async () => {
        const page1 = await makeRequest("/api/papers/by-year?examId=jee-main&yearId=2026&limit=2&cursor=0");
        const d1 = page1.json();
        assert.equal(d1.count, 2);
        assert.equal(d1.hasMore, true);
        assert.equal(d1.nextCursor, "2");

        const page2 = await makeRequest(`/api/papers/by-year?examId=jee-main&yearId=2026&limit=2&cursor=${d1.nextCursor}`);
        const d2 = page2.json();
        assert.equal(d2.count, 1);
        assert.equal(d2.hasMore, false);
        assert.equal(d2.nextCursor, null);

        // Ensure zero duplicate papers across pages
        const id1 = d1.papers.map(p => p.id);
        const id2 = d2.papers.map(p => p.id);
        assert.ok(!id1.includes(id2[0]), "Page 2 paper does not duplicate Page 1");
    });

    test("12. Missing examId or yearId in /api/papers/by-year returns HTTP 400", async () => {
        const res = await makeRequest("/api/papers/by-year?examId=jee-main");
        assert.equal(res.status, 400);
        const data = res.json();
        assert.equal(data.success, false);
    });

    // ============================================================
    // SECTION 5: PDF REDACTION & DOWNLOAD SECURITY (GATED PROXY)
    // ============================================================

    test("13. Unauthenticated request to /api/papers/download is rejected with HTTP 401", async () => {
        const res = await makeRequest("/api/papers/download?examId=jee-main&yearId=2021&paperId=16%20March%202021%20Shift%201");
        assert.equal(res.status, 401);
        const data = res.json();
        assert.equal(data.success, false);
        assert.ok(data.error.includes("Authentication required"));
    });

    test("14. Request to /api/papers/download with invalid token is rejected with HTTP 401", async () => {
        const res = await makeRequest("/api/papers/download?examId=jee-main&yearId=2021&paperId=16%20March%202021%20Shift%201", {
            headers: { "Authorization": "Bearer invalid.token.value" }
        });
        assert.equal(res.status, 401);
        const data = res.json();
        assert.equal(data.success, false);
    });

    test("15. Request with token signed by unauthorized keypair is rejected with HTTP 401", async () => {
        const forgedToken = createToken(TEST_STUDENT_UID, TEST_STUDENT_EMAIL, {}, wrongKeyPair);
        const res = await makeRequest("/api/papers/download?examId=jee-main&yearId=2021&paperId=16%20March%202021%20Shift%201", {
            headers: { "Authorization": `Bearer ${forgedToken}` }
        });
        assert.equal(res.status, 401);
        const data = res.json();
        assert.equal(data.success, false);
    });

    test("16. Authenticated request for existing paper streams PDF with attachment headers", async () => {
        const token = createToken(TEST_STUDENT_UID);
        const res = await makeRequest("/api/papers/download?examId=jee-main&yearId=2021&paperId=16%20March%202021%20Shift%201", {
            headers: { "Authorization": `Bearer ${token}` }
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers["content-type"], "application/pdf");
        assert.ok(res.headers["content-disposition"].includes("attachment"));
        assert.ok(res.headers["content-disposition"].includes(".pdf"));
        assert.ok(res.text.includes("%PDF-1.4"), "Streams non-empty PDF binary payload");
    });

    test("17. GET /api/papers/preview safely streams PDF with inline headers", async () => {
        const res = await makeRequest("/api/papers/preview?examId=jee-main&yearId=2021&paperId=16%20March%202021%20Shift%201");
        assert.equal(res.status, 200);
        assert.equal(res.headers["content-type"], "application/pdf");
        assert.ok(res.headers["content-disposition"].includes("inline"), "Sets Content-Disposition inline for preview");
        assert.ok(res.headers["cache-control"].includes("no-store"), "Sets private no-store cache headers");
        assert.ok(res.text.includes("%PDF-1.4"), "Streams PDF binary payload");
    });

    test("18. SSRF Guard: validateStorageUrl blocks private IPs, unauthorized domains, and insecure protocols", () => {
        // Private IP addresses
        assert.throws(() => validateStorageUrl("https://127.0.0.1/doc.pdf"), /blocked|private/i);
        assert.throws(() => validateStorageUrl("https://10.0.0.1/doc.pdf"), /blocked|private/i);
        assert.throws(() => validateStorageUrl("https://169.254.169.254/latest/meta-data/"), /blocked|private/i);
        assert.throws(() => validateStorageUrl("https://192.168.1.1/doc.pdf"), /blocked|private/i);
        assert.throws(() => validateStorageUrl("https://localhost/doc.pdf"), /blocked|private/i);
        assert.throws(() => validateStorageUrl("https://0.0.0.0/doc.pdf"), /blocked|private/i);
        assert.throws(() => validateStorageUrl("https://[::1]/doc.pdf"), /blocked|private/i);
        assert.throws(() => validateStorageUrl("https://[fe80::1]/doc.pdf"), /blocked|private/i);

        // Unauthorized domains
        assert.throws(() => validateStorageUrl("https://attacker-domain.com/malicious.pdf"), /Unauthorized storage domain/i);
        assert.throws(() => validateStorageUrl("https://storage.googleapis.com/not-allowed/doc.pdf"), /Unauthorized storage domain/i);

        // Insecure HTTP protocol
        assert.throws(() => validateStorageUrl("http://res.cloudinary.com/test.pdf"), /HTTPS is strictly required/i);

        // Allowed storage providers
        assert.ok(validateStorageUrl("https://res.cloudinary.com/vidyarthiastra/raw/upload/v1/test.pdf"));
        assert.ok(validateStorageUrl("https://firebasestorage.googleapis.com/v0/b/pyqs-hub-43bed.appspot.com/o/test.pdf"));
    });

    test("19. Streaming error responses do not leak upstream storage URLs", async () => {
        const res = await makeRequest("/api/papers/preview?examId=jee-main&yearId=2021&paperId=NonExistentPaperId123");
        assert.equal(res.status, 404);
        const data = res.json();
        assert.ok(!JSON.stringify(data).includes("cloudinary"), "Does not leak cloudinary URL");
        assert.ok(!JSON.stringify(data).includes("firebasestorage"), "Does not leak firebasestorage URL");
    });

    // ============================================================
    // SECTION 6: CACHE MANAGEMENT & INTEGRITY
    // ============================================================

    test("20. Cache invalidation hooks clear exam and count caches", async () => {
        await PyqLibraryService.getAvailableExams();
        const cached = await PyqLibraryService.getAvailableExams();
        assert.equal(cached.cached, true, "Second call returns cached data");

        PyqLibraryService.invalidateAllCaches();

        const fresh = await PyqLibraryService.getAvailableExams();
        assert.equal(fresh.cached, false, "After invalidation, fresh data is fetched");
    });

    test("21. Missing optional fields in paper documents do not cause 500 errors", () => {
        const parsed = PyqLibraryService._formatPaperDoc({
            name: "projects/test/databases/(default)/documents/exams/sample-exam/years/2025/papers/paper-min",
            fields: {
                title: { stringValue: "Minimal Paper" }
            }
        });

        assert.equal(parsed.title, "Minimal Paper");
        assert.equal(parsed.shift, "");
        assert.equal(parsed.subject, "");
        assert.equal(parsed.date, "");
        assert.equal(parsed.viewCount, 0);
        assert.equal(parsed.downloadCount, 0);
        assert.equal(parsed.pdfUrl, undefined, "pdfUrl is undefined on public doc format");
    });
});
