import http from "node:http";
import express from "express";
import studyResourcesRouter from "../server/routes/studyResources.js";

const app = express();
app.use(express.json());
app.use("/api/study-resources", studyResourcesRouter);

async function runTestSuite() {
    console.log("==================================================");
    console.log("STUDY RESOURCES COUNTER SECURITY & RELIABILITY TEST SUITE");
    console.log("==================================================");

    let mockDocStore = {
        "studyResources/jee-main/subjects/physics/chapters/gravitation": {
            status: "published",
            viewCount: 10,
            downloadCount: 5
        }
    };

    let lastCommitReceived = null;

    // 1. Spin up mock Firestore REST server
    const mockFirestorePort = 9876;
    const mockServer = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${mockFirestorePort}`);
        const pathname = url.pathname;

        if (req.method === "GET") {
            const prefix = "/v1/projects/pyqs-hub-43bed/databases/(default)/documents/";
            if (pathname.startsWith(prefix)) {
                const docPath = decodeURIComponent(pathname.substring(prefix.length));
                if (docPath.includes("non-existent")) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: { code: 404, message: "Document not found" } }));
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    name: `projects/pyqs-hub-43bed/databases/(default)/documents/${docPath}`,
                    fields: { status: { stringValue: "published" } }
                }));
                return;
            }
        }

        if (req.method === "POST" && pathname.endsWith(":commit")) {
            let body = "";
            req.on("data", chunk => body += chunk);
            req.on("end", () => {
                const parsed = JSON.parse(body);
                lastCommitReceived = parsed;
                const write = parsed.writes?.[0];
                const docPath = write?.transform?.document || "";

                if (docPath.includes("permission-denied-chapter")) {
                    res.writeHead(403, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        error: {
                            code: 403,
                            message: "Missing or insufficient permissions.",
                            status: "PERMISSION_DENIED"
                        }
                    }));
                    return;
                }

                const fieldTransform = write?.transform?.fieldTransforms?.[0];
                const fieldName = fieldTransform?.fieldPath;
                const incrementVal = fieldTransform?.increment?.integerValue;

                let storedCount = 1;
                if (fieldName === "viewCount") {
                    mockDocStore["studyResources/jee-main/subjects/physics/chapters/gravitation"].viewCount += Number(incrementVal || 1);
                    storedCount = mockDocStore["studyResources/jee-main/subjects/physics/chapters/gravitation"].viewCount;
                } else if (fieldName === "downloadCount") {
                    mockDocStore["studyResources/jee-main/subjects/physics/chapters/gravitation"].downloadCount += Number(incrementVal || 1);
                    storedCount = mockDocStore["studyResources/jee-main/subjects/physics/chapters/gravitation"].downloadCount;
                }

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    writeResults: [
                        {
                            transformResults: [
                                { integerValue: String(storedCount) }
                            ]
                        }
                    ]
                }));
            });
            return;
        }

        res.writeHead(404);
        res.end();
    });

    await new Promise((resolve) => mockServer.listen(mockFirestorePort, resolve));
    console.log(`[Test Mock] Mock Firestore REST server listening on port ${mockFirestorePort}`);

    // Spin up test server instance
    const testAppPort = 3099;
    const testAppServer = await new Promise((resolve) => {
        const s = app.listen(testAppPort, () => resolve(s));
    });

    const baseUrl = `http://127.0.0.1:${testAppPort}`;

    let testsPassed = 0;
    let testsFailed = 0;

    function assert(condition, testName, detail = "") {
        if (condition) {
            console.log(`  PASS: ${testName} ${detail ? "(" + detail + ")" : ""}`);
            testsPassed++;
        } else {
            console.error(`  FAIL: ${testName} ${detail ? "(" + detail + ")" : ""}`);
            testsFailed++;
        }
    }

    try {
        // Point emulator host to our mock
        process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${mockFirestorePort}`;

        // TEST 1: Reject missing/malformed hierarchy IDs
        console.log("\n--- TEST 1: Input Validation (Malformed IDs) ---");
        const res1 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ examId: "jee-main", subjectId: "" })
        });
        const data1 = await res1.json();
        assert(res1.status === 400 && data1.success === false, "Rejects incomplete IDs with HTTP 400", `status=${res1.status}`);

        // TEST 2: Path traversal attack rejection
        console.log("\n--- TEST 2: Path Traversal Attack Rejection ---");
        const res2 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ examId: "jee-main", subjectId: "../admin", chapterId: "config" })
        });
        const data2 = await res2.json();
        assert(res2.status === 400 && data2.success === false, "Rejects path traversal with HTTP 400", `status=${res2.status}`);

        // TEST 3: Invalid token rejection
        console.log("\n--- TEST 3: Invalid Bearer Token Rejection ---");
        const res3 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer invalid.fake.token"
            },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "gravitation"
            })
        });
        const data3 = await res3.json();
        assert(res3.status === 401 && data3.success === false, "Rejects invalid Bearer token with HTTP 401 Unauthorized", `status=${res3.status}`);

        // TEST 4: Non-existent document rejection
        console.log("\n--- TEST 4: Non-Existent Document Rejection ---");
        const res4 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "non-existent-chap-1",
                clientSessionId: "session_4"
            })
        });
        const data4 = await res4.json();
        assert(res4.status === 404 && data4.success === false, "Rejects non-existent chapter with HTTP 404 Not Found", `status=${res4.status}`);

        // TEST 5: Atomic view counter increment
        console.log("\n--- TEST 5: Atomic viewCount Increment (Fresh Event) ---");
        const res5 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "gravitation",
                clientSessionId: "session_user_alpha"
            })
        });
        const data5 = await res5.json();
        assert(
            res5.status === 200 && data5.success === true && data5.increment === 1 && data5.storedCount === 11,
            "Increments viewCount by 1 and returns new stored count",
            `storedCount=${data5.storedCount}`
        );
        assert(
            lastCommitReceived?.writes?.[0]?.transform?.fieldTransforms?.[0]?.fieldPath === "viewCount" &&
            lastCommitReceived?.writes?.[0]?.transform?.fieldTransforms?.[0]?.increment?.integerValue === "1",
            "Dispatches verified atomic REST transform (+1 increment)",
            JSON.stringify(lastCommitReceived?.writes?.[0]?.transform?.fieldTransforms?.[0])
        );

        // TEST 6: Deduplication behavior (duplicate event within window)
        console.log("\n--- TEST 6: Deduplication (Repeated Event within Window) ---");
        const res6 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "gravitation",
                clientSessionId: "session_user_alpha"
            })
        });
        const data6 = await res6.json();
        assert(
            res6.status === 200 && data6.success === true && data6.deduplicated === true && data6.increment === 0,
            "Deduplicates repeated event within window with increment: 0",
            `deduplicated=${data6.deduplicated}`
        );

        // TEST 7: Atomic download counter increment
        console.log("\n--- TEST 7: Atomic downloadCount Increment (Fresh Event) ---");
        const res7 = await fetch(`${baseUrl}/api/study-resources/increment-download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "gravitation",
                clientSessionId: "session_user_beta"
            })
        });
        const data7 = await res7.json();
        assert(
            res7.status === 200 && data7.success === true && data7.increment === 1 && data7.storedCount === 6,
            "Increments downloadCount by 1 and returns stored count",
            `storedCount=${data7.storedCount}`
        );
        assert(
            lastCommitReceived?.writes?.[0]?.transform?.fieldTransforms?.[0]?.fieldPath === "downloadCount" &&
            lastCommitReceived?.writes?.[0]?.transform?.fieldTransforms?.[0]?.increment?.integerValue === "1",
            "Dispatches verified atomic REST transform for downloadCount (+1)",
            JSON.stringify(lastCommitReceived?.writes?.[0]?.transform?.fieldTransforms?.[0])
        );

        // TEST 8: Deduplication behavior for downloadCount
        console.log("\n--- TEST 8: Deduplication for downloadCount ---");
        const res8 = await fetch(`${baseUrl}/api/study-resources/increment-download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "gravitation",
                clientSessionId: "session_user_beta"
            })
        });
        const data8 = await res8.json();
        assert(
            res8.status === 200 && data8.success === true && data8.deduplicated === true && data8.increment === 0,
            "Deduplicates repeated download event with increment: 0",
            `deduplicated=${data8.deduplicated}`
        );

        // TEST 9: Permission failure behavior (Firestore returns 403 PERMISSION_DENIED)
        console.log("\n--- TEST 9: Upstream Permission Failure Sanitization ---");
        const res9 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "permission-denied-chapter",
                clientSessionId: "session_gamma"
            })
        });
        const data9 = await res9.json();
        assert(
            res9.status === 500 && data9.success === false && data9.error.includes("permission denied"),
            "Transforms Firestore 403 into HTTP 500 with sanitized message (not misleading 400 or false success)",
            `status=${res9.status}, error=${data9.error}`
        );

        // TEST 10: Missing credentials behavior in production mode (no emulator)
        console.log("\n--- TEST 10: Unconfigured Privileged Credentials in Live Mode ---");
        delete process.env.FIRESTORE_EMULATOR_HOST;
        const res10 = await fetch(`${baseUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "jee-main",
                subjectId: "physics",
                chapterId: "gravitation",
                clientSessionId: "session_delta_no_creds"
            })
        });
        const data10 = await res10.json();
        assert(
            res10.status === 500 && data10.success === false && data10.error.includes("credentials not configured"),
            "Halts write and returns HTTP 500 when server privileged credentials are not configured",
            `status=${res10.status}, error=${data10.error}`
        );

    } finally {
        mockServer.close();
        testAppServer.close();
    }

    console.log("\n==================================================");
    console.log(`TOTAL TESTS: ${testsPassed + testsFailed} | PASSED: ${testsPassed} | FAILED: ${testsFailed}`);
    console.log("==================================================");

    if (testsFailed > 0) {
        process.exit(1);
    }
}

runTestSuite().catch((err) => {
    console.error("Test execution exception:", err);
    process.exit(1);
});
