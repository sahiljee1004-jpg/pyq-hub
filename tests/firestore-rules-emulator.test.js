import test, { describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const EMULATOR_HOST = "http://127.0.0.1:8088";
const PROJECT_ID = "demo-vidyarthiastra-rules-emulator";
const BASE_URL = `${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/**
 * Convert plain JS object to Firestore REST fields
 */
function toFirestoreFields(obj) {
    const fields = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        if (v === null) {
            fields[k] = { nullValue: null };
        } else if (typeof v === "boolean") {
            fields[k] = { booleanValue: v };
        } else if (typeof v === "number") {
            if (Number.isInteger(v)) {
                fields[k] = { integerValue: String(v) };
            } else {
                fields[k] = { doubleValue: v };
            }
        } else if (typeof v === "string") {
            fields[k] = { stringValue: v };
        } else if (v instanceof Date) {
            fields[k] = { timestampValue: v.toISOString() };
        } else if (Array.isArray(v)) {
            fields[k] = { arrayValue: { values: v.map(item => Object.values(toFirestoreFields({ item }))[0]) } };
        } else if (typeof v === "object") {
            fields[k] = { mapValue: { fields: toFirestoreFields(v) } };
        }
    }
    return fields;
}

function makeToken(uid, email = `${uid}@test.com`) {
    if (!uid) return null;
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        aud: PROJECT_ID,
        sub: uid,
        user_id: uid,
        email: email
    })).toString("base64url");
    return `${header}.${payload}.`;
}

async function seedDoc(docPath, data) {
    const res = await fetch(`${BASE_URL}/${docPath}`, {
        method: "PATCH",
        headers: {
            "Authorization": "Bearer owner",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ fields: toFirestoreFields(data) })
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to seed ${docPath} (${res.status}): ${text}`);
    }
    return res.json();
}

async function getDocAs(docPath, uid = null) {
    const headers = {};
    const token = makeToken(uid);
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${BASE_URL}/${docPath}`, { headers });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

async function createDocAs(collectionPath, docId, data, uid = null) {
    const headers = { "Content-Type": "application/json" };
    const token = makeToken(uid);
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const url = docId 
        ? `${BASE_URL}/${collectionPath}/${docId}`
        : `${BASE_URL}/${collectionPath}`;
    
    // In Firestore REST, creating a doc with a specific ID is PATCH (or POST to parent collection with ?documentId=docId)
    const method = docId ? "POST" : "POST";
    const targetUrl = docId ? `${BASE_URL}/${collectionPath}?documentId=${encodeURIComponent(docId)}` : url;

    const res = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields: toFirestoreFields(data) })
    });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

async function patchDocAs(docPath, data, uid = null, updateMaskFields = null) {
    const headers = { "Content-Type": "application/json" };
    const token = makeToken(uid);
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let url = `${BASE_URL}/${docPath}`;
    if (Array.isArray(updateMaskFields) && updateMaskFields.length > 0) {
        const maskQuery = updateMaskFields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
        url += `?${maskQuery}`;
    }

    const res = await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ fields: toFirestoreFields(data) })
    });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

async function deleteDocAs(docPath, uid = null) {
    const headers = {};
    const token = makeToken(uid);
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${BASE_URL}/${docPath}`, { method: "DELETE", headers });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

