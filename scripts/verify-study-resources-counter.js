/**
 * Verification Script for Study Resources View & Download Counters
 * 
 * Verifies against local backend & local Firestore emulator:
 * 1. Multi-exam & multi-subject document existence (Jee Mains, Competitive Exams GS)
 * 2. viewCount increment (+1) across multiple chapters
 * 3. downloadCount increment (+1) across multiple chapters
 * 4. Deduplication within active window
 * 5. Safe rejection of nonexistent chapter IDs (404)
 */

import dotenv from "dotenv";
dotenv.config();

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8088";
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";
const BACKEND_URL = `http://127.0.0.1:${process.env.PORT || 3000}`;

const TEST_TARGETS = [
    {
        examId: "Jee Mains",
        subjectId: "chemistry",
        chapterId: "chemical bonding",
        expectedTitle: "Chemical Bonding"
    },
    {
        examId: "COMPETITIVE EXAMS GS",
        subjectId: "HISTORY",
        chapterId: "ANCIENT HISTORY",
        expectedTitle: "ANCIENT HISTORY"
    },
    {
        examId: "Jee Mains",
        subjectId: "physics",
        chapterId: "motion in one plane",
        expectedTitle: "Motion In One Dimension"
    }
];

function getDocUrl(examId, subjectId, chapterId) {
    const docPath = `studyResources/${examId}/subjects/${subjectId}/chapters/${chapterId}`;
    const encoded = docPath.split("/").map(encodeURIComponent).join("/");
    return `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${encoded}`;
}

async function readStoredDoc(examId, subjectId, chapterId) {
    const url = getDocUrl(examId, subjectId, chapterId);
    const res = await fetch(url, {
        headers: { "Authorization": "Bearer owner" }
    });
    if (!res.ok) {
        throw new Error(`Failed to read doc (${examId}/${subjectId}/${chapterId}) from emulator: status ${res.status}`);
    }
    const data = await res.json();
    return {
        title: data.fields?.title?.stringValue,
        status: data.fields?.status?.stringValue,
        viewCount: Number(data.fields?.viewCount?.integerValue ?? 0),
        downloadCount: Number(data.fields?.downloadCount?.integerValue ?? 0)
    };
}

