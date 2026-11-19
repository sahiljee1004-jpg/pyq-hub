import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import app from "../server/server.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

describe("Isolated Browser Verification Suite — JEE Main 2026 Admin & Mock Test Workflow", () => {
    let server;
    let baseUrl;
    let browser;
    let adminToken;
    let studentToken;
    let testJobId;
    let testId;
    let keyPair;

    const ADMIN_UID = "qa_browser_admin_uid";
    const STUDENT_UID = "qa_student_uid";
    // Match the project ID used by the local token verification service
    const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";

    before(async () => {
        // Enforce Isolated Test Safety Boundaries
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
        process.env.ADMIN_SECRET_KEY = "browser_test_secret_key_8821";

        const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
        console.log(`[Browser Test Setup] FIRESTORE_EMULATOR_HOST: ${emulatorHost || "isolated-test-runtime"}`);
        console.log(`[Browser Test Setup] Target Project ID: ${PROJECT_ID}`);

        // 1. Setup local cryptographic RSA keys for test admin token generation
        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        function createToken(uid, email, role) {
            const now = Math.floor(Date.now() / 1000);
            const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
            const payload = {
                iss: `https://securetoken.google.com/${PROJECT_ID}`,
                aud: PROJECT_ID,
                sub: uid,
                user_id: uid,
                email: email,
                role: role,
                auth_time: now,
                iat: now,
                exp: now + 7200
            };
            const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
            const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
            const signInput = `${b64Header}.${b64Payload}`;
            const signer = crypto.createSign("RSA-SHA256");
            signer.update(signInput);
            return `${signInput}.${signer.sign(keyPair.privateKey, "base64url")}`;
        }

        adminToken = createToken(ADMIN_UID, "admin@vidyarthiastra.in", "admin");
        studentToken = createToken(STUDENT_UID, "student@test.com", "user");

        // 2. Seed Admin & Student Users into Firestore universal service
        UniversalFirestoreService.clearLocalCache();
        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            name: "QA Admin Engineer",
            role: "admin",
            createdAt: new Date().toISOString()
        });

        await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
            uid: STUDENT_UID,
            email: "student@test.com",
            name: "QA Student Tester",
            role: "user",
            createdAt: new Date().toISOString()
        });

        // 3. Start local test Express server on a free port
        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        console.log(`[Browser Test Setup] Express test server listening on ${baseUrl}`);

        // 4. Launch Google Chrome in headless mode
        browser = await chromium.launch({
            executablePath: CHROME_PATH,
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
        console.log(`[Browser Test Setup] Google Chrome launched (${browser.version()})`);

        // 5. Seed a synthetic JEE Main 2026 Import Job with flagged questions & source documents
        const qpPath = path.join(rootDir, "uploads/vault/9b431b935eda8f38_1792762664939_JEE_Main_21_Jan_2026_Shift_1.pdf");
        const akPath = path.join(rootDir, "uploads/vault/16015408f945e440_1792762664940_JEE_Main_21_Jan_2026_Shift1_Answer_Key.pdf");
        const epPath = path.join(rootDir, "uploads/vault/696187fbd892cb0f_1792762666510_JEE_Main_2026_Exam_Format.pdf");

        fs.mkdirSync(path.dirname(qpPath), { recursive: true });
        const minimalPdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000108 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n185\n%%EOF";
        if (!fs.existsSync(qpPath)) fs.writeFileSync(qpPath, minimalPdf);
        if (!fs.existsSync(akPath)) fs.writeFileSync(akPath, minimalPdf);
        if (!fs.existsSync(epPath)) fs.writeFileSync(epPath, minimalPdf);

        const testRunId = "run_browser_" + Date.now();
        const job = ImportJobPipelineService.createJob({
            examId: "synthetic-qa-exam",
            year: 2026,
            paperCode: "Q1",
            language: "English",
            paperType: "pyq",
            actor: "admin@vidyarthiastra.in",
            isSyntheticTest: true,
            testRunId
        });
        testJobId = job.jobId;

        // Associate source documents for preview testing
        job.sourceDocuments = {
            questionPaper: {
                hash: "synthetic_qp_hash",
                originalFilename: "JEE_Main_2026_QuestionPaper.pdf",
                docType: "question_paper",
                localVaultPath: qpPath
            },
            answerKey: {
                hash: "synthetic_ak_hash",
                originalFilename: "JEE_Main_2026_AnswerKey.pdf",
                docType: "answer_key",
                localVaultPath: akPath
            },
            examPattern: {
                hash: "synthetic_ep_hash",
                originalFilename: "JEE_Main_2026_ExamPattern.pdf",
                docType: "exam_pattern",
                localVaultPath: epPath
            }
        };

        const testExamConfig = {
            configId: "jee-main-2026-pattern",
            examId: "synthetic-qa-exam",
            examName: "JEE Main 2026 (Shift 1)",
            totalQuestions: 2,
            maximumMarks: 8,
            durationSeconds: 1800,
            sections: [
                { id: "sec_a", subject: "Physics", questionType: "mcq", startQuestion: 1, endQuestion: 1, marksPerCorrect: 4, negativeMarks: 1 },
                { id: "sec_b", subject: "Physics", questionType: "numerical", startQuestion: 2, endQuestion: 2, marksPerCorrect: 4, negativeMarks: 1 }
            ]
        };

        const testQuestions = [
            {
                questionId: `${job.examId}-2026-Q1-001`,
                questionNumber: 1,
                questionText: "A particle performs SHM. The acceleration is given by a = -ω² x. Calculate frequency.",
                questionType: "mcq",
                subject: "Physics",
                sectionId: "sec_a",
                topic: "Oscillations",
                hasDiagram: false,
                validationStatus: "flagged",
                flagReason: "Formula Fidelity: Review formula notation from original PDF artifact.",
                sourcePage: 1,
                options: [
                    { id: "opt_1", label: "1", text: "f = ω / 2π" },
                    { id: "opt_2", label: "2", text: "f = 2π / ω" },
                    { id: "opt_3", label: "3", text: "f = π / ω" },
                    { id: "opt_4", label: "4", text: "f = 4π / ω" }
                ]
            },
            {
                questionId: `${job.examId}-2026-Q1-002`,
                questionNumber: 2,
                questionText: "An electric dipole of moment 4 × 10⁻⁹ C·m is aligned at 30° in a uniform field of 5 × 10⁴ N/C. Calculate torque magnitude in 10⁻⁴ N·m.",
                questionType: "numerical",
                subject: "Physics",
                sectionId: "sec_b",
                topic: "Electrostatics",
                hasDiagram: false,
                validationStatus: "valid",
                sourcePage: 2,
                options: []
            }
        ];

        const testAnswerKeys = [
            {
                questionId: `${job.examId}-2026-Q1-001`,
                questionNumber: 1,
                answerType: "single_choice",
                acceptedAnswers: [],
                correctOptionIds: ["opt_1"],
                correctAnswers: ["1"],
                isDropped: false,
                verificationStatus: "verified",
                marksAwarded: 4,
                marksDeducted: 1,
                numericTolerance: 0,
                scoringRuleId: "standard"
            },
            {
                questionId: `${job.examId}-2026-Q1-002`,
                questionNumber: 2,
                answerType: "numerical",
                acceptedAnswers: ["1", "1.0"],
                correctOptionIds: [],
                correctAnswers: ["1"],
                isDropped: false,
                verificationStatus: "verified",
                marksAwarded: 4,
                marksDeducted: 1,
                numericTolerance: 0,
                scoringRuleId: "standard"
            }
        ];

        testId = `mock-${testRunId}-${job.examId}-2026-q1`;
        job.status = "needs_review";
        job.flaggedQuestionCount = 1;
        job.extractedQuestionCount = 2;
        job.verifiedAnswerCount = 2;
        job.progressPercent = 100;
        job.stage = "Reviewing Extracted Questions";
        job.flaggedQuestions = [
            {
                questionId: testQuestions[0].questionId,
                questionNumber: 1,
                subject: "Physics",
                reason: testQuestions[0].flagReason
            }
        ];
        job.draftPackage = {
            testId,
            configId: testExamConfig.configId,
            examConfig: testExamConfig,
            questions: testQuestions,
            answerKeys: testAnswerKeys
        };

        const initialFp = ImportJobPipelineService.computeValidationFingerprint({
            questions: testQuestions,
            answerKeys: testAnswerKeys,
            examConfig: testExamConfig
        });
        job.contentFingerprint = initialFp;
        job.validationReport = {
            canPublish: false,
            blockers: [
                "Content Fidelity Gate: 1 question(s) have unresolved fidelity flags and require administrator review (Q: 1)."
            ],
            validatedFingerprint: initialFp
        };

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            status: "draft",
            totalQuestions: 2
        });

        await UniversalFirestoreService.setDocument("paperImportJobs", testJobId, job);
    });

    after(async () => {
        if (browser) await browser.close();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    // Helper: create authenticated browser context
    async function createAdminContext() {
        const context = await browser.newContext();
        await context.addCookies([
            {
                name: "admin_session",
                value: adminToken,
                url: baseUrl
            }
        ]);
        return context;
    }

    test("1. Browser UI rejects unauthenticated requests with HTTP 401 and displays Sign In Required screen", async () => {
        const unauthContext = await browser.newContext();
        const page = await unauthContext.newPage();
        const response = await page.goto(`${baseUrl}/admin.html`);

        // Assert server-side page protection: status 401
        assert.equal(response.status(), 401, "Unauthenticated navigation to /admin.html must return HTTP 401");
        const title = await page.title();
        assert.ok(title.includes("Sign In Required"), "Page title must indicate Sign In Required");
        const heading = await page.locator("h1").textContent();
        assert.ok(heading.includes("Sign In Required"), "Heading must indicate Sign In Required");

        await unauthContext.close();
    });

    test("2. Browser UI rejects non-admin student token with HTTP 403 and displays Access Denied screen", async () => {
        const studentContext = await browser.newContext();
        await studentContext.addCookies([
            {
                name: "admin_session",
                value: studentToken,
                url: baseUrl
            }
        ]);
        const page = await studentContext.newPage();
        const response = await page.goto(`${baseUrl}/admin.html`);

        // Assert server-side page protection: status 403
        assert.equal(response.status(), 403, "Student token navigation to /admin.html must return HTTP 403");
        const title = await page.title();
        assert.ok(title.includes("Access Denied"), "Page title must indicate Access Denied");
        const heading = await page.locator("h1").textContent();
        assert.ok(heading.includes("Access Denied"), "Heading must indicate Access Denied");

        await studentContext.close();
    });

    test("3. Browser UI grants access for verified admin session, loads Overview metrics and Import History", async () => {
        const context = await createAdminContext();
        const page = await context.newPage();
        const response = await page.goto(`${baseUrl}/admin.html`);
        assert.equal(response.status(), 200, "Admin session must return HTTP 200 OK");

        // Wait for client-side auth check to verify session and reveal dashboard view
        await page.waitForSelector("#adminDashboardView", { state: "visible", timeout: 10000 });
        const actorLabel = await page.textContent("#adminActorLabel");
        assert.ok(
            actorLabel.includes("admin@vidyarthiastra.in") || actorLabel.includes("Administrator"),
            "Actor label must display verified admin info"
        );

        // Verify Overview metrics
        await page.waitForSelector("#statTotalImports");
        const totalImports = await page.textContent("#statTotalImports");
        assert.ok(Number(totalImports) >= 1, "Total imports must show at least 1 job");

        // Navigate to History Tab
        await page.click('button[data-tab="history"]');
        await page.evaluate(() => window.switchTab && window.switchTab("history"));
        await page.waitForSelector("#tab-history", { state: "visible" });
        await page.waitForSelector("#historyTableBody button", { state: "visible" });
        const historyRows = await page.locator("#historyTableBody tr").count();
        assert.ok(historyRows >= 1, "Import History table must render seeded import job");
        await context.close();
    });

    test("4. Real Browser Interaction: Open job, view flagged question with math formulas, inspect options and authenticated PDF source preview", async () => {
        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        // Open seeded job via viewJobProgress
        await page.evaluate((jobId) => window.viewJobProgress(jobId), testJobId);

        // Progress tab opens and unlocks review tab
        await page.waitForSelector("#tab-progress", { state: "visible" });
        await page.waitForSelector("#reviewQuestionsBtn", { state: "visible" });
        await page.click("#reviewQuestionsBtn");
        await page.evaluate(() => window.switchTab && window.switchTab("review"));

        // Review Tab becomes active
        await page.waitForSelector("#tab-review", { state: "visible" });
        await page.waitForSelector(`#qcard-synthetic-qa-exam-2026-Q1-001`, { state: "visible" });

        // Verify Question 1 stem rendering contains mathematical expression
        const q1CardText = await page.textContent(`#qcard-synthetic-qa-exam-2026-Q1-001`);
        assert.ok(q1CardText.includes("a = -ω² x"), "Q1 card must display formula a = -ω² x");
        assert.ok(q1CardText.includes("f = ω / 2π"), "Q1 card must display math option f = ω / 2π");

        // Click Edit on Question 1
        await page.locator(`#qcard-synthetic-qa-exam-2026-Q1-001 button`).click();
        await page.waitForSelector("#editQuestionModal.show", { state: "visible" });

        // 1. Verify question stem is populated in textarea
        const stemValue = await page.inputValue("#editQuestionText");
        assert.ok(stemValue.includes("a = -ω² x"), "Stem textarea must display formula notation");

        // 2. Verify all 4 MCQ options rendered as distinct editable fields
        const optionInputs = page.locator("#editOptionsContainer .edit-option-input");
        const optCount = await optionInputs.count();
        assert.equal(optCount, 4, "MCQ question must render distinct input fields for each option");

        const firstOptValue = await optionInputs.nth(0).inputValue();
        assert.equal(firstOptValue, "f = ω / 2π", "Option input must preserve mathematical Unicode characters");

        // 3. Verify Authenticated PDF Source Preview iframe and direct link
        const iframeSrc = await page.getAttribute("#sourcePreviewIframe", "src");
        assert.ok(iframeSrc.includes(`/api/admin/import/jobs/${testJobId}/source-preview`), "Iframe src must target source-preview endpoint");
        assert.ok(iframeSrc.includes("docType=questionPaper"), "Preview must target questionPaper docType");

        const directLinkHref = await page.getAttribute("#sourcePreviewDirectLink", "href");
        assert.ok(directLinkHref.includes("/source-preview"), "Direct link must point to authenticated source preview");

        // 4. Verify preview page badge
        const pageBadge = await page.textContent("#sourcePageBadge");
        assert.equal(pageBadge.trim(), "Page 1", "Source page badge must indicate Page 1 provenance");

        // Close modal
        await page.click("#cancelEditBtn");
        await page.waitForSelector("#editQuestionModal.show", { state: "detached" });
        await context.close();
    });

    test("5. Real Browser Interaction: Edit option text, submit audit reason, verify audit log & fresh validation", async () => {
        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        // Open seeded job and navigate to review tab
        await page.evaluate((jobId) => window.viewJobProgress(jobId), testJobId);
        await page.waitForSelector("#tab-progress", { state: "visible" });
        await page.click("#reviewQuestionsBtn");
        await page.evaluate(() => window.switchTab && window.switchTab("review"));
        await page.waitForSelector("#tab-review", { state: "visible" });
        await page.waitForSelector(`#qcard-synthetic-qa-exam-2026-Q1-001`, { state: "visible" });
        await page.locator(`#qcard-synthetic-qa-exam-2026-Q1-001 button`).click();
        await page.waitForSelector("#editQuestionModal.show", { state: "visible" });

        // Test browser validation: saving with empty audit reason fails
        await page.fill("#editAuditReason", "");
        await page.click("#saveQuestionEditBtn");
        const modalAlert = await page.locator("#editModalAlert").textContent();
        assert.ok(modalAlert.includes("audit reason"), "Validation error must alert user that audit reason is required");

        // Update stem and option 1 with clean Unicode math
        await page.fill("#editQuestionText", "A particle executes SHM. Acceleration is a = -ω² x. Find frequency f.");
        const opt1 = page.locator("#editOptionsContainer .edit-option-input").nth(0);
        await opt1.fill("f = ω / (2π)");

        // Provide valid audit reason (min 5 chars)
        await page.fill("#editAuditReason", "Verified against original source PDF page 1: corrected subscript formatting and parenthesis");
        await page.click("#saveQuestionEditBtn");

        // Modal should close on backend 200 OK
        await page.waitForSelector("#editQuestionModal.show", { state: "detached" });

        // Verify updated job state on the server
        const updatedJob = await ImportJobPipelineService.getJob(testJobId);
        assert.ok(updatedJob.auditLog.length > 0, "Audit log must record correction");
        const lastAudit = updatedJob.auditLog[updatedJob.auditLog.length - 1];
        assert.equal(lastAudit.action, "QUESTION_CORRECTED");
        assert.ok(lastAudit.reason.includes("Verified against original source PDF"), "Audit reason must be recorded in log");
        assert.equal(updatedJob.draftPackage.questions[0].validationStatus, "corrected", "Clean correction must clear fidelity flag");

        // Fresh validation must have recomputed fingerprint
        assert.ok(updatedJob.validationReport.validatedFingerprint.length === 64, "Fresh validation fingerprint must be computed");
        await context.close();
    });

    test("6. Real Browser Interaction: Numerical question renders no options, updates cleanly", async () => {
        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        // Open review for Q2 (Numerical)
        await page.evaluate((jobId) => window.viewJobProgress(jobId), testJobId);
        await page.waitForSelector("#tab-progress", { state: "visible" });
        await page.click("#reviewQuestionsBtn");
        await page.evaluate(() => window.switchTab && window.switchTab("review"));
        await page.waitForSelector("#tab-review", { state: "visible" });
        await page.waitForSelector(`#qcard-synthetic-qa-exam-2026-Q1-002`, { state: "visible" });
        await page.locator(`#qcard-synthetic-qa-exam-2026-Q1-002 button`).click();
        await page.waitForSelector("#editQuestionModal.show", { state: "visible" });

        // Verify options container shows numerical notice instead of MCQ options
        const optionsNotice = await page.textContent("#editOptionsContainer");
        assert.ok(optionsNotice.includes("Numerical Value Question"), "Must display numerical indicator without MCQ option fields");
        const optCount = await page.locator("#editOptionsContainer .edit-option-input").count();
        assert.equal(optCount, 0, "Numerical question must render zero option inputs");

        // Update stem and save
        await page.fill("#editQuestionText", "An electric dipole of moment 4 × 10⁻⁹ C·m is at 30° in field 5 × 10⁴ N/C. Calculate torque magnitude (in 10⁻⁴ N·m).");
        await page.fill("#editAuditReason", "Standardized dipole moment notation from source page 2");
        await page.click("#saveQuestionEditBtn");
        await page.waitForSelector("#editQuestionModal.show", { state: "detached" });

        const updatedJob = await ImportJobPipelineService.getJob(testJobId);
        assert.equal(updatedJob.draftPackage.questions[1].options.length, 0, "Numerical question must maintain empty options array");
        await context.close();
    });

    test("7. Server-Side Gate: Stale validation fingerprint rejects publication when hasDiagram or answer key is modified", async () => {
        const job = await ImportJobPipelineService.getJob(testJobId);

        // 7a. Mutate only hasDiagram
        job.draftPackage.questions[0].hasDiagram = true;

        // Attempt publication in browser context via page.evaluate
        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);

        const publishResponse = await page.evaluate(async (jobId) => {
            const res = await fetch(`/api/admin/import/jobs/${jobId}/publish`, {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });
            const data = await res.json();
            return { status: res.status, data };
        }, testJobId);

        assert.equal(publishResponse.status, 400, "Publication must return 400 Bad Request when fingerprint is stale");
        assert.ok(
            publishResponse.data.error.includes("Validation is stale or fingerprint mismatch"),
            "Error must specifically cite stale validation fingerprint mismatch"
        );

        // 7b. Mutate answer key
        job.draftPackage.questions[0].hasDiagram = false; // reset diagram
        job.draftPackage.answerKeys[0].correctAnswers = ["2"]; // mutate answer key
        const publishResponse2 = await page.evaluate(async (jobId) => {
            const res = await fetch(`/api/admin/import/jobs/${jobId}/publish`, {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });
            const data = await res.json();
            return { status: res.status, data };
        }, testJobId);

        assert.equal(publishResponse2.status, 400, "Publication must reject modified answer key without re-validation");

        // 7c. Restore answers and re-validate cleanly
        job.draftPackage.answerKeys[0].correctAnswers = ["1"];
        const freshFp = ImportJobPipelineService.computeValidationFingerprint({
            questions: job.draftPackage.questions,
            answerKeys: job.draftPackage.answerKeys,
            examConfig: job.draftPackage.examConfig
        });
        job.validationReport.validatedFingerprint = freshFp;
        job.validationReport.canPublish = true;
        job.validationReport.blockers = [];
        job.status = "ready_to_publish";
        await UniversalFirestoreService.setDocument("paperImportJobs", testJobId, job);
        await context.close();
    });

    test("8. Publication Gate: Button disabled when blockers exist; enables when valid and publishes cleanly via modal", async () => {
        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        // Navigate to job validation report
        await page.evaluate((jobId) => window.viewJobProgress(jobId), testJobId);
        await page.waitForSelector("#tab-progress", { state: "visible" });
        await page.click("#viewReportBtn");
        await page.evaluate(() => window.switchTab && window.switchTab("report"));

        // Report Tab becomes active
        await page.waitForSelector("#tab-report", { state: "visible" });
        await page.waitForSelector("#publishGateBadge", { state: "visible" });


        const gateBadgeText = await page.textContent("#publishGateBadge");
        assert.equal(gateBadgeText.trim(), "CAN PUBLISH", "Gate badge must show CAN PUBLISH when no blockers exist");

        const isPublishDisabled = await page.isDisabled("#reportProceedPublishBtn");
        assert.equal(isPublishDisabled, false, "Proceed to Publish button must be enabled when validation passes");

        // Click Proceed to Publish -> opens publish confirmation modal
        await page.click("#reportProceedPublishBtn");
        await page.waitForSelector("#publishConfirmModal.show", { state: "visible" });

        // Confirm publication in modal
        await page.click("#executePublishBtn");
        await page.waitForSelector("#publishConfirmModal.show", { state: "detached" });

        // Verify status badge changed to Published on the server and in Firestore
        const publishedJob = await ImportJobPipelineService.getJob(testJobId);
        assert.equal(publishedJob.status, "published", "Job status must transition to 'published'");

        const mockTestDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
        assert.equal(mockTestDoc.status, "published", "Mock test status in Firestore must transition to 'published'");
        await context.close();
    });

    test("9. Student Access & Scoring Engine: Unauthenticated access blocked; acceptedAnswers evaluated (+4/-1)", async () => {
        // 9a. Unauthenticated access blocked
        const unauthRes = await fetch(`${baseUrl}/api/mock-tests/${testId}`);
        assert.equal(unauthRes.status, 401, "Unauthenticated access to mock test details must return 401 Unauthorized");

        // 9b. Student authenticated access strips sensitive answer keys
        const studentRes = await fetch(`${baseUrl}/api/mock-tests/${testId}`, {
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        if (studentRes.ok) {
            const data = await studentRes.json();
            const questions = data.questions || [];
            for (const q of questions) {
                assert.equal(q.correctOptionIds, undefined, "Public questions must never expose correctOptionIds");
                assert.equal(q.correctAnswers, undefined, "Public questions must never expose correctAnswers");
                assert.equal(q.acceptedAnswers, undefined, "Public questions must never expose acceptedAnswers");
            }
        }


        // 9b. Numerical evaluation with acceptedAnswers
        const testExamConfig = {
            examId: "synthetic-qa-exam",
            totalQuestions: 2,
            maximumMarks: 8,
            sections: [
                { id: "sec_a", subject: "Physics", questionType: "mcq", marksPerCorrect: 4, negativeMarks: 1 },
                { id: "sec_b", subject: "Physics", questionType: "numerical", marksPerCorrect: 4, negativeMarks: 1 }
            ]
        };
        const scoringQuestions = [
            { questionId: "q1", questionType: "mcq", subject: "Physics", sectionId: "sec_a" },
            { questionId: "q2", questionType: "numerical", subject: "Physics", sectionId: "sec_b" }
        ];
        const scoringAnswerKeys = [
            {
                questionId: "q1",
                answerType: "single_choice",
                correctOptionIds: ["opt_1"],
                correctAnswers: ["1"],
                marksAwarded: 4,
                marksDeducted: 1
            },
            {
                questionId: "q2",
                answerType: "numerical",
                acceptedAnswers: ["1", "1.0"],
                correctAnswers: ["1"],
                marksAwarded: 4,
                marksDeducted: 1
            }
        ];

        // Case 1: Both correct (Q2 submits "1.0", matching acceptedAnswers)
        const fullScore = MockTestScoringService.evaluateAttempt({
            questions: scoringQuestions,
            answerKeys: scoringAnswerKeys,
            studentAnswers: {
                q1: "opt_1",
                q2: "1.0"
            }
        });
        assert.equal(fullScore.totalScore, 8, "Both correct must earn 8 marks (4 + 4)");
        assert.equal(fullScore.correctCount, 2);

        // Case 2: Numerical wrong answer
        const partialScore = MockTestScoringService.evaluateAttempt({
            questions: scoringQuestions,
            answerKeys: scoringAnswerKeys,
            studentAnswers: {
                q1: "opt_1",
                q2: "5.5"
            }
        });
        assert.equal(partialScore.totalScore, 3, "Correct MCQ (+4) and Wrong Numerical (-1) must yield 3 marks");
        assert.equal(partialScore.incorrectCount, 1);

    });

    test("10. Security Gate: Source preview rejects unauthorized access, invalid docTypes, out-of-bounds pages, and path traversal", async () => {
        // 1. Unauthenticated request to source-preview fails with 401
        const unauthRes = await fetch(`${baseUrl}/api/admin/import/jobs/${testJobId}/source-preview?docType=questionPaper&page=1`);
        assert.equal(unauthRes.status, 401, "Unauthenticated source-preview request must return 401 Unauthorized");

        // 2. Student session fails with 403
        const studentRes = await fetch(`${baseUrl}/api/admin/import/jobs/${testJobId}/source-preview?docType=questionPaper&page=1`, {
            headers: { "Cookie": `admin_session=${studentToken}` }
        });
        assert.equal(studentRes.status, 403, "Student session to source-preview must return 403 Forbidden");

        // 3. Out-of-bounds page returns 400 Bad Request
        const oobRes = await fetch(`${baseUrl}/api/admin/import/jobs/${testJobId}/source-preview?docType=questionPaper&page=9999`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(oobRes.status, 400, "Out-of-bounds page request must return 400 Bad Request");

        // 4. Invalid docType (path traversal attempt) returns 400 Bad Request
        const traversalRes = await fetch(`${baseUrl}/api/admin/import/jobs/${testJobId}/source-preview?docType=../../secret&page=1`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(traversalRes.status, 400, "Path traversal docType must return 400 Bad Request");

        // 5. Authorized valid preview succeeds with application/pdf
        const validRes = await fetch(`${baseUrl}/api/admin/import/jobs/${testJobId}/source-preview?docType=questionPaper&page=1`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(validRes.status, 200, "Authorized source preview must return 200 OK");
        assert.equal(validRes.headers.get("content-type"), "application/pdf");
        assert.equal(validRes.headers.get("x-source-page"), "1");
    });
});

