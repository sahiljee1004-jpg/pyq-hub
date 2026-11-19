import express from "express";
import studyResourcesRouter from "../server/routes/studyResources.js";

async function runRealEmulatorE2E() {
    console.log("==================================================");
    console.log("REAL FIRESTORE EMULATOR END-TO-END TEST SUITE");
    console.log("==================================================");

    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
    console.log("Detected FIRESTORE_EMULATOR_HOST:", emulatorHost);

    if (!emulatorHost) {
        console.error("FATAL: FIRESTORE_EMULATOR_HOST is not set. This test must run inside firebase emulators:exec.");
        process.exit(1);
    }

    const projectId = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";

    // Start local express test server
    const app = express();
    app.use(express.json());
    app.use("/api/study-resources", studyResourcesRouter);

    const testPort = 3099;
    const server = await new Promise((resolve) => {
        const s = app.listen(testPort, () => resolve(s));
    });
    const serverUrl = `http://127.0.0.1:${testPort}`;
    console.log(`Express test server listening on ${serverUrl}`);

    const examId = "Jee Mains";
    const subjectId = "physics";
    const chapterId = "gravitation";
    const chapterDocPath = `studyResources/${examId}/subjects/${subjectId}/chapters/${chapterId}`;

    const firestoreBaseUrl = `http://${emulatorHost}/v1/projects/${projectId}/databases/(default)/documents`;
    const docUrl = `${firestoreBaseUrl}/${chapterDocPath.split('/').map(encodeURIComponent).join('/')}`;

    // Helper: read real document from emulator
    async function readRealDoc() {
        const res = await fetch(docUrl, {
            headers: { "Authorization": "Bearer owner" }
        });
        if (!res.ok) {
            throw new Error(`Failed to read document from emulator: status ${res.status}`);
        }
        const data = await res.json();
        return {
            title: data.fields?.title?.stringValue,
            status: data.fields?.status?.stringValue,
            viewCount: Number(data.fields?.viewCount?.integerValue ?? 0),
            downloadCount: Number(data.fields?.downloadCount?.integerValue ?? 0)
        };
    }

    // Helper: seed document in real emulator
    async function seedRealDoc(initialViews = 15, initialDownloads = 7) {
        const res = await fetch(docUrl, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer owner"
            },
            body: JSON.stringify({
                fields: {
                    title: { stringValue: "Gravitation Notes" },
                    status: { stringValue: "published" },
                    viewCount: { integerValue: String(initialViews) },
                    downloadCount: { integerValue: String(initialDownloads) }
                }
            })
        });
        if (!res.ok) {
            throw new Error(`Failed to seed document in emulator: status ${res.status}`);
        }
        return readRealDoc();
    }

    let testsPassed = 0;
    let testsFailed = 0;

    function assert(condition, name, detail = "") {
        if (condition) {
            console.log(`  [PASS] ${name} ${detail ? "-> " + detail : ""}`);
            testsPassed++;
        } else {
            console.error(`  [FAIL] ${name} ${detail ? "-> " + detail : ""}`);
            testsFailed++;
        }
    }

    try {
        console.log("\n--- PHASE 1: Seeding Real Document in Firestore Emulator ---");
        const initialDoc = await seedRealDoc(15, 7);
        console.log("Initial real document state:", JSON.stringify(initialDoc));
        assert(initialDoc.viewCount === 15 && initialDoc.downloadCount === 7, "Seeded document exists in real Firestore emulator");

        // TEST 1: End-to-end view counter increment
        console.log("\n--- TEST 1: View Counter Atomic Increment ---");
        const res1 = await fetch(`${serverUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId,
                subjectId,
                chapterId,
                clientSessionId: "session_real_e2e_user_1"
            })
        });
        const data1 = await res1.json();
        const docAfterView1 = await readRealDoc();
        console.log("Response 1:", JSON.stringify(data1));
        console.log("Real Doc after View 1:", JSON.stringify(docAfterView1));

        assert(res1.status === 200, "Endpoint returned HTTP 200 OK", `status=${res1.status}`);
        assert(data1.success === true && data1.increment === 1, "API returned success=true, increment=1");
        assert(data1.storedCount === 16, "API returned storedCount=16", `storedCount=${data1.storedCount}`);
        assert(docAfterView1.viewCount === 16, "Real Firestore emulator stored viewCount incremented by exactly 1 (15 -> 16)", `stored=${docAfterView1.viewCount}`);
        assert(docAfterView1.downloadCount === 7, "Unrelated downloadCount remained untouched at 7", `downloadCount=${docAfterView1.downloadCount}`);

        // TEST 2: Deduplication on repeated view within window
        console.log("\n--- TEST 2: View Counter Deduplication ---");
        const res2 = await fetch(`${serverUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId,
                subjectId,
                chapterId,
                clientSessionId: "session_real_e2e_user_1"
            })
        });
        const data2 = await res2.json();
        const docAfterView2 = await readRealDoc();
        console.log("Response 2 (Duplicate):", JSON.stringify(data2));
        console.log("Real Doc after Duplicate View:", JSON.stringify(docAfterView2));

        assert(res2.status === 200, "Duplicate request returned HTTP 200 OK");
        assert(data2.deduplicated === true && data2.increment === 0, "Duplicate request identified with deduplicated=true, increment=0");
        assert(docAfterView2.viewCount === 16, "Real Firestore emulator viewCount did NOT increment again (still 16)");

        // TEST 3: End-to-end download counter increment
        console.log("\n--- TEST 3: Download Counter Atomic Increment ---");
        const res3 = await fetch(`${serverUrl}/api/study-resources/increment-download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId,
                subjectId,
                chapterId,
                clientSessionId: "session_real_e2e_user_2"
            })
        });
        const data3 = await res3.json();
        const docAfterDownload1 = await readRealDoc();
        console.log("Response 3:", JSON.stringify(data3));
        console.log("Real Doc after Download 1:", JSON.stringify(docAfterDownload1));

        assert(res3.status === 200, "Download endpoint returned HTTP 200 OK", `status=${res3.status}`);
        assert(data3.success === true && data3.increment === 1, "API returned success=true, increment=1");
        assert(data3.storedCount === 8, "API returned storedCount=8", `storedCount=${data3.storedCount}`);
        assert(docAfterDownload1.downloadCount === 8, "Real Firestore emulator stored downloadCount incremented by exactly 1 (7 -> 8)", `stored=${docAfterDownload1.downloadCount}`);
        assert(docAfterDownload1.viewCount === 16, "viewCount remained unchanged at 16", `viewCount=${docAfterDownload1.viewCount}`);

        // TEST 4: Deduplication on repeated download within window
        console.log("\n--- TEST 4: Download Counter Deduplication ---");
        const res4 = await fetch(`${serverUrl}/api/study-resources/increment-download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId,
                subjectId,
                chapterId,
                clientSessionId: "session_real_e2e_user_2"
            })
        });
        const data4 = await res4.json();
        const docAfterDownload2 = await readRealDoc();
        console.log("Response 4 (Duplicate):", JSON.stringify(data4));

        assert(res4.status === 200, "Duplicate download returned HTTP 200 OK");
        assert(data4.deduplicated === true && data4.increment === 0, "Duplicate download identified with deduplicated=true, increment=0");
        assert(docAfterDownload2.downloadCount === 8, "Real Firestore emulator downloadCount did NOT increment again (still 8)");

        // TEST 5: Invalid Bearer Token Rejection
        console.log("\n--- TEST 5: Invalid Bearer Token Rejection ---");
        const res5 = await fetch(`${serverUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer bad.token.tampered"
            },
            body: JSON.stringify({
                examId,
                subjectId,
                chapterId
            })
        });
        const data5 = await res5.json();
        assert(res5.status === 401 && data5.success === false, "Rejects invalid Bearer token with HTTP 401 Unauthorized", `status=${res5.status}`);
        const docAfterBadToken = await readRealDoc();
        assert(docAfterBadToken.viewCount === 16, "No count changes occurred on invalid token rejection");

        // TEST 6: Non-existent document
        console.log("\n--- TEST 6: Non-Existent Document Rejection ---");
        const res6 = await fetch(`${serverUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId,
                subjectId,
                chapterId: "non-existent-chap-xyz",
                clientSessionId: "session_real_e2e_user_3"
            })
        });
        const data6 = await res6.json();
        assert(res6.status === 404 && data6.success === false, "Rejects non-existent chapter with HTTP 404 Not Found", `status=${res6.status}`);

        // TEST 7: Malformed parameters / path traversal
        console.log("\n--- TEST 7: Malformed Parameters & Path Traversal Rejection ---");
        const res7 = await fetch(`${serverUrl}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "../../../admin",
                subjectId,
                chapterId
            })
        });
        const data7 = await res7.json();
        assert(res7.status === 400 && data7.success === false, "Rejects malformed parameter with HTTP 400 Bad Request", `status=${res7.status}`);

        // TEST 8: Verify no silent fallthrough to live production Firestore when emulator host is unset
        console.log("\n--- TEST 8: Fallthrough Prevention (Live Mode without Server Credentials) ---");
        const originalEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
        delete process.env.FIRESTORE_EMULATOR_HOST;
        try {
            const res8 = await fetch(`${serverUrl}/api/study-resources/increment-view`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    examId,
                    subjectId,
                    chapterId,
                    clientSessionId: "session_real_e2e_user_4"
                })
            });
            const data8 = await res8.json();
            console.log("Fallthrough prevention response:", JSON.stringify(data8));
            assert(
                res8.status === 500 && data8.success === false && data8.error.includes("credentials not configured"),
                "Halts safely with HTTP 500 and prevents silent fallthrough to live Firestore without privileged credentials",
                `status=${res8.status}`
            );
        } finally {
            process.env.FIRESTORE_EMULATOR_HOST = originalEmulatorHost;
        }

    } finally {
        server.close();
    }

    console.log("\n==================================================");
    console.log(`REAL EMULATOR E2E RESULTS: ${testsPassed + testsFailed} Tests | ${testsPassed} Passed | ${testsFailed} Failed`);
    console.log("==================================================");

    if (testsFailed > 0) {
        process.exit(1);
    }
}

runRealEmulatorE2E().catch((err) => {
    console.error("E2E Test Exception:", err);
    process.exit(1);
});