describe("Cloud Firestore Emulator 1.22.0 — Real Security Rules Engine Verification", () => {
    const ADMIN_UID = "admin_user_001";
    const STUDENT_A_UID = "student_a_002";
    const STUDENT_B_UID = "student_b_003";
    const EDITOR_UID = "editor_user_004";

    before(async () => {
        // Seed database roles for role-check helpers: hasUserRole('admin') / hasUserRole('editor')
        await seedDoc(`users/${ADMIN_UID}`, { uid: ADMIN_UID, email: "admin@test.com", role: "admin" });
        await seedDoc(`users/${STUDENT_A_UID}`, { uid: STUDENT_A_UID, email: "student_a@test.com", role: "user" });
        await seedDoc(`users/${STUDENT_B_UID}`, { uid: STUDENT_B_UID, email: "student_b@test.com", role: "user" });
        await seedDoc(`users/${EDITOR_UID}`, { uid: EDITOR_UID, email: "editor@test.com", role: "editor" });

        // Seed mock tests: 1 published, 1 draft
        await seedDoc("mockTests/test_pub_01", { testId: "test_pub_01", title: "Published Test", status: "published" });
        await seedDoc("mockTests/test_draft_01", { testId: "test_draft_01", title: "Draft Test", status: "draft" });

        // Seed mock questions
        await seedDoc("mockQuestions/q_pub_01", { questionId: "q_pub_01", testId: "test_pub_01", questionText: "Public Q1" });
        await seedDoc("mockQuestions/q_draft_01", { questionId: "q_draft_01", testId: "test_draft_01", questionText: "Secret Q1" });

        // Seed mock answer keys
        await seedDoc("mockAnswerKeys/ak_pub_01", { answerKeyId: "ak_pub_01", testId: "test_pub_01", correctAnswers: ["A"] });

        // Seed attempts
        await seedDoc("mockAttempts/attempt_student_a", {
            attemptId: "attempt_student_a",
            testId: "test_pub_01",
            userId: STUDENT_A_UID,
            status: "in_progress",
            answers: { q1: "A" }
        });

        // Seed results
        await seedDoc("mockResults/result_student_a", {
            resultId: "result_student_a",
            attemptId: "attempt_student_a",
            testId: "test_pub_01",
            userId: STUDENT_A_UID,
            totalScore: 720
        });

        // Seed study resources
        await seedDoc("studyResources/neet-ug", { examId: "neet-ug", title: "NEET UG Resources" });
        await seedDoc("studyResources/neet-ug/subjects/physics", { subjectId: "physics", title: "Physics" });
        await seedDoc("studyResources/neet-ug/subjects/physics/chapters/chap_pub", { chapterId: "chap_pub", title: "Optics", status: "published" });
        await seedDoc("studyResources/neet-ug/subjects/physics/chapters/chap_draft", { chapterId: "chap_draft", title: "Draft Magnetism", status: "draft" });

        // Seed PYQ papers
        await seedDoc("exams/neet-ug/years/2024/papers/paper_q1", {
            paperId: "paper_q1",
            title: "NEET 2024 Q1",
            viewCount: 10,
            downloadCount: 5
        });

        // Seed nested PYQ question
        await seedDoc("exams/neet-ug/years/2024/papers/paper_q1/questions/1", {
            questionNumber: 1,
            questionText: "What is the speed of light in vacuum?"
        });

        // Seed legacy user without role field
        await seedDoc("users/legacy_student_005", {
            uid: "legacy_student_005",
            email: "legacy@test.com",
            name: "Legacy Student"
        });
    });

    // -------------------------------------------------------------------------
    // TEST 1: Mock Tests — Anonymous & Student Draft vs Published Read Access
    // -------------------------------------------------------------------------
    test("1. Mock Tests: Published test is readable by all, but draft test is blocked for anonymous and students (Admin only)", async () => {
        // Published test -> readable by anonymous
        const pubAnon = await getDocAs("mockTests/test_pub_01", null);
        assert.equal(pubAnon.status, 200, "Anonymous should read published test");

        // Published test -> readable by student
        const pubStudent = await getDocAs("mockTests/test_pub_01", STUDENT_A_UID);
        assert.equal(pubStudent.status, 200, "Student should read published test");

        // Draft test -> BLOCKED (403) for anonymous
        const draftAnon = await getDocAs("mockTests/test_draft_01", null);
        assert.equal(draftAnon.status, 403, "Anonymous must NOT read draft test");

        // Draft test -> BLOCKED (403) for student
        const draftStudent = await getDocAs("mockTests/test_draft_01", STUDENT_A_UID);
        assert.equal(draftStudent.status, 403, "Student must NOT read draft test");

        // Draft test -> PERMITTED (200) for admin
        const draftAdmin = await getDocAs("mockTests/test_draft_01", ADMIN_UID);
        assert.equal(draftAdmin.status, 200, "Admin must be allowed to read draft test");
    });

    // -------------------------------------------------------------------------
    // TEST 2: Mock Questions & Answer Keys Direct Access Restriction
    // -------------------------------------------------------------------------
    test("2. Mock Questions & Answer Keys: Direct client reads blocked for students; answer keys blocked for everyone", async () => {
        // Ordinary student trying to read mockQuestions directly -> BLOCKED (403)
        const qStudent = await getDocAs("mockQuestions/q_pub_01", STUDENT_A_UID);
        assert.equal(qStudent.status, 403, "Student must NOT read mockQuestions directly");

        // Anonymous trying to read mockQuestions directly -> BLOCKED (403)
        const qAnon = await getDocAs("mockQuestions/q_pub_01", null);
        assert.equal(qAnon.status, 403, "Anonymous must NOT read mockQuestions directly");

        // Admin reading mockQuestions -> PERMITTED (200)
        const qAdmin = await getDocAs("mockQuestions/q_pub_01", ADMIN_UID);
        assert.equal(qAdmin.status, 200, "Admin can read mockQuestions");

        // Ordinary student trying to read mockAnswerKeys -> BLOCKED (403)
        const akStudent = await getDocAs("mockAnswerKeys/ak_pub_01", STUDENT_A_UID);
        assert.equal(akStudent.status, 403, "Student must NOT read mockAnswerKeys");

        // Admin trying to read mockAnswerKeys via client SDK -> BLOCKED (403)
        const akAdmin = await getDocAs("mockAnswerKeys/ak_pub_01", ADMIN_UID);
        assert.equal(akAdmin.status, 403, "Client SDK admin must NOT read mockAnswerKeys (if false rule)");
    });

    // -------------------------------------------------------------------------
    // TEST 3: Attempts & Results Read Isolation (Ownership Enforcement)
    // -------------------------------------------------------------------------
    test("3. Attempts & Results: Students can read ONLY their own records; cross-student read is blocked", async () => {
        // Student A reads own attempt -> PERMITTED (200)
        const attOwner = await getDocAs("mockAttempts/attempt_student_a", STUDENT_A_UID);
        assert.equal(attOwner.status, 200, "Owner student should read own attempt");

        // Student B reads Student A's attempt -> BLOCKED (403)
        const attOther = await getDocAs("mockAttempts/attempt_student_a", STUDENT_B_UID);
        assert.equal(attOther.status, 403, "Non-owner student must NOT read another's attempt");

        // Anonymous reads Student A's attempt -> BLOCKED (403)
        const attAnon = await getDocAs("mockAttempts/attempt_student_a", null);
        assert.equal(attAnon.status, 403, "Anonymous must NOT read attempt");

        // Student A reads own result -> PERMITTED (200)
        const resOwner = await getDocAs("mockResults/result_student_a", STUDENT_A_UID);
        assert.equal(resOwner.status, 200, "Owner student should read own result");

        // Student B reads Student A's result -> BLOCKED (403)
        const resOther = await getDocAs("mockResults/result_student_a", STUDENT_B_UID);
        assert.equal(resOther.status, 403, "Non-owner student must NOT read another's result");

        // Admin reads Student A's result -> PERMITTED (200)
        const resAdmin = await getDocAs("mockResults/result_student_a", ADMIN_UID);
        assert.equal(resAdmin.status, 200, "Admin can read student result");
    });

    // -------------------------------------------------------------------------
    // TEST 4: Direct Client Creation & Modification of Attempts/Results Denied
    // -------------------------------------------------------------------------
    test("4. Attempt/Result Writes: Direct client creation and modification blocked for students", async () => {
        // Student tries to directly create a mockAttempt -> BLOCKED (403)
        const createAtt = await createDocAs("mockAttempts", "attempt_tampered_01", {
            attemptId: "attempt_tampered_01",
            userId: STUDENT_A_UID,
            status: "submitted",
            totalScore: 720
        }, STUDENT_A_UID);
        assert.equal(createAtt.status, 403, "Student must NOT directly create mockAttempts");

        // Student tries to directly patch/update their mockAttempt -> BLOCKED (403)
        const patchAtt = await patchDocAs("mockAttempts/attempt_student_a", {
            status: "submitted",
            totalScore: 720
        }, STUDENT_A_UID);
        assert.equal(patchAtt.status, 403, "Student must NOT directly update mockAttempts");

        // Student tries to directly delete their mockAttempt -> BLOCKED (403)
        const delAtt = await deleteDocAs("mockAttempts/attempt_student_a", STUDENT_A_UID);
        assert.equal(delAtt.status, 403, "Student must NOT directly delete mockAttempts");

        // Student tries to directly create a mockResult -> BLOCKED (403)
        const createRes = await createDocAs("mockResults", "result_tampered_01", {
            resultId: "result_tampered_01",
            userId: STUDENT_A_UID,
            totalScore: 720
        }, STUDENT_A_UID);
        assert.equal(createRes.status, 403, "Student must NOT directly create mockResults");
    });

    // -------------------------------------------------------------------------
    // TEST 5: User Signup, Profile Updates, and Role Escalation Protection
    // -------------------------------------------------------------------------
    test("5. Users Collection: Signup with role='user' permitted, role escalation and cross-user updates blocked", async () => {
        const NEW_USER_UID = "new_signup_student_099";

        // Legitimate signup: isOwner + role=='user' + uid==userId -> PERMITTED (200)
        const signupRes = await createDocAs("users", NEW_USER_UID, {
            uid: NEW_USER_UID,
            name: "New Student",
            email: "newstudent@test.com",
            role: "user"
        }, NEW_USER_UID);
        assert.equal(signupRes.status, 200, "Legitimate signup with role='user' must succeed");

        // Malicious signup: trying to set role='admin' -> BLOCKED (403)
        const BAD_USER_UID = "malicious_signup_098";
        const badSignup = await createDocAs("users", BAD_USER_UID, {
            uid: BAD_USER_UID,
            name: "Hacker",
            email: "hacker@test.com",
            role: "admin"
        }, BAD_USER_UID);
        assert.equal(badSignup.status, 403, "Signup with role='admin' must be rejected");

        // Legitimate profile update: Student A updating their name/email with role preserved -> PERMITTED (200)
        const updateOk = await patchDocAs(`users/${STUDENT_A_UID}`, {
            name: "Student A Updated Name",
            email: "student_a@test.com",
            role: "user"
        }, STUDENT_A_UID);
        assert.equal(updateOk.status, 200, "Profile name update must succeed");

        // Role escalation update: Student A trying to update role to 'admin' -> BLOCKED (403)
        const escalateRes = await patchDocAs(`users/${STUDENT_A_UID}`, {
            role: "admin"
        }, STUDENT_A_UID);
        assert.equal(escalateRes.status, 403, "Self-promotion to admin must be rejected");

        // Cross-user update: Student B trying to update Student A's profile -> BLOCKED (403)
        const crossUpdate = await patchDocAs(`users/${STUDENT_A_UID}`, {
            name: "Hacked Name"
        }, STUDENT_B_UID);
        assert.equal(crossUpdate.status, 403, "Cross-user profile update must be rejected");
    });

    // -------------------------------------------------------------------------
    // TEST 6: Contact Form Schema Validation & Abuse Prevention
    // -------------------------------------------------------------------------
    test("6. Contacts: Valid contact form payload succeeds; unexpected or malicious fields are rejected", async () => {
        // Valid contact form payload from guest
        const validGuestContact = await createDocAs("contacts", null, {
            userId: "",
            name: "Ramesh Sharma",
            email: "ramesh@example.com",
            message: "Need help with NEET papers",
            status: "new",
            createdAt: new Date()
        }, null);
        assert.equal(validGuestContact.status, 200, "Valid guest contact form must be accepted");

        // Valid contact form payload from logged-in student
        const validUserContact = await createDocAs("contacts", null, {
            userId: STUDENT_A_UID,
            name: "Student A",
            email: "student_a@test.com",
            message: "Feedback on question 12",
            status: "new",
            createdAt: new Date()
        }, STUDENT_A_UID);
        assert.equal(validUserContact.status, 200, "Valid authenticated contact form must be accepted");

        // Malicious contact: unexpected extra field 'isAdmin' -> BLOCKED (403)
        const badFieldContact = await createDocAs("contacts", null, {
            userId: "",
            name: "Spammer",
            email: "spam@example.com",
            message: "Spam message",
            status: "new",
            createdAt: new Date(),
            isAdmin: true // Unexpected field
        }, null);
        assert.equal(badFieldContact.status, 403, "Contact submission with unexpected fields must be rejected");

        // Malicious contact: trying to set status to 'resolved' -> BLOCKED (403)
        const badStatusContact = await createDocAs("contacts", null, {
            userId: "",
            name: "Spammer",
            email: "spam@example.com",
            message: "Spam message",
            status: "resolved", // Illegal status
            createdAt: new Date()
        }, null);
        assert.equal(badStatusContact.status, 403, "Contact submission with non-new status must be rejected");
    });

    // -------------------------------------------------------------------------
    // TEST 7: PYQ Viewing & Counter Increments
    // -------------------------------------------------------------------------
    test("7. PYQ Papers: Public read allowed; counter update allowed ONLY for viewCount/downloadCount +1", async () => {
        // Public read of paper
        const paperRes = await getDocAs("exams/neet-ug/years/2024/papers/paper_q1", null);
        assert.equal(paperRes.status, 200, "Public read of papers must succeed");

        // Legitimate counter increment: viewCount 10 -> 11
        const viewIncRes = await patchDocAs("exams/neet-ug/years/2024/papers/paper_q1", {
            viewCount: 11
        }, null, ["viewCount"]);
        assert.equal(viewIncRes.status, 200, "Valid viewCount increment by 1 must succeed");

        // Illegal counter modification: jumping from 11 -> 20 (not +1) -> BLOCKED (403)
        const jumpIncRes = await patchDocAs("exams/neet-ug/years/2024/papers/paper_q1", {
            viewCount: 20
        }, null, ["viewCount"]);
        assert.equal(jumpIncRes.status, 403, "Arbitrary viewCount jumps must be rejected");

        // Illegal title modification by anonymous client -> BLOCKED (403)
        const titleHack = await patchDocAs("exams/neet-ug/years/2024/papers/paper_q1", {
            title: "Defaced Paper Title"
        }, null, ["title"]);
        assert.equal(titleHack.status, 403, "Arbitrary paper metadata updates must be rejected");
    });

    // -------------------------------------------------------------------------
    // TEST 8: Study Resources Publication & Role-Based Access
    // -------------------------------------------------------------------------
    test("8. Study Resources: Published chapters are public; draft chapters require editor or admin", async () => {
        // Published chapter -> readable by anonymous
        const pubChapAnon = await getDocAs("studyResources/neet-ug/subjects/physics/chapters/chap_pub", null);
        assert.equal(pubChapAnon.status, 200, "Published study chapter must be public");

        // Draft chapter -> BLOCKED (403) for anonymous
        const draftChapAnon = await getDocAs("studyResources/neet-ug/subjects/physics/chapters/chap_draft", null);
        assert.equal(draftChapAnon.status, 403, "Draft chapter must be blocked for anonymous");

        // Draft chapter -> BLOCKED (403) for ordinary student
        const draftChapStudent = await getDocAs("studyResources/neet-ug/subjects/physics/chapters/chap_draft", STUDENT_A_UID);
        assert.equal(draftChapStudent.status, 403, "Draft chapter must be blocked for ordinary student");

        // Draft chapter -> PERMITTED (200) for editor
        const draftChapEditor = await getDocAs("studyResources/neet-ug/subjects/physics/chapters/chap_draft", EDITOR_UID);
        assert.equal(draftChapEditor.status, 200, "Draft chapter must be readable by editor");

        // Draft chapter -> PERMITTED (200) for admin
        const draftChapAdmin = await getDocAs("studyResources/neet-ug/subjects/physics/chapters/chap_draft", ADMIN_UID);
        assert.equal(draftChapAdmin.status, 200, "Draft chapter must be readable by admin");
    });

    // -------------------------------------------------------------------------
    // TEST 9: PYQ Question Subcollection Protection & Root Isolation
    // -------------------------------------------------------------------------
    test("9. Question Documents: Nested paper questions allow public read but STRICTLY BLOCK all client writes (Anonymous and Student)", async () => {
        // Public read of nested question -> PERMITTED (200)
        const qRead = await getDocAs("exams/neet-ug/years/2024/papers/paper_q1/questions/1", null);
        assert.equal(qRead.status, 200, "Public read of paper question must succeed");

        // Anonymous attempt to write/update nested question -> BLOCKED (403)
        const anonWrite = await patchDocAs("exams/neet-ug/years/2024/papers/paper_q1/questions/1", {
            questionText: "Defaced by Hacker"
        }, null);
        assert.equal(anonWrite.status, 403, "Anonymous client write to paper question must be rejected");

        // Student attempt to update nested question -> BLOCKED (403)
        const studentWrite = await patchDocAs("exams/neet-ug/years/2024/papers/paper_q1/questions/1", {
            questionText: "Tampered by Student"
        }, STUDENT_A_UID);
        assert.equal(studentWrite.status, 403, "Student write to paper question must be rejected");

        // Anonymous attempt to create nested question -> BLOCKED (403)
        const anonCreate = await createDocAs("exams/neet-ug/years/2024/papers/paper_q1/questions", "99", {
            questionNumber: 99,
            questionText: "Unauthorized question"
        }, null);
        assert.equal(anonCreate.status, 403, "Direct client creation of paper question must be rejected");

        // Student attempt to delete nested question -> BLOCKED (403)
        const studentDelete = await deleteDocAs("exams/neet-ug/years/2024/papers/paper_q1/questions/1", STUDENT_A_UID);
        assert.equal(studentDelete.status, 403, "Student deletion of paper question must be rejected");

        // Client attempt to write to unmapped root collection /questions/{id} -> BLOCKED (403)
        const rootQuestionWrite = await createDocAs("questions", "hacked_root_q1", {
            text: "Root injection"
        }, null);
        assert.equal(rootQuestionWrite.status, 403, "Direct write to root /questions collection must be rejected");
    });

    // -------------------------------------------------------------------------
    // TEST 10: Privilege Escalation, Legacy Document & Role Boundary Regressions
    // -------------------------------------------------------------------------
    test("10. Users Escalation Safeguards: Role injection, isAdmin bypass, and legacy user boundaries strictly enforced", async () => {
        // Malicious signup injecting isAdmin: true -> BLOCKED (403)
        const BAD_ISADMIN_UID = "hacker_isadmin_001";
        const badIsAdmin = await createDocAs("users", BAD_ISADMIN_UID, {
            uid: BAD_ISADMIN_UID,
            name: "Hacker Admin Flag",
            email: "hacker1@test.com",
            role: "user",
            isAdmin: true
        }, BAD_ISADMIN_UID);
        assert.equal(badIsAdmin.status, 403, "Signup with isAdmin: true must be rejected");

        // Malicious signup attempting role: 'editor' -> BLOCKED (403)
        const BAD_EDITOR_UID = "hacker_editor_002";
        const badEditor = await createDocAs("users", BAD_EDITOR_UID, {
            uid: BAD_EDITOR_UID,
            name: "Hacker Editor",
            email: "hacker2@test.com",
            role: "editor"
        }, BAD_EDITOR_UID);
        assert.equal(badEditor.status, 403, "Signup with role: 'editor' must be rejected");

        // Student profile update attempting to inject isAdmin: true -> BLOCKED (403)
        const escalateIsAdmin = await patchDocAs(`users/${STUDENT_A_UID}`, {
            isAdmin: true
        }, STUDENT_A_UID);
        assert.equal(escalateIsAdmin.status, 403, "Profile update injecting isAdmin: true must be rejected");

        // Student profile update attempting to modify UID -> BLOCKED (403)
        const tamperUid = await patchDocAs(`users/${STUDENT_A_UID}`, {
            uid: "spoofed_target_uid_999"
        }, STUDENT_A_UID);
        assert.equal(tamperUid.status, 403, "Profile update modifying uid must be rejected");

        // Student attempting to delete user record -> BLOCKED (403)
        const deleteSelf = await deleteDocAs(`users/${STUDENT_A_UID}`, STUDENT_A_UID);
        assert.equal(deleteSelf.status, 403, "Student deleting own user record must be rejected");

        // Legacy user (no role field) legitimately updating name/email -> PERMITTED (200)
        const LEGACY_UID = "legacy_student_005";
        const legacyUpdateOk = await patchDocAs(`users/${LEGACY_UID}`, {
            name: "Legacy Student Updated Name"
        }, LEGACY_UID);
        assert.equal(legacyUpdateOk.status, 200, "Legacy user without role field must be allowed to update name");

        // Legacy user attempting to escalate to role: 'admin' -> BLOCKED (403)
        const legacyEscalateAdmin = await patchDocAs(`users/${LEGACY_UID}`, {
            role: "admin"
        }, LEGACY_UID);
        assert.equal(legacyEscalateAdmin.status, 403, "Legacy user attempting to set role='admin' must be rejected");

        // Legacy user attempting to escalate to role: 'editor' -> BLOCKED (403)
        const legacyEscalateEditor = await patchDocAs(`users/${LEGACY_UID}`, {
            role: "editor"
        }, LEGACY_UID);
        assert.equal(legacyEscalateEditor.status, 403, "Legacy user attempting to set role='editor' must be rejected");
    });

    // -------------------------------------------------------------------------
    // TEST 11: Contact Form Schema, Field Whitelist & Boundary Regressions
    // -------------------------------------------------------------------------
    test("11. Contact Form Schema Boundary: Type errors, field omission, and length limits fail closed", async () => {
        // Name exceeding 100 characters -> BLOCKED (403)
        const overlongName = await createDocAs("contacts", null, {
            userId: "",
            name: "A".repeat(101),
            email: "student@test.com",
            message: "Valid question message",
            status: "new",
            createdAt: new Date()
        }, null);
        assert.equal(overlongName.status, 403, "Name > 100 chars must be rejected");

        // Empty name -> BLOCKED (403)
        const emptyName = await createDocAs("contacts", null, {
            userId: "",
            name: "",
            email: "student@test.com",
            message: "Valid question message",
            status: "new",
            createdAt: new Date()
        }, null);
        assert.equal(emptyName.status, 403, "Empty name must be rejected");

        // Message exceeding 2000 characters -> BLOCKED (403)
        const overlongMsg = await createDocAs("contacts", null, {
            userId: "",
            name: "Valid Name",
            email: "student@test.com",
            message: "M".repeat(2001),
            status: "new",
            createdAt: new Date()
        }, null);
        assert.equal(overlongMsg.status, 403, "Message > 2000 chars must be rejected");

        // Email exceeding 150 characters -> BLOCKED (403)
        const overlongEmail = await createDocAs("contacts", null, {
            userId: "",
            name: "Valid Name",
            email: `${"a".repeat(145)}@test.com`,
            message: "Valid message",
            status: "new",
            createdAt: new Date()
        }, null);
        assert.equal(overlongEmail.status, 403, "Email > 150 chars must be rejected");

        // Non-timestamp createdAt (string instead of timestamp) -> BLOCKED (403)
        const stringCreatedAt = await createDocAs("contacts", null, {
            userId: "",
            name: "Valid Name",
            email: "student@test.com",
            message: "Valid message",
            status: "new",
            createdAt: "2026-10-23T12:00:00Z" // plain string, not timestamp
        }, null);
        assert.equal(stringCreatedAt.status, 403, "String createdAt must be rejected (must be timestamp)");
    });
});
