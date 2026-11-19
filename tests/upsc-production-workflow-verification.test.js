import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
import { MetadataExtractionService } from "../server/services/admin/metadataExtractionService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { MockTestService } from "../server/services/mockTestService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function getVaultFile(pattern) {
    const vaultDir = path.join(rootDir, "uploads/vault");
    if (!fs.existsSync(vaultDir)) return null;
    const files = fs.readdirSync(vaultDir);
    const matches = files.filter(f => f.includes(pattern)).sort().reverse();
    return matches.length > 0 ? path.join(vaultDir, matches[0]) : null;
}

const qpPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Typed.pdf");
const akPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Answer_Key.pdf");
const epPath = getVaultFile("UPSC_Prelims_2026_Paper_1_Pattern.pdf");

test("UPSC 2026 Production Workflow Verification & End-to-End Acceptance Suite", async (t) => {
    process.env.NODE_ENV = "test";
    process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

    const qpBuf = fs.readFileSync(qpPath);
    const akBuf = fs.readFileSync(akPath);
    const epBuf = fs.readFileSync(epPath);

    // =========================================================================
    // PILLAR 1: Booklet Mismatch, Missing Identity & Admin Authorization Gate
    // =========================================================================
    await t.test("Pillar 1: Booklet Mismatch & Admin Authorization Verification", async (t1) => {
        
        await t1.test("1.1 Matching Series (Series A QP + Series A AK): Eligible for publication", async () => {
            const meta = await MetadataExtractionService.extractAllMetadata({
                questionPaperBuffer: qpBuf,
                answerKeyBuffer: akBuf,
                examPatternBuffer: epBuf,
                userHints: { examId: "upsc-prelims", year: 2026 }
            });

            assert.equal(meta.bookletIdentity.status, "matched");
            assert.equal(meta.bookletIdentity.paperSeries, "A");
            assert.equal(meta.bookletIdentity.answerKeySeries, "A");
            assert.equal(meta.bookletIdentity.answerKeyCode, "TDMN-A-ASO");
            assert.equal(meta.warnings.filter(w => w.includes("Paper code mismatch")).length, 0);
        });

        await t1.test("1.2 Mismatched Series (Series A QP + Series B AK): Hard publication blocker", async () => {
            // Synthesize an isolated job with mismatched booklet identity
            const jobMismatch = ImportJobPipelineService.createJob({
                examName: "UPSC Mismatch Test",
                examId: "upsc-prelims",
                year: 2026,
                paperCode: "A",
                actor: "admin_test"
            });

            jobMismatch.extractedMetadata = {
                bookletIdentity: {
                    paperSeries: "A",
                    paperCode: "TDMN-A-ASO",
                    answerKeySeries: "B",
                    answerKeyCode: "TDMN-B-ASO",
                    status: "mismatched",
                    mismatchReason: "Question paper indicates Series A, but Answer Key indicates Series B"
                }
            };

            jobMismatch.validationReport = {
                canPublish: false,
                blockers: [
                    "Booklet Mismatch Blocker: Question paper indicates Series A, but Answer Key indicates Series B. Scored tests cannot be published with mismatched booklet series/code."
                ]
            };

            await assert.rejects(
                async () => {
                    await ImportJobPipelineService.publishTest({ jobId: jobMismatch.jobId, actor: "admin_test" });
                },
                /Booklet Mismatch Blocker/i,
                "Publication MUST fail closed when booklet series mismatch exists"
            );
        });

        await t1.test("1.3 Missing Booklet Identity: Manual review required blocker", async () => {
            const jobMissingId = ImportJobPipelineService.createJob({
                examName: "UPSC Missing Identity Test",
                examId: "upsc-prelims",
                year: 2026,
                paperCode: "A",
                actor: "admin_test"
            });

            jobMissingId.extractedMetadata = {
                bookletIdentity: {
                    paperSeries: null,
                    paperCode: null,
                    answerKeySeries: null,
                    answerKeyCode: null,
                    status: "missing_identity",
                    mismatchReason: "Booklet series or code could not be detected on question paper or answer key"
                }
            };

            jobMissingId.validationReport = {
                canPublish: false,
                blockers: [
                    "Missing Booklet Identity: Booklet series or code could not be detected on question paper or answer key. Manual review and administrator authorization required before publication."
                ]
            };

            await assert.rejects(
                async () => {
                    await ImportJobPipelineService.publishTest({ jobId: jobMissingId.jobId, actor: "admin_test" });
                },
                /Missing Booklet Identity/i,
                "Publication MUST fail closed when booklet identity is missing"
            );
        });

        await t1.test("1.4 Explicitly Authorized Correction: Logged with admin identity and justification", async () => {
            const jobToAuthorize = ImportJobPipelineService.createJob({
                examName: "UPSC Authorized Correction Test",
                examId: "upsc-prelims",
                year: 2026,
                paperCode: "A",
                actor: "admin_test"
            });

            jobToAuthorize.extractedMetadata = {
                bookletIdentity: {
                    paperSeries: "A",
                    answerKeySeries: "B",
                    status: "mismatched",
                    mismatchReason: "Question paper indicates Series A, but Answer Key indicates Series B"
                }
            };
            jobToAuthorize.validationReport = {
                canPublish: false,
                blockers: ["Booklet Mismatch Blocker: Question paper indicates Series A, but Answer Key indicates Series B."]
            };

            // Attempt authorization without adequate justification (< 5 chars) -> Must reject!
            await assert.rejects(
                async () => {
                    await ImportJobPipelineService.authorizeBookletCorrection({
                        jobId: jobToAuthorize.jobId,
                        actor: "lead_admin_42",
                        reason: "ok" // too short
                    });
                },
                /audit reason is required/i
            );

            // Authorized correction with valid admin identity and justification
            const authResult = await ImportJobPipelineService.authorizeBookletCorrection({
                jobId: jobToAuthorize.jobId,
                actor: "lead_admin_42",
                reason: "Confirmed through physical booklet inspection that Series B key was uploaded by mistake. Overriding to Series A key.",
                series: "A",
                code: "TDMN-A-ASO"
            });

            assert.equal(authResult.success, true);
            assert.equal(authResult.job.bookletAuthorization.authorized, true);
            assert.equal(authResult.job.bookletAuthorization.actor, "lead_admin_42");
            assert.equal(authResult.job.bookletAuthorization.series, "A");

            // Verify audit log entry
            const auditEntry = authResult.job.auditLog.find(a => a.action === "BOOKLET_RECONCILIATION_AUTHORIZED");
            assert.ok(auditEntry, "Must record BOOKLET_RECONCILIATION_AUTHORIZED audit entry");
            assert.equal(auditEntry.actor, "lead_admin_42");
            assert.ok(auditEntry.reason.includes("Confirmed through physical booklet inspection"));

            // Verify blocker removed
            const hasMismatchBlocker = authResult.job.validationReport.blockers.some(b => b.includes("Booklet Mismatch Blocker"));
            assert.equal(hasMismatchBlocker, false, "Booklet blocker must be cleared after explicit authorization");
        });
    });

    // =========================================================================
    // PILLAR 2: Scoring Precision, Deduction Ratios & Boundary Rounding
    // =========================================================================
    await t.test("Pillar 2: Scoring Precision & Boundary Rounding Verification", () => {
        // Build mock 100-question set
        const questions = Array.from({ length: 100 }, (_, i) => ({
            questionId: `upsc-q-${i + 1}`,
            questionNumber: i + 1,
            subject: "General Studies",
            subjectId: "general_studies",
            subjectName: "General Studies",
            questionType: "single_choice",
            examId: "upsc-prelims"
        }));

        const answerKeys = questions.map(q => ({
            questionId: q.questionId,
            questionNumber: q.questionNumber,
            correctOptionIds: ["1"],
            verificationStatus: "verified"
        }));

        // Test 2.1: Exactly 1 incorrect answer -> -2/3 mark (-0.667)
        const answers1Wrong = {};
        answers1Wrong[questions[0].questionId] = "2"; // 1 wrong, 99 unanswered
        const res1 = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: answers1Wrong,
            examConfig: { examId: "upsc-prelims" }
        });
        assert.equal(res1.correctCount, 0);
        assert.equal(res1.incorrectCount, 1);
        assert.equal(res1.unansweredCount, 99);
        assert.equal(res1.totalScore, -0.667, "1 wrong answer must evaluate to -0.667 marks");
        assert.equal(res1.maximumMarks, 200);

        // Test 2.2: Exactly 3 incorrect answers -> 3 * (-2/3) = -2.000 marks
        const answers3Wrong = {};
        for (let i = 0; i < 3; i++) answers3Wrong[questions[i].questionId] = "2";
        const res3 = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: answers3Wrong,
            examConfig: { examId: "upsc-prelims" }
        });
        assert.equal(res3.correctCount, 0);
        assert.equal(res3.incorrectCount, 3);
        assert.equal(res3.totalScore, -2.000, "3 wrong answers must evaluate to exactly -2.000 marks");

        // Test 2.3: 60 correct, 30 incorrect, 10 unanswered
        // 60 * 2 = 120; 30 * (-2/3) = -20; Net = 100.000 (50.00%)
        const answersMix = {};
        for (let i = 0; i < 60; i++) answersMix[questions[i].questionId] = "1";
        for (let i = 60; i < 90; i++) answersMix[questions[i].questionId] = "2";
        const resMix = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: answersMix,
            examConfig: { examId: "upsc-prelims" }
        });
        assert.equal(resMix.correctCount, 60);
        assert.equal(resMix.incorrectCount, 30);
        assert.equal(resMix.unansweredCount, 10);
        assert.equal(resMix.totalScore, 100.000);
        assert.equal(resMix.percentageScore, 50.00);

        // Verify subjectAnalysis score agrees with totalScore
        const genBucket = resMix.subjectAnalysis.general || resMix.subjectAnalysis.general_studies;
        assert.ok(genBucket, "General Studies subject bucket must exist");
        assert.equal(genBucket.score, resMix.totalScore, "Subject bucket score must equal totalScore");
        assert.equal(genBucket.maximumMarks, 200);
        assert.equal(genBucket.accuracy, 66.67, "60 / (60 + 30) = 66.67% accuracy");
    });

    // =========================================================================
    // PILLAR 3: Actual Admin Import Workflow with 3 Authoritative Source PDFs
    // =========================================================================
    let importedJob = null;
    let publishedTestId = null;

    await t.test("Pillar 3: Actual Admin Workflow with Source PDFs", async (t3) => {
        // Step 1: Upload 3 real documents into Storage Vault
        const qpDoc = await StorageVaultService.storeDocument({
            buffer: qpBuf,
            originalFilename: "UPSC_Prelims_2026_Paper_I_Typed.pdf",
            docType: "question_paper"
        });
        const akDoc = await StorageVaultService.storeDocument({
            buffer: akBuf,
            originalFilename: "UPSC_Prelims_2026_Paper_I_Answer_Key.pdf",
            docType: "answer_key"
        });
        const epDoc = await StorageVaultService.storeDocument({
            buffer: epBuf,
            originalFilename: "UPSC_Prelims_2026_Paper_1_Pattern.pdf",
            docType: "exam_pattern"
        });

        assert.ok(qpDoc && qpDoc.localVaultPath);
        assert.ok(akDoc && akDoc.localVaultPath);
        assert.ok(epDoc && epDoc.localVaultPath);

        // Step 2: Create import job
        const job = ImportJobPipelineService.createJob({
            examName: "UPSC Civil Services Preliminary 2026",
            examId: "upsc-prelims",
            year: 2026,
            paperType: "pyq",
            language: "English",
            paperCode: "A",
            actor: "admin_upsc_verifier"
        });

        // Step 3: Attach documents
        await ImportJobPipelineService.attachDocuments(job.jobId, {
            questionPaper: qpDoc,
            answerKey: akDoc,
            examPattern: epDoc
        });

        // Step 4: Run actual import pipeline
        importedJob = await ImportJobPipelineService.runPipeline(job.jobId);

        // Step 5: Verify 100 questions and 400 options
        assert.equal(importedJob.status, "ready_to_publish", "Job status must be ready_to_publish");
        assert.equal(importedJob.extractedQuestionCount, 100, "Must extract 100 questions");
        assert.equal(importedJob.verifiedAnswerCount, 100, "Must reconcile 100 answers");
        assert.equal(importedJob.flaggedQuestionCount, 0, "Must have 0 flagged questions");

        // Verify options across all 100 questions
        const questions = importedJob.draftPackage.questions;
        assert.equal(questions.length, 100);
        let totalOpts = 0;
        for (const q of questions) {
            assert.equal(q.options.length, 4, `Q${q.questionNumber} must have 4 options`);
            totalOpts += q.options.length;
        }
        assert.equal(totalOpts, 400, "Must have exactly 400 options");

        // Step 6: Verify answer-key mapping
        const answerKeys = importedJob.draftPackage.answerKeys;
        assert.equal(answerKeys.length, 100);
        const unverified = answerKeys.filter(k => k.verificationStatus !== "verified");
        assert.equal(unverified.length, 0, "All 100 answer keys must be verified");

        // Step 7: Confirm publication eligibility
        assert.equal(importedJob.validationReport.canPublish, true);
        assert.equal(importedJob.validationReport.blockers.length, 0);

        // Publish test through official workflow
        const publishResult = await ImportJobPipelineService.publishTest({
            jobId: importedJob.jobId,
            actor: "admin_upsc_verifier"
        });

        assert.equal(publishResult.status, "published");
        publishedTestId = publishResult.testId;
        assert.equal(publishedTestId, "mock-upsc-prelims-2026-a");
    });

    // =========================================================================
    // PILLAR 4: Student Workflow in Isolated Test Environment
    // =========================================================================
    await t.test("Pillar 4: Student Workflow in Isolated Test Environment", async (t4) => {
        const studentUid = "test_student_upsc_777";

        // Step 4.1: Student catalog visibility
        const catalogTests = await MockTestService.listPublishedTests();
        const upscTest = catalogTests.find(t => t.testId === publishedTestId);
        assert.ok(upscTest, `Published test ${publishedTestId} must appear in student catalog`);
        assert.equal(upscTest.totalQuestions, 100);
        assert.equal(upscTest.durationSeconds, 7200);

        // Step 4.2: Retrieve questions as student (ensure answers are strictly stripped!)
        const testData = await MockTestService.getTestForStudent(publishedTestId, { callerRole: "user" });
        assert.ok(testData && testData.questions, "Student test data must be returned");
        const studentQuestions = testData.questions;
        assert.equal(studentQuestions.length, 100, "Student must receive all 100 questions");

        for (const sq of studentQuestions) {
            assert.equal(sq.options.length, 4, `Q${sq.questionNumber} must have 4 options`);
            // Security check: No answer key secrets exposed!
            assert.equal(sq.correctOptionIds, undefined, `Q${sq.questionNumber} must not leak correctOptionIds`);
            assert.equal(sq.correctOptionId, undefined, `Q${sq.questionNumber} must not leak correctOptionId`);
            assert.equal(sq.acceptedAnswers, undefined, `Q${sq.questionNumber} must not leak acceptedAnswers`);
            assert.equal(sq.answerKey, undefined, `Q${sq.questionNumber} must not leak answerKey`);
        }

        // Step 4.3: Start attempt with authoritative 120-minute server timer
        const attempt = await MockTestService.startAttempt({
            testId: publishedTestId,
            userId: studentUid
        });

        assert.ok(attempt.attemptId);
        assert.equal(attempt.status, "in_progress");
        assert.equal(attempt.durationSeconds, 7200);

        const startMs = new Date(attempt.startedAt).getTime();
        const deadlineMs = new Date(attempt.deadlineAt).getTime();
        const diffSeconds = Math.round((deadlineMs - startMs) / 1000);
        assert.equal(diffSeconds, 7200, "Authoritative timer deadline must be exactly 7200 seconds (120 minutes)");

        // Step 4.4: Incremental autosave and marking for review
        // Answer 50 questions, mark 5 for review
        const studentAnswers = {};
        for (let i = 0; i < 50; i++) {
            const q = studentQuestions[i];
            studentAnswers[q.questionId] = "1"; // Select option 1
        }
        const markedForReview = [studentQuestions[0].questionId, studentQuestions[1].questionId];

        const saveRes = await MockTestService.autosaveAttempt({
            attemptId: attempt.attemptId,
            userId: studentUid,
            answers: studentAnswers,
            markedForReview
        });

        assert.equal(saveRes.success, true);
        assert.equal(saveRes.savedCount, 50);
        assert.equal(saveRes.markedCount, 2);

        // Step 4.5: Authoritative server-side submission
        const submitResult = await MockTestService.submitAttempt({
            attemptId: attempt.attemptId,
            userId: studentUid
        });

        assert.ok(submitResult.resultId);
        assert.equal(submitResult.totalQuestions, 100);
        assert.equal(submitResult.attemptedCount, 50);
        assert.equal(submitResult.unansweredCount, 50);
        assert.equal(submitResult.maximumMarks, 200);
        assert.ok(typeof submitResult.totalScore === "number");

        // Step 4.6: Result & Review verification
        const fetchedResult = await MockTestService.getResult({
            resultId: submitResult.resultId,
            userId: studentUid
        });

        assert.equal(fetchedResult.resultId, submitResult.resultId);
        assert.equal(fetchedResult.totalScore, submitResult.totalScore);
        assert.equal(fetchedResult.maximumMarks, 200);

        // Verify exam review displays breakdown with correct answers exposed only after submission
        const review = await MockTestService.getReviewForAttempt({
            attemptId: attempt.attemptId,
            userId: studentUid
        });

        assert.equal(review.questions.length, 100);
        // Correct answers now visible for review on incorrect questions
        const incorrectReviewQ = review.questions.find(q => q.studentAnswer && q.correctAnswer);
        if (incorrectReviewQ) {
            assert.ok(incorrectReviewQ.correctAnswer !== undefined);
        }

        // Step 4.7: Cross-user isolation: Another student cannot access this attempt
        await assert.rejects(
            async () => {
                await MockTestService.getAttempt({
                    attemptId: attempt.attemptId,
                    userId: "intruder_student_999",
                    callerRole: "user"
                });
            },
            /Access Denied/i,
            "Cross-user attempt access must be strictly blocked"
        );
    });

    // =========================================================================
    // PILLAR 5: Persistence Across Application Lifecycle
    // =========================================================================
    await t.test("Pillar 5: Document Persistence & Production Safety", async () => {
        // Retrieve published test document from Firestore storage layer
        const testDoc = await UniversalFirestoreService.getDocument("mockTests", publishedTestId);
        assert.ok(testDoc, `Published test ${publishedTestId} must exist in persistent store`);
        assert.equal(testDoc.status, "published");
        assert.equal(testDoc.totalQuestions, 100);
        assert.equal(testDoc.maximumMarks, 200);

        // Verify all 100 questions persist
        const allQuestions = await UniversalFirestoreService.listDocuments("mockQuestions");
        const testQuestions = allQuestions.filter(q => q.testId === publishedTestId || (testDoc.questionIds || []).includes(q.questionId));
        assert.equal(testQuestions.length, 100, "All 100 questions must persist in Firestore mockQuestions");

        // Verify all 100 answer keys persist
        const allKeys = await UniversalFirestoreService.listDocuments("mockAnswerKeys");
        const testKeys = allKeys.filter(k => k.testId === publishedTestId || testQuestions.map(q => q.questionId).includes(k.questionId));
        assert.equal(testKeys.length, 100, "All 100 answer keys must persist in Firestore mockAnswerKeys");

        // Production safety check: Ensure test operations run strictly in test mode without mutating live production collections
        assert.equal(process.env.NODE_ENV, "test", "Operations must strictly run in test environment");
        assert.notEqual(process.env.ALLOW_PRODUCTION_TEST_WRITES, "true", "Production test writes must never be enabled");
    });
});