async function runVerification() {
    console.log("==================================================");
    console.log("STUDY RESOURCES COUNTER VERIFICATION SUITE");
    console.log("==================================================");
    console.log(`Backend URL:        ${BACKEND_URL}`);
    console.log(`Firestore Emulator: http://${EMULATOR_HOST}`);
    console.log("--------------------------------------------------");

    let passed = 0;
    let failed = 0;

    function assert(cond, testName, detail = "") {
        if (cond) {
            console.log(`  [PASS] ${testName} ${detail ? "-> " + detail : ""}`);
            passed++;
        } else {
            console.error(`  [FAIL] ${testName} ${detail ? "-> " + detail : ""}`);
            failed++;
        }
    }

    for (const target of TEST_TARGETS) {
        console.log(`\n--- Testing Chapter: ${target.examId} / ${target.subjectId} / ${target.chapterId} ---`);
        
        // 1. Existence check
        const initialDoc = await readStoredDoc(target.examId, target.subjectId, target.chapterId);
        assert(initialDoc && initialDoc.title === target.expectedTitle, `Target chapter exists (${target.chapterId})`);
        const beforeView = initialDoc.viewCount;
        const beforeDl = initialDoc.downloadCount;

        // 2. View increment
        const viewSession = `verify_view_${Date.now()}_${Math.random()}`;
        const viewRes = await fetch(`${BACKEND_URL}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: target.examId,
                subjectId: target.subjectId,
                chapterId: target.chapterId,
                clientSessionId: viewSession
            })
        });
        const viewData = await viewRes.json();
        assert(viewRes.status === 200, `View increment HTTP 200 (${target.chapterId})`);
        assert(viewData.success === true && viewData.increment === 1, `View increment success=true, increment=1`);
        
        const docAfterView = await readStoredDoc(target.examId, target.subjectId, target.chapterId);
        assert(docAfterView.viewCount === beforeView + 1, `Stored viewCount changed: ${beforeView} -> ${docAfterView.viewCount}`);

        // 3. Deduplication of View
        const dedupViewRes = await fetch(`${BACKEND_URL}/api/study-resources/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: target.examId,
                subjectId: target.subjectId,
                chapterId: target.chapterId,
                clientSessionId: viewSession
            })
        });
        const dedupViewData = await dedupViewRes.json();
        assert(dedupViewRes.status === 200, `Duplicate view HTTP 200`);
        assert(dedupViewData.deduplicated === true && dedupViewData.increment === 0, `Duplicate view deduplicated=true, increment=0`);
        const docAfterDedupView = await readStoredDoc(target.examId, target.subjectId, target.chapterId);
        assert(docAfterDedupView.viewCount === docAfterView.viewCount, `Stored viewCount stayed at ${docAfterDedupView.viewCount}`);

        // 4. Download increment
        const dlSession = `verify_dl_${Date.now()}_${Math.random()}`;
        const dlRes = await fetch(`${BACKEND_URL}/api/study-resources/increment-download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: target.examId,
                subjectId: target.subjectId,
                chapterId: target.chapterId,
                clientSessionId: dlSession
            })
        });
        const dlData = await dlRes.json();
        assert(dlRes.status === 200, `Download increment HTTP 200 (${target.chapterId})`);
        assert(dlData.success === true && dlData.increment === 1, `Download increment success=true, increment=1`);

        const docAfterDl = await readStoredDoc(target.examId, target.subjectId, target.chapterId);
        assert(docAfterDl.downloadCount === beforeDl + 1, `Stored downloadCount changed: ${beforeDl} -> ${docAfterDl.downloadCount}`);

        // 5. Deduplication of Download
        const dedupDlRes = await fetch(`${BACKEND_URL}/api/study-resources/increment-download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: target.examId,
                subjectId: target.subjectId,
                chapterId: target.chapterId,
                clientSessionId: dlSession
            })
        });
        const dedupDlData = await dedupDlRes.json();
        assert(dedupDlRes.status === 200, `Duplicate download HTTP 200`);
        assert(dedupDlData.deduplicated === true && dedupDlData.increment === 0, `Duplicate download deduplicated=true, increment=0`);
        const docAfterDedupDl = await readStoredDoc(target.examId, target.subjectId, target.chapterId);
        assert(docAfterDedupDl.downloadCount === docAfterDl.downloadCount, `Stored downloadCount stayed at ${docAfterDedupDl.downloadCount}`);
    }

    // 6. Test nonexistent chapter rejection
    console.log("\n--- Testing Nonexistent Chapter Rejection ---");
    const nonExistentRes = await fetch(`${BACKEND_URL}/api/study-resources/increment-view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            examId: "Jee Mains",
            subjectId: "chemistry",
            chapterId: "nonexistent-bogus-chapter-id",
            clientSessionId: `verify_bogus_${Date.now()}`
        })
    });
    const nonExistentData = await nonExistentRes.json();
    assert(nonExistentRes.status === 404, "Nonexistent chapter correctly returned HTTP 404 Not Found");
    assert(nonExistentData.success === false, "Nonexistent chapter returned success=false");
    assert(
        nonExistentData.error && nonExistentData.error.includes("Target study chapter document does not exist in Firestore"),
        "Returned safe sanitized error message without creating document"
    );

    console.log("\n==================================================");
    console.log(`VERIFICATION SUMMARY: ${passed} Passed | ${failed} Failed`);
    console.log("==================================================");

    process.exitCode = failed === 0 ? 0 : 1;
}

runVerification().catch((err) => {
    console.error("Verification failed with unhandled error:", err);
    process.exitCode = 1;
});
