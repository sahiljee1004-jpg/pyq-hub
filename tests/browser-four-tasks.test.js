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

describe("Browser E2E Verification Suite — 4 Core Tasks", () => {
    let server;
    let baseUrl;
    let browser;
    let adminToken;
    let studentToken;
    let keyPair;

    const ADMIN_UID = "qa_e2e_admin_uid";
    const STUDENT_UID = "qa_e2e_student_uid";
    const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "pyqs-hub-43bed";

    const testPdfPath = path.join(rootDir, "uploads/vault/9b431b935eda8f38_1792762664939_JEE_Main_21_Jan_2026_Shift_1.pdf");
    const testAkPath = path.join(rootDir, "uploads/vault/16015408f945e440_1792762664940_JEE_Main_21_Jan_2026_Shift1_Answer_Key.pdf");
    const testEpPath = path.join(rootDir, "uploads/vault/696187fbd892cb0f_1792762666510_JEE_Main_2026_Exam_Format.pdf");

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
        process.env.ADMIN_SECRET_KEY = "browser_test_secret_e2e_9912";

        fs.mkdirSync(path.dirname(testPdfPath), { recursive: true });
        const minimalPdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000108 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n185\n%%EOF";
        if (!fs.existsSync(testPdfPath)) fs.writeFileSync(testPdfPath, minimalPdf);
        if (!fs.existsSync(testAkPath)) fs.writeFileSync(testAkPath, minimalPdf);
        if (!fs.existsSync(testEpPath)) fs.writeFileSync(testEpPath, minimalPdf);

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
        studentToken = createToken(STUDENT_UID, "student@vidyarthiastra.in", "user");

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
            email: "student@vidyarthiastra.in",
            name: "QA Student",
            role: "user",
            createdAt: new Date().toISOString()
        });

        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        browser = await chromium.launch({
            executablePath: CHROME_PATH,
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
    });

    after(async () => {
        if (browser) await browser.close();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

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

    // -------------------------------------------------------------
    // TASK 1: Writable Target Exam Field
    // -------------------------------------------------------------
    test("Task 1 Browser UI: Writable Target Exam input replaces select dropdown, validates length & whitespace, retains custom names", async () => {
        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        // Switch to Upload tab
        await page.click('button[data-tab="upload"]');
        await page.waitForSelector("#tab-upload", { state: "visible" });

        // Verify select dropdown is gone and text input is present
        const selectCount = await page.locator("#examSelect").count();
        assert.equal(selectCount, 0, "<select id='examSelect'> must be completely replaced");

        const examInput = page.locator("#examInput");
        assert.equal(await examInput.count(), 1, "<input id='examInput'> must exist");
        assert.equal(await examInput.getAttribute("type"), "text");
        assert.equal(await examInput.getAttribute("maxlength"), "150");
        assert.equal(await examInput.getAttribute("placeholder"), "Enter exam name (e.g., NEET UG, JEE Main, GATE)");

        // Verify Primary Language field is absent from admin upload form
        const langSelectCount = await page.locator("#languageSelect").count();
        assert.equal(langSelectCount, 0, "#languageSelect must be removed from admin upload form");

        // Verify inline validation for whitespace/empty on blur
        await examInput.fill("   ");
        await examInput.blur();
        const errorEl = page.locator("#examInputError");
        assert.equal(await errorEl.isVisible(), true, "Error message must be visible for whitespace-only input");
        assert.ok((await errorEl.textContent()).includes("required"), "Error must state exam name is required");

        // Verify inline validation for overlong (>150) input
        const overlongStr = "A".repeat(160);
        await examInput.evaluate((el, val) => {
            el.maxLength = 200; // temporarily expand attribute to test JS validation handler
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }, overlongStr);
        assert.equal(await errorEl.isVisible(), true, "Error message must show for overlong input");
        assert.ok((await errorEl.textContent()).includes("150"), "Error must cite 150 characters limit");

        // Verify custom exam input clears error
        await examInput.evaluate(el => el.maxLength = 150);
        await examInput.fill("CLAT Entrance Examination 2024");
        assert.equal(await errorEl.isVisible(), false, "Error message must be hidden for valid exam name");
        assert.equal(await examInput.inputValue(), "CLAT Entrance Examination 2024");

        await context.close();
    });

    // -------------------------------------------------------------
    // TASK 3: Independent PDF Removal Controls
    // -------------------------------------------------------------
    test("Task 3 Browser UI: Independent remove controls on all 3 PDF cards clear files, reset file input, preserve form fields", async () => {
        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        await page.click('button[data-tab="upload"]');
        await page.waitForSelector("#tab-upload", { state: "visible" });

        // Fill custom exam name first
        await page.locator("#examInput").fill("NEET UG 2024 Re-Test");

        // Initially remove buttons must not be visible
        assert.equal(await page.locator("#qpRemoveBtn").isVisible(), false);
        assert.equal(await page.locator("#akRemoveBtn").isVisible(), false);
        assert.equal(await page.locator("#epRemoveBtn").isVisible(), false);

        // 1. Select Question Paper PDF via #fileInputQp
        await page.locator("#fileInputQp").setInputFiles(testPdfPath);
        await page.waitForSelector("#dropzoneQp.has-file", { state: "visible" });

        const qpRemoveBtn = page.locator("#qpRemoveBtn");
        assert.equal(await qpRemoveBtn.isVisible(), true, "QP Remove button must appear when file is attached");
        assert.equal(await qpRemoveBtn.getAttribute("aria-label"), "Remove question paper");

        // 2. Click Remove Question Paper
        await qpRemoveBtn.click();
        await page.waitForSelector("#dropzoneQp:not(.has-file)", { state: "visible" });
        assert.equal(await qpRemoveBtn.isVisible(), false, "QP Remove button must hide after removal");

        // Form fields must be preserved
        assert.equal(await page.locator("#examInput").inputValue(), "NEET UG 2024 Re-Test", "Exam name must be preserved");

        // Native file input value must be reset so same file can be re-selected
        const qpInputValue = await page.locator("#fileInputQp").inputValue();
        assert.equal(qpInputValue, "", "Native file input must be reset to empty");

        // 3. Re-select the same file
        await page.locator("#fileInputQp").setInputFiles(testPdfPath);
        await page.waitForSelector("#dropzoneQp.has-file", { state: "visible" });
        assert.equal(await qpRemoveBtn.isVisible(), true, "Re-selected file must show remove button again");

        // 4. Attach all 3 files
        await page.locator("#fileInputAk").setInputFiles(testAkPath);
        await page.waitForSelector("#dropzoneAk.has-file", { state: "visible" });
        await page.locator("#fileInputEp").setInputFiles(testEpPath);
        await page.waitForSelector("#dropzoneEp.has-file", { state: "visible" });

        assert.equal(await page.locator("#qpRemoveBtn").isVisible(), true);
        assert.equal(await page.locator("#akRemoveBtn").isVisible(), true);
        assert.equal(await page.locator("#epRemoveBtn").isVisible(), true);

        // 5. Remove only Answer Key
        await page.locator("#akRemoveBtn").click();
        await page.waitForSelector("#dropzoneAk:not(.has-file)", { state: "visible" });
        assert.equal(await page.locator("#akRemoveBtn").isVisible(), false);

        // QP and Pattern Document must remain intact
        assert.equal(await page.locator("#dropzoneQp").evaluate(el => el.classList.contains("has-file")), true, "QP must remain attached");
        assert.equal(await page.locator("#dropzoneEp").evaluate(el => el.classList.contains("has-file")), true, "Pattern doc must remain attached");
        assert.equal(await page.locator("#qpRemoveBtn").isVisible(), true);
        assert.equal(await page.locator("#epRemoveBtn").isVisible(), true);

        await context.close();
    });

    // -------------------------------------------------------------
    // TASK 4: Controlled Publication Override
    // -------------------------------------------------------------
    test("Task 4 Browser UI: Publication blocked on discrepancy, override modal requires checkbox acknowledgement, >=10 char reason, exact confirmation phrase", async () => {
        // Seed an import job with eligible warning (formula notation fidelity flag)
        const runId = "e2e_override_" + Date.now();
        const job = ImportJobPipelineService.createJob({
            examId: "synthetic-qa-bitsat",
            examName: "BITSAT 2024",
            year: 2024,
            paperCode: "S1",
            actor: "admin@vidyarthiastra.in",
            isSyntheticTest: true,
            testRunId: runId
        });
        const jobId = job.jobId;

        const testQuestions = [
            {
                questionId: `${job.examId}-2024-S1-001`,
                questionNumber: 1,
                questionText: "Which of the following functions satisfies f(x+y) = f(x)f(y)?",
                questionType: "mcq",
                subject: "Mathematics",
                sectionId: "sec_math",
                topic: "Functions",
                hasDiagram: false,
                validationStatus: "flagged",
                flagReason: "Formula Fidelity: Review exponential notation.",
                sourcePage: 1,
                options: [
                    { id: "opt_1", label: "A", text: "f(x) = e^(kx)" },
                    { id: "opt_2", label: "B", text: "f(x) = kx" },
                    { id: "opt_3", label: "C", text: "f(x) = x^k" },
                    { id: "opt_4", label: "D", text: "f(x) = ln(x)" }
                ]
            }
        ];

        const testAnswerKeys = [
            {
                questionId: `${job.examId}-2024-S1-001`,
                questionNumber: 1,
                answerType: "single_choice",
                acceptedAnswers: [],
                correctOptionIds: ["opt_1"],
                correctAnswers: ["A"],
                isDropped: false,
                verificationStatus: "verified",
                marksAwarded: 3,
                marksDeducted: 1,
                scoringRuleId: "standard"
            }
        ];

        const testExamConfig = {
            configId: "bitsat-pattern",
            examId: job.examId,
            examName: "BITSAT 2024",
            totalQuestions: 1,
            maximumMarks: 3,
            durationSeconds: 1800,
            sections: [
                { id: "sec_math", subject: "Mathematics", questionType: "mcq", startQuestion: 1, endQuestion: 1, marksPerCorrect: 3, negativeMarks: 1 }
            ]
        };

        job.sourceDocuments = {
            questionPaper: { hash: "qp_h", originalFilename: "BITSAT_QP.pdf", localVaultPath: testPdfPath },
            answerKey: { hash: "ak_h", originalFilename: "BITSAT_AK.pdf", localVaultPath: testAkPath },
            examPattern: { hash: "ep_h", originalFilename: "BITSAT_EP.pdf", localVaultPath: testEpPath }
        };

        job.status = "needs_review";
        job.flaggedQuestionCount = 1;
        job.extractedQuestionCount = 1;
        job.verifiedAnswerCount = 1;
        job.draftPackage = {
            testId: `mock-${runId}-${job.examId}-2024-s1`,
            configId: testExamConfig.configId,
            examConfig: testExamConfig,
            questions: testQuestions,
            answerKeys: testAnswerKeys
        };

        const fp = ImportJobPipelineService.computeValidationFingerprint({
            questions: testQuestions,
            answerKeys: testAnswerKeys,
            examConfig: testExamConfig
        });
        job.contentFingerprint = fp;
        job.validationReport = {
            canPublish: false,
            blockers: ["Content Fidelity Gate: 1 question(s) have unresolved fidelity flags (Q: 1)."],
            validatedFingerprint: fp
        };

        await UniversalFirestoreService.setDocument("mockTests", job.draftPackage.testId, {
            testId: job.draftPackage.testId,
            status: "draft",
            totalQuestions: 1
        });
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        // Open seeded job into report tab
        await page.evaluate((id) => window.viewJobProgress(id), jobId);
        await page.waitForSelector("#tab-progress", { state: "visible" });
        await page.click("#viewReportBtn");
        await page.evaluate(() => window.switchTab && window.switchTab("report"));
        await page.waitForSelector("#tab-report", { state: "visible" });

        // 1. Standard publication gate blocked
        const gateBadgeText = await page.textContent("#publishGateBadge");
        assert.equal(gateBadgeText.trim(), "PUBLICATION BLOCKED", "Gate badge must indicate PUBLICATION BLOCKED");

        const isStandardDisabled = await page.isDisabled("#reportProceedPublishBtn");
        assert.equal(isStandardDisabled, true, "Proceed to Publish button must be disabled");

        // 2. Override publication button is visible
        const overrideBtn = page.locator("#reportOverridePublishBtn");
        assert.equal(await overrideBtn.isVisible(), true, "Publish Ignoring Discrepancy button must be visible");

        // 3. Click override button -> modal opens
        await overrideBtn.click();
        await page.waitForSelector("#overridePublishModal.show", { state: "visible" });

        // Verify summary
        const eligibleCount = await page.textContent("#overrideEligibleCount");
        assert.equal(Number(eligibleCount), 1, "Must list 1 eligible warning");

        const executeBtn = page.locator("#executeOverridePublishBtn");
        assert.equal(await executeBtn.isDisabled(), true, "Execute override button must be disabled initially");

        // 4. Check eligible warning checkbox
        await page.locator(".override-checkbox").check();
        assert.equal(await executeBtn.isDisabled(), true, "Button must remain disabled without reason & confirmation");

        // 5. Fill too-short reason (<10 chars)
        await page.locator("#overrideReasonInput").fill("Verified");
        assert.equal(await executeBtn.isDisabled(), true, "Button must remain disabled with reason < 10 chars");

        // 6. Fill valid reason (>=10 chars)
        await page.locator("#overrideReasonInput").fill("Verified formula notation against official question booklet page 4.");
        assert.equal(await executeBtn.isDisabled(), true, "Button must remain disabled without confirmation text");

        // 7. Fill wrong confirmation phrase
        await page.locator("#overrideConfirmationInput").fill("PUBLISH");
        assert.equal(await executeBtn.isDisabled(), true, "Button must remain disabled with wrong confirmation phrase");

        // 8. Fill exact required confirmation phrase
        await page.locator("#overrideConfirmationInput").fill("PUBLISH WITH DISCREPANCIES");
        assert.equal(await executeBtn.isDisabled(), false, "Button must become enabled when all criteria are satisfied");

        // 9. Execute override publication
        page.on("dialog", async (dialog) => {
            await dialog.accept();
        });
        await executeBtn.click();

        // Modal should close
        await page.waitForSelector("#overridePublishModal.show", { state: "detached", timeout: 10000 });

        // 10. Verify server state
        const updatedJob = await ImportJobPipelineService.getJob(jobId);
        assert.equal(updatedJob.status, "published", "Job status must transition to 'published'");
        assert.equal(updatedJob.publishedWithDiscrepancies, true, "publishedWithDiscrepancies must be true");
        assert.equal(updatedJob.publicationMode, "override", "publicationMode must be 'override'");

        const mockTestDoc = await UniversalFirestoreService.getDocument("mockTests", job.draftPackage.testId);
        assert.equal(mockTestDoc.status, "published");
        assert.equal(mockTestDoc.publishedWithDiscrepancies, true);

        // Verify audit log entry
        assert.ok(updatedJob.auditLog.some(a => a.action === "TEST_PUBLISHED_OVERRIDE"), "Audit log must contain TEST_PUBLISHED_OVERRIDE");

        await context.close();
    });

    // -------------------------------------------------------------
    // TASK 4 GUARD: Fatal Blockers Cannot Be Overridden
    // -------------------------------------------------------------
    test("Task 4 Browser UI: Fatal blockers (unverified answer key) cannot be overridden, execute button remains disabled", async () => {
        const runId = "e2e_fatal_" + Date.now();
        const job = ImportJobPipelineService.createJob({
            examId: "synthetic-fatal-exam",
            examName: "FATAL EXAM 2024",
            year: 2024,
            paperCode: "F1",
            actor: "admin@vidyarthiastra.in",
            isSyntheticTest: true,
            testRunId: runId
        });
        const jobId = job.jobId;

        // Fatal: Unverified answer key
        const testQuestions = [
            {
                questionId: `${job.examId}-2024-F1-001`,
                questionNumber: 1,
                questionText: "What is the speed of light in vacuum?",
                questionType: "mcq",
                subject: "Physics",
                sectionId: "sec_a",
                hasDiagram: false,
                validationStatus: "valid",
                options: [
                    { id: "opt_1", label: "A", text: "3 x 10^8 m/s" }
                ]
            }
        ];
        const testAnswerKeys = [
            {
                questionId: `${job.examId}-2024-F1-001`,
                questionNumber: 1,
                answerType: "single_choice",
                correctOptionIds: ["opt_1"],
                correctAnswers: ["A"],
                verificationStatus: "unverified", // FATAL BLOCKER!
                marksAwarded: 4,
                marksDeducted: 1
            }
        ];

        job.sourceDocuments = {
            questionPaper: { hash: "qp_h", originalFilename: "FATAL_QP.pdf", localVaultPath: testPdfPath },
            answerKey: { hash: "ak_h", originalFilename: "FATAL_AK.pdf", localVaultPath: testAkPath },
            examPattern: { hash: "ep_h", originalFilename: "FATAL_EP.pdf", localVaultPath: testEpPath }
        };

        job.status = "needs_review";
        job.draftPackage = {
            testId: `mock-${runId}-${job.examId}-2024-f1`,
            examConfig: {
                configId: "fatal-cfg",
                examId: job.examId,
                totalQuestions: 1,
                maximumMarks: 4,
                durationSeconds: 1800,
                sections: [{ id: "sec_a", subject: "Physics", questionType: "mcq", marksPerCorrect: 4, negativeMarks: 1 }]
            },
            questions: testQuestions,
            answerKeys: testAnswerKeys
        };

        job.validationReport = {
            canPublish: false,
            blockers: ["Answer Key Integrity: 1 question(s) have unverified answer keys."],
            validatedFingerprint: "dummy_fp"
        };

        await UniversalFirestoreService.setDocument("mockTests", job.draftPackage.testId, {
            testId: job.draftPackage.testId,
            status: "draft",
            totalQuestions: 1
        });
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        const context = await createAdminContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/admin.html`);
        await page.waitForSelector("#adminDashboardView", { state: "visible" });

        await page.evaluate((id) => window.viewJobProgress(id), jobId);
        await page.waitForSelector("#tab-progress", { state: "visible" });
        await page.click("#viewReportBtn");
        await page.evaluate(() => window.switchTab && window.switchTab("report"));
        await page.waitForSelector("#tab-report", { state: "visible" });

        await page.click("#reportOverridePublishBtn");
        await page.waitForSelector("#overridePublishModal.show", { state: "visible" });

        // Fatal blockers container must be visible
        const fatalContainer = page.locator("#overrideFatalContainer");
        assert.equal(await fatalContainer.isVisible(), true, "Fatal blockers container must be displayed");
        const fatalText = await fatalContainer.textContent();
        assert.ok(fatalText.toLowerCase().includes("unverified"), "Must report unverified answer key as fatal blocker");

        // Even with reason & confirmation filled, execute button must be disabled
        await page.locator("#overrideReasonInput").fill("Attempting to override unverified key");
        await page.locator("#overrideConfirmationInput").fill("PUBLISH WITH DISCREPANCIES");

        const executeBtn = page.locator("#executeOverridePublishBtn");
        assert.equal(await executeBtn.isDisabled(), true, "Execute button MUST be disabled when fatal blockers exist");

        await context.close();
    });

    // -------------------------------------------------------------
    // TASK 2: Student Mock Test Language Selection & Attempt
    // -------------------------------------------------------------
    test("Task 2 Browser UI: Pre-test language modal lists available languages, persists selected language, renders translations, falls back transparently without answer key leakage", async () => {
        // Seed published multi-language mock test
        const testId = "mock_test_lang_e2e_" + Date.now();
        const multiLangQuestions = [
            {
                questionId: `${testId}-001`,
                questionNumber: 1,
                questionText: "What is the SI unit of electric current?",
                questionType: "mcq",
                subject: "Physics",
                sectionId: "sec_a",
                options: [
                    { id: "opt_1", label: "A", text: "Ampere" },
                    { id: "opt_2", label: "B", text: "Volt" },
                    { id: "opt_3", label: "C", text: "Ohm" },
                    { id: "opt_4", label: "D", text: "Watt" }
                ],
                translations: {
                    Hindi: {
                        questionText: "विद्युत धारा का SI मात्रक क्या है?",
                        options: [
                            { id: "opt_1", text: "एम्पीयर" },
                            { id: "opt_2", text: "वोल्ट" },
                            { id: "opt_3", text: "ओम" },
                            { id: "opt_4", text: "वाट" }
                        ]
                    }
                }
            },
            {
                // Question 2: No Hindi translation (tests fallback disclosure notice)
                questionId: `${testId}-002`,
                questionNumber: 2,
                questionText: "A capacitor of capacitance 2 µF is charged to 100 V. Calculate stored energy.",
                questionType: "mcq",
                subject: "Physics",
                sectionId: "sec_a",
                options: [
                    { id: "opt_1", label: "A", text: "0.01 J" },
                    { id: "opt_2", label: "B", text: "0.02 J" },
                    { id: "opt_3", label: "C", text: "0.05 J" },
                    { id: "opt_4", label: "D", text: "0.10 J" }
                ]
            }
        ];

        const answerKeys = [
            {
                questionId: `${testId}-001`,
                questionNumber: 1,
                answerType: "single_choice",
                correctOptionIds: ["opt_1"],
                correctAnswers: ["A"],
                marksAwarded: 4,
                marksDeducted: 1
            },
            {
                questionId: `${testId}-002`,
                questionNumber: 2,
                answerType: "single_choice",
                correctOptionIds: ["opt_1"],
                correctAnswers: ["A"],
                marksAwarded: 4,
                marksDeducted: 1
            }
        ];

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "physics-olympiad",
            examName: "National Physics Olympiad",
            year: 2024,
            title: "National Physics Olympiad 2024",
            status: "published",
            availableLanguages: ["English", "Hindi"],
            totalQuestions: 2,
            maximumMarks: 8,
            durationSeconds: 1800,
            questionIds: multiLangQuestions.map(q => q.questionId),
            sections: [
                { id: "sec_a", subject: "Physics", questionType: "mcq", marksPerCorrect: 4, negativeMarks: 1 }
            ]
        });

        for (const q of multiLangQuestions) {
            await UniversalFirestoreService.setDocument("mockQuestions", q.questionId, {
                ...q,
                testId
            });
        }

        for (const ak of answerKeys) {
            await UniversalFirestoreService.setDocument("mockAnswerKeys", ak.questionId, {
                ...ak,
                testId
            });
        }

        const context = await browser.newContext();

        // Intercept Firebase Auth and student session
        await context.route("**/js/firebase.js", async (route) => {
            const fakeUserJs = `
                export const auth = {
                    currentUser: {
                        uid: "${STUDENT_UID}",
                        email: "student@vidyarthiastra.in",
                        getIdToken: async () => "${studentToken}"
                    }
                };
                export const db = {};
                export const googleProvider = {};
                if (typeof window !== "undefined") {
                    window.auth = auth;
                }
            `;
            await route.fulfill({
                status: 200,
                contentType: "application/javascript",
                body: fakeUserJs
            });
        });

        await context.route("https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js", async (route) => {
            const fakeAuthSdk = `
                export function onAuthStateChanged(auth, cb) {
                    if (auth && auth.currentUser) {
                        cb(auth.currentUser);
                    }
                }
                export function getAuth() { return window.auth; }
                export class GoogleAuthProvider {}
                export function createUserWithEmailAndPassword() { return Promise.resolve({ user: window.auth?.currentUser }); }
                export function signInWithEmailAndPassword() { return Promise.resolve({ user: window.auth?.currentUser }); }
                export function sendPasswordResetEmail() { return Promise.resolve(); }
                export function signInWithPopup() { return Promise.resolve({ user: window.auth?.currentUser }); }
            `;
            await route.fulfill({
                status: 200,
                contentType: "application/javascript",
                body: fakeAuthSdk
            });
        });

        await context.route("https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js", async (route) => {
            const fakeFirestoreSdk = `
                export function doc() { return {}; }
                export function getDoc() { return Promise.resolve({ exists: () => false, data: () => ({}) }); }
                export function setDoc() { return Promise.resolve(); }
                export function serverTimestamp() { return new Date(); }
            `;
            await route.fulfill({
                status: 200,
                contentType: "application/javascript",
                body: fakeFirestoreSdk
            });
        });

        const page = await context.newPage();
        await page.goto(`${baseUrl}/mock-test.html`);

        // Wait for catalog grid to load
        await page.waitForSelector("#testGrid", { state: "visible" });

        // Find the test card for National Physics Olympiad using data-testid
        const cardBtn = page.locator(`button[data-testid="${testId}"]`);
        await cardBtn.waitFor({ state: "visible" });

        // Click Start Mock Test -> Opens Language Selection Modal
        await cardBtn.click();
        await page.waitForSelector("#languageModal", { state: "visible" });

        // Verify Language Modal content
        const modalTitle = await page.textContent("#languageModal h3");
        assert.ok(modalTitle.includes("Choose your test language"), "Modal title must be 'Choose your test language'");

        // Verify available languages: English and Hindi
        const langRadios = page.locator('input[name="testLanguageChoice"]');
        assert.equal(await langRadios.count(), 2, "Must show exactly 2 language options");
        assert.equal(await langRadios.nth(0).getAttribute("value"), "English");
        assert.equal(await langRadios.nth(1).getAttribute("value"), "Hindi");

        // Select Hindi
        await langRadios.nth(1).check();

        // Confirm & Start Test
        await page.click("#langModalBtnConfirm");
        await page.waitForSelector("#languageModal", { state: "hidden" });

        // Test session view appears
        await page.waitForSelector("#testView", { state: "visible" });

        // Verify meta bar displays Language: Hindi
        const metaText = await page.textContent("#activeTestMeta");
        assert.ok(metaText.includes("Language: Hindi"), `Meta text must show Hindi attempt language, got: ${metaText}`);

        // Question 1 must be rendered in Hindi!
        const q1Stem = await page.textContent("#qText");
        assert.ok(q1Stem.includes("विद्युत धारा का SI मात्रक क्या है?"), `Q1 stem must be Hindi translation, got: ${q1Stem}`);

        const optLabels = await page.locator(".option-item .option-text").allTextContents();
        assert.ok(optLabels.includes("एम्पीयर"), "Option A must be Hindi translation (एम्पीयर)");
        assert.ok(optLabels.includes("वोल्ट"), "Option B must be Hindi translation (वोल्ट)");

        // CRITICAL SECURITY ASSERTION: Public page and question payload must never expose answer keys
        const pageSource = await page.content();
        assert.ok(!pageSource.includes("correctOptionIds"), "Public DOM must not contain correctOptionIds");
        assert.ok(!pageSource.includes("correctAnswers"), "Public DOM must not contain correctAnswers");

        // Select Hindi Option A (opt_1)
        await page.locator('.option-item input[value="opt_1"]').check();

        // Navigate to Question 2
        await page.click("#btnNext");

        // Question 2 has no Hindi translation: verify English fallback and disclosure notice
        const q2Stem = await page.textContent("#qText");
        assert.ok(q2Stem.includes("A capacitor of capacitance 2 µF"), `Q2 stem must fall back to English, got: ${q2Stem}`);

        const fallbackNotice = page.locator(".translation-fallback-notice");
        assert.equal(await fallbackNotice.isVisible(), true, "Fallback disclosure notice must be visible for Q2");
        const noticeText = await fallbackNotice.textContent();
        assert.ok(noticeText.includes("Translation unavailable"), "Notice must disclose missing Hindi translation");

        // Submit test
        await page.click("#btnTopSubmit");
        await page.waitForSelector("#submitModal", { state: "visible" });
        await page.click("#modalBtnConfirm");

        // Result view
        await page.waitForSelector("#resultView", { state: "visible" });
        const accuracyText = await page.textContent("#resAccuracy");
        assert.ok(accuracyText.length > 0, "Result view accuracy must be displayed");

        await context.close();
    });
});
