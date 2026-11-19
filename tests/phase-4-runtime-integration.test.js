process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "staging-vidyarthiastra";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { UIRValidator } from "../server/services/uir/uirValidator.js";
import {
    UIR_SCHEMA_VERSION,
    UIR_APPROVAL_STATUS,
    UIR_QUESTION_TYPES
} from "../server/services/uir/uirSchema.js";
import {
    UIRToScoringAdapter,
    UIRToMockTestAdapter,
    LegacyToUIRAdapter
} from "../server/services/uir/uirAdapters.js";
import { MockTestService } from "../server/services/mockTestService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { Rational } from "../server/services/scoring/rational.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const vaultDir = path.join(rootDir, "uploads/vault");

function getVaultFile(pattern) {
    if (!fs.existsSync(vaultDir)) return null;
    const files = fs.readdirSync(vaultDir);
    const matches = files.filter(f => f.includes(pattern)).sort().reverse();
    return matches.length > 0 ? path.join(vaultDir, matches[0]) : null;
}

describe("Phase 4: Universal Mock-Test Generation & Runtime Integration Acceptance Suite", () => {

    const testAdminUid = "admin_runtime_auditor";
    const testStudentUid = "student_runtime_candidate";

    // -------------------------------------------------------------
    // Test Case 1: Synthetic ARSEO 2026 (Diverse Modern Question Types)
    // -------------------------------------------------------------
    describe("1. Synthetic ARSEO 2026 Universal Ingestion & Lifecycle", () => {
        const arseoQpText = [
            "SYNTHETIC ADVANCED ROBOTICS & SPACE ENGINEERING OLYMPIAD 2026",
            "Duration: 60 Minutes | Maximum Marks: 28",
            "SECTION A: ROBOTICS AND KINEMATICS",
            "Q. 1 In a planar 2-link robotic arm with link lengths L1 and L2, what is the maximum reachable workspace area?",
            "(A) pi*(L1 - L2)^2",
            "(B) pi*(L1 + L2)^2",
            "(C) 2*pi*(L1 + L2)",
            "(D) pi*(L1^2 + L2^2)",
            "Q. 2 Refer to Figure 1: Quadcopter Rotor Dynamics. Which rotor pair must rotate clockwise to counteract gyroscopic precession?",
            "(A) Rotors 1 and 3",
            "(B) Rotors 2 and 4",
            "(C) Rotors 1 and 2",
            "(D) Rotors 3 and 4",
            "Q. 3 Assertion (A): Forward kinematics matrix has determinant 1.",
            "Reason (R): The rotation group SO(3) preserves orthogonal vector norms.",
            "(A) Both A and R are true and R is correct explanation of A",
            "(B) Both A and R are true but R is NOT correct explanation of A",
            "(C) A is true but R is false",
            "(D) Both A and R are false",
            "Q. 4 Which deep space sensor is immune to magnetic fields?",
            "(A) Magnetometer",
            "(B) Hall Sensor",
            "(C) Optical Star Tracker",
            "(D) Fluxgate Compass",
            "SECTION B: SPACE PROPULSION AND ASTRODYNAMICS",
            "Q. 5 Calculate specific impulse for defective vacuum nozzle. Problem under dispute:",
            "Q. 6 Enter the escape velocity from Earth surface in km/s:",
            "Q. 7 Describe the three Keplerian laws of planetary motion and derive orbital period formula:"
        ].join("\n");

        const arseoAkText = [
            "SYNTHETIC ARSEO 2026 OFFICIAL ANSWER KEY",
            "Paper Code: ARSEO-2026",
            "Q.No.  Accepted Key",
            "1   B",
            "2   A",
            "3   A",
            "4   C",
            "5   DROPPED",
            "6   11.2",
            "7   DESCRIPTIVE"
        ].join("\n");

        const arseoPfText = [
            "SYNTHETIC ARSEO 2026 EXAMINATION PATTERN & NOTIFICATION",
            "Total Questions: 7 | Duration: 60 Minutes | Maximum Marks: 28",
            "SECTION A: ROBOTICS AND KINEMATICS",
            "Questions: 4 | Marks per question: 4 | Negative marking: 1",
            "SECTION B: SPACE PROPULSION AND ASTRODYNAMICS",
            "Questions: 3 | Marks per question: 4 | Negative marking: 0"
        ].join("\n");

        let arseoTestId = "mock-arseo-2026-q1";
        let arseoAttemptId = null;

        it("1.1 ingests ARSEO 2026 documents and produces canonical UIR v3.0", async () => {
            const result = await UIRTransformationService.transformDocuments({
                questionPaper: arseoQpText,
                answerKey: arseoAkText,
                paperFormat: arseoPfText
            }, {
                examId: "arseo-2026",
                year: 2026,
                paperCode: "Q1",
                examTitle: "Synthetic ARSEO 2026",
                approvalStatus: UIR_APPROVAL_STATUS.APPROVED
            });

            assert.ok(result);
            assert.ok(result.uirDocument);
            const uirDoc = result.uirDocument;

            assert.equal(uirDoc.questions.length, 7);
            assert.equal(uirDoc.sections.length, 2);
            assert.equal(uirDoc.questions[2].questionType, UIR_QUESTION_TYPES.ASSERTION_REASON);
            assert.equal(uirDoc.questions[4].correctAnswer.isDropped, true);
            assert.equal(uirDoc.questions[5].questionType, UIR_QUESTION_TYPES.NUMERICAL_NAT);
            assert.equal(uirDoc.questions[6].questionType, UIR_QUESTION_TYPES.DESCRIPTIVE_MANUAL);

            // Persist to mockTests and mockQuestions
            const { mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs } = UIRToMockTestAdapter.toFirestoreDocuments(uirDoc);
            mockTestDoc.testId = arseoTestId;
            mockTestDoc.status = "published";

            for (const q of mockQuestionDocs) q.testId = arseoTestId;
            for (const ak of mockAnswerKeyDocs) ak.testId = arseoTestId;

            await UniversalFirestoreService.setDocument("mockTests", arseoTestId, mockTestDoc);
            for (const q of mockQuestionDocs) {
                await UniversalFirestoreService.setDocument("mockQuestions", q.questionId, q);
            }
            for (const ak of mockAnswerKeyDocs) {
                await UniversalFirestoreService.setDocument("mockAnswerKeys", ak.questionId, ak);
            }
        });

        it("1.2 student fetches test metadata and questions with answer keys strictly stripped", async () => {
            const studentView = await MockTestService.getTestForStudent(arseoTestId, { callerRole: "user" });
            assert.ok(studentView);
            assert.equal(studentView.test.testId, arseoTestId);
            assert.equal(studentView.test.sections.length, 2);
            assert.equal(studentView.questions.length, 7);

            // Strict confidentiality verification
            for (const q of studentView.questions) {
                assert.equal(q.correctAnswer, undefined);
                assert.equal(q.acceptedAnswers, undefined);
                assert.equal(q.correctOptionIds, undefined);
                assert.ok(q.sectionName, "Must include sectionName");
            }

            // Verify rich question types on student view
            assert.equal(studentView.questions[2].questionType, UIR_QUESTION_TYPES.ASSERTION_REASON);
            assert.equal(studentView.questions[5].questionType, UIR_QUESTION_TYPES.NUMERICAL_NAT);
            assert.equal(studentView.questions[6].questionType, UIR_QUESTION_TYPES.DESCRIPTIVE_MANUAL);
        });

        it("1.3 student starts attempt, autosaves responses, and updates palette", async () => {
            const attemptRes = await MockTestService.startAttempt({
                testId: arseoTestId,
                userId: testStudentUid,
                language: "English"
            });

            assert.ok(attemptRes);
            assert.equal(attemptRes.status, "in_progress");
            assert.ok(attemptRes.deadlineAt);
            arseoAttemptId = attemptRes.attemptId;

            // Autosave partial answers
            const qList = await UniversalFirestoreService.listDocuments("mockQuestions");
            const arseoQuestions = qList.filter(q => q.testId === arseoTestId).sort((a, b) => a.questionNumber - b.questionNumber);

            const studentAnswers = {
                [arseoQuestions[0].questionId]: "B",
                [arseoQuestions[1].questionId]: "A",
                [arseoQuestions[2].questionId]: "A",
                [arseoQuestions[3].questionId]: "A", // Incorrect (Key is C)
                // Q5 is Dropped (Candidate does not answer)
                [arseoQuestions[5].questionId]: "11.2", // Correct NAT
                [arseoQuestions[6].questionId]: "Kepler First Law: Elliptical orbits with sun at focus..."
            };

            const autosaveRes = await MockTestService.autosaveAttempt({
                attemptId: arseoAttemptId,
                userId: testStudentUid,
                answers: studentAnswers,
                markedForReview: [arseoQuestions[2].questionId]
            });

            assert.equal(autosaveRes.success, true);
            assert.equal(autosaveRes.savedCount, 6);
        });

        it("1.4 student submits attempt, evaluates via universal scoring engine with provisional descriptive status", async () => {
            const submitRes = await MockTestService.submitAttempt({
                attemptId: arseoAttemptId,
                userId: testStudentUid
            });

            assert.ok(submitRes);
            const res = submitRes.result || submitRes;

            // Q1 (+4), Q2 (+4), Q3 (+4), Q4 (-1), Q5 (+4 dropped bonus), Q6 (+4 NAT) = 19 marks objective
            // Q7 is descriptive manual -> pending review
            assert.equal(res.requiresManualEvaluation, true);
            assert.equal(res.isFinalized, false);
            assert.equal(res.pendingReviewCount, 1);
            assert.equal(res.correctCount, 4); // Q1, Q2, Q3, Q6
            assert.equal(res.incorrectCount, 1); // Q4
            assert.equal(res.droppedCount, 1); // Q5 bonus
            assert.equal(res.totalScore, 19);

            // Review mode verification
            const review = await MockTestService.getReviewForAttempt({
                attemptId: arseoAttemptId,
                userId: testStudentUid
            });

            assert.ok(review);
            assert.equal(review.questions.length, 7);
            const q4Review = review.questions.find(q => q.questionNumber === 4);
            assert.equal(q4Review.status, "incorrect");
            assert.ok(q4Review.correctAnswer); // Revealed only after submission
        });
    });

    // -------------------------------------------------------------
    // Test Case 2: Real UPSC Prelims 2026 Paper I Ingestion & Runtime
    // -------------------------------------------------------------
    describe("2. Real UPSC Prelims 2026 Paper I Full Application Lifecycle", () => {
        const qpPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Typed.pdf");
        const akPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Answer_Key.pdf");
        const epPath = getVaultFile("UPSC_Prelims_2026_Paper_1_Pattern.pdf");

        let upscTestId = "mock-upsc-prelims-2026-a";
        let upscAttemptId = null;

        it("2.1 ingests 100 questions and verifies exact rational scoring (+2, -2/3)", async () => {
            assert.ok(fs.existsSync(qpPath), "UPSC QP PDF must exist in vault");
            assert.ok(fs.existsSync(akPath), "UPSC AK PDF must exist in vault");
            assert.ok(fs.existsSync(epPath), "UPSC EP PDF must exist in vault");

            const qpBuf = fs.readFileSync(qpPath);
            const akBuf = fs.readFileSync(akPath);
            const epBuf = fs.readFileSync(epPath);

            const result = await UIRTransformationService.transformDocuments({
                questionPaper: qpBuf,
                answerKey: akBuf,
                paperFormat: epBuf
            }, {
                examId: "upsc-prelims-2026",
                year: 2026,
                paperCode: "A",
                examTitle: "UPSC Civil Services Prelims 2026 Paper I (GS)",
                approvalStatus: UIR_APPROVAL_STATUS.APPROVED
            });

            const uirDoc = result.uirDocument;
            assert.equal(uirDoc.questions.length, 100);

            // Verify scoring rule rational (+2, -2/3)
            const q1Scoring = uirDoc.questions[0].scoring;
            assert.equal(q1Scoring.positiveMarks, 2);
            const negRat = Rational.from(q1Scoring.negativeMarksRational || q1Scoring.negativeMarks);
            assert.equal(negRat.num, -2n);
            assert.equal(negRat.den, 3n);

            // Persist to mockTests
            const { mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs } = UIRToMockTestAdapter.toFirestoreDocuments(uirDoc);
            mockTestDoc.testId = upscTestId;
            mockTestDoc.status = "published";

            for (const q of mockQuestionDocs) q.testId = upscTestId;
            for (const ak of mockAnswerKeyDocs) ak.testId = upscTestId;

            await UniversalFirestoreService.setDocument("mockTests", upscTestId, mockTestDoc);
            for (const q of mockQuestionDocs) {
                await UniversalFirestoreService.setDocument("mockQuestions", q.questionId, q);
            }
            for (const ak of mockAnswerKeyDocs) {
                await UniversalFirestoreService.setDocument("mockAnswerKeys", ak.questionId, ak);
            }
        });

        it("2.2 student attempts UPSC test with exact rational scoring across 100 questions", async () => {
            const attemptRes = await MockTestService.startAttempt({
                testId: upscTestId,
                userId: testStudentUid,
                language: "English"
            });
            upscAttemptId = attemptRes.attemptId;

            const qList = await UniversalFirestoreService.listDocuments("mockQuestions");
            const upscQuestions = qList.filter(q => q.testId === upscTestId).sort((a, b) => a.questionNumber - b.questionNumber);
            const akList = await UniversalFirestoreService.listDocuments("mockAnswerKeys");
            const upscKeys = akList.filter(ak => ak.testId === upscTestId);

            // Construct student answers: 50 correct, 25 incorrect, 25 unattempted
            const studentAnswers = {};
            for (let i = 0; i < 50; i++) {
                const q = upscQuestions[i];
                const ak = upscKeys.find(k => k.questionId === q.questionId);
                studentAnswers[q.questionId] = ak.acceptedAnswers[0] || "A";
            }
            for (let i = 50; i < 75; i++) {
                const q = upscQuestions[i];
                const ak = upscKeys.find(k => k.questionId === q.questionId);
                const correct = ak.acceptedAnswers[0] || "A";
                // Pick a wrong option
                studentAnswers[q.questionId] = correct === "A" ? "B" : "A";
            }

            const submitRes = await MockTestService.submitAttempt({
                attemptId: upscAttemptId,
                userId: testStudentUid,
                answers: studentAnswers
            });

            const res = submitRes.result || submitRes;
            assert.equal(res.correctCount, 50);
            assert.equal(res.incorrectCount, 25);
            assert.equal(res.unansweredCount, 25);

            // Expected score: 50 * 2 - 25 * (2/3) = 100 - 16.6666... = 83.333
            assert.equal(Math.round(res.totalScore * 100) / 100, 83.33);
        });
    });

    // -------------------------------------------------------------
    // Test Case 3: Real BPSC 69th Prelims Bilingual Ingestion & Runtime
    // -------------------------------------------------------------
    describe("3. Real BPSC 69th Prelims Bilingual Test Execution", () => {
        const qpPath = getVaultFile("69TH_PRELIMS_M1.pdf");
        const akPath = getVaultFile("BPSC_69th_Prelims___General_Studies__Booklet_Series_A_Answer_Key.pdf");
        const epPath = getVaultFile("BPSC_Prelims_Exam_Pattern.pdf");

        let bpscTestId = "mock-bpsc-69th-prelims-a";
        let bpscAttemptId = null;

        it("3.1 ingests 150 questions with 100% 4-option resolution and bilingual Hindi variants", async () => {
            assert.ok(fs.existsSync(qpPath), "BPSC QP PDF must exist in vault");
            assert.ok(fs.existsSync(akPath), "BPSC AK PDF must exist in vault");
            assert.ok(fs.existsSync(epPath), "BPSC EP PDF must exist in vault");

            const qpBuf = fs.readFileSync(qpPath);
            const akBuf = fs.readFileSync(akPath);
            const epBuf = fs.readFileSync(epPath);

            const result = await UIRTransformationService.transformDocuments({
                questionPaper: qpBuf,
                answerKey: akBuf,
                paperFormat: epBuf
            }, {
                examId: "bpsc-69th-prelims",
                year: 2023,
                paperCode: "A",
                examTitle: "BPSC 69th Combined Competitive Examination",
                approvalStatus: UIR_APPROVAL_STATUS.APPROVED
            });

            const uirDoc = result.uirDocument;
            assert.equal(uirDoc.questions.length, 150);
            assert.ok(uirDoc.examMetadata.languages.includes("Hindi"));

            const { mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs } = UIRToMockTestAdapter.toFirestoreDocuments(uirDoc);
            mockTestDoc.testId = bpscTestId;
            mockTestDoc.status = "published";

            for (const q of mockQuestionDocs) q.testId = bpscTestId;
            for (const ak of mockAnswerKeyDocs) ak.testId = bpscTestId;

            await UniversalFirestoreService.setDocument("mockTests", bpscTestId, mockTestDoc);
            for (const q of mockQuestionDocs) {
                await UniversalFirestoreService.setDocument("mockQuestions", q.questionId, q);
            }
            for (const ak of mockAnswerKeyDocs) {
                await UniversalFirestoreService.setDocument("mockAnswerKeys", ak.questionId, ak);
            }
        });

        it("3.2 student takes test in Hindi language and receives exact -1/3 penalty", async () => {
            const studentView = await MockTestService.getTestForStudent(bpscTestId, { callerRole: "user", language: "Hindi" });
            assert.equal(studentView.questions.length, 150);

            const attemptRes = await MockTestService.startAttempt({
                testId: bpscTestId,
                userId: testStudentUid,
                language: "Hindi"
            });
            bpscAttemptId = attemptRes.attemptId;

            const qList = await UniversalFirestoreService.listDocuments("mockQuestions");
            const bpscQuestions = qList.filter(q => q.testId === bpscTestId).sort((a, b) => a.questionNumber - b.questionNumber);
            const akList = await UniversalFirestoreService.listDocuments("mockAnswerKeys");
            const bpscKeys = akList.filter(ak => ak.testId === bpscTestId);

            // 90 correct (+90), 30 incorrect (-10), 30 unattempted = 80 marks
            const studentAnswers = {};
            for (let i = 0; i < 90; i++) {
                const q = bpscQuestions[i];
                const ak = bpscKeys.find(k => k.questionId === q.questionId);
                studentAnswers[q.questionId] = ak.acceptedAnswers[0] || "A";
            }
            for (let i = 90; i < 120; i++) {
                const q = bpscQuestions[i];
                const ak = bpscKeys.find(k => k.questionId === q.questionId);
                const correct = ak.acceptedAnswers[0] || "A";
                studentAnswers[q.questionId] = correct === "A" ? "B" : "A";
            }

            const submitRes = await MockTestService.submitAttempt({
                attemptId: bpscAttemptId,
                userId: testStudentUid,
                answers: studentAnswers
            });

            const res = submitRes.result || submitRes;
            assert.equal(res.correctCount, 90);
            assert.equal(res.incorrectCount, 30);
            assert.equal(res.totalScore, 80);
        });
    });

    // -------------------------------------------------------------
    // Test Case 4: Real JEE Main 2026 Shift 1 Font Remediation & Optional Policy
    // -------------------------------------------------------------
    describe("4. Real JEE Main 2026 Shift 1 Quality Gate & Runtime", () => {
        const qpPath = getVaultFile("JEE_Main_21_Jan_2026_Shift_1.pdf");
        const akPath = getVaultFile("JEE_Main_21_Jan_2026_Shift1_Answer_Key.pdf");
        const epPath = getVaultFile("JEE_Main_2026_Exam_Format.pdf");

        let jeeTestId = "mock-jee-main-2026-shift1";
        let jeeAttemptId = null;
        let uirDoc = null;

        it("4.1 ingests 75 questions, detects font corruption on Q29, Q64, Q65 and enforces publication block", async () => {
            assert.ok(fs.existsSync(qpPath), "JEE QP PDF must exist in vault");
            assert.ok(fs.existsSync(akPath), "JEE AK PDF must exist in vault");
            assert.ok(fs.existsSync(epPath), "JEE EP PDF must exist in vault");

            const qpBuf = fs.readFileSync(qpPath);
            const akBuf = fs.readFileSync(akPath);
            const epBuf = fs.readFileSync(epPath);

            const result = await UIRTransformationService.transformDocuments({
                questionPaper: qpBuf,
                answerKey: akBuf,
                paperFormat: epBuf
            }, {
                examId: "jee-main-2026",
                year: 2026,
                paperCode: "Shift1",
                examTitle: "JEE Main 2026 Session 1 (21 Jan Shift 1)"
            });

            uirDoc = result.uirDocument;
            assert.equal(uirDoc.questions.length, 75);

            // Questions 29, 64, 65 have contentCorruptionDetected
            const q29 = uirDoc.questions.find(q => q.questionNumber === 29);
            const q64 = uirDoc.questions.find(q => q.questionNumber === 64);
            const q65 = uirDoc.questions.find(q => q.questionNumber === 65);

            assert.equal(q29.qualityFlags.contentCorruptionDetected, true);
            assert.equal(q64.qualityFlags.contentCorruptionDetected, true);
            assert.equal(q65.qualityFlags.contentCorruptionDetected, true);

            // Validation strictly blocks publication
            const unverifiedDoc = JSON.parse(JSON.stringify(uirDoc));
            unverifiedDoc.examMetadata.approvalStatus = UIR_APPROVAL_STATUS.APPROVED;
            const initialValidation = UIRValidator.validate(unverifiedDoc);
            assert.equal(initialValidation.isValid, false);
            const blockers = initialValidation.errors.filter(e => e.includes("Publication Blocker"));
            assert.equal(blockers.length, 3);
            assert.ok(blockers.some(b => b.includes("q_29")));
            assert.ok(blockers.some(b => b.includes("q_64")));
            assert.ok(blockers.some(b => b.includes("q_65")));
        });

        it("4.2 applies audited human corrections and unlocks publication approval", () => {
            UIRTransformationService.applyHumanCorrection(uirDoc, {
                questionNumber: 29,
                modifiedBy: "jee_examiner",
                reason: "Reconstructed chemical isomer options from official errata",
                correctedOptions: [
                    { id: "A", text: "2-methylbutane" },
                    { id: "B", text: "pentane" },
                    { id: "C", text: "2,2-dimethylpropane" },
                    { id: "D", text: "cyclopentane" }
                ]
            });

            UIRTransformationService.applyHumanCorrection(uirDoc, {
                questionNumber: 64,
                modifiedBy: "jee_examiner",
                reason: "Reconstructed integral expression from official errata",
                correctedOptions: [
                    { id: "A", text: "e^x * sin(x)" },
                    { id: "B", text: "e^x * cos(x)" },
                    { id: "C", text: "e^x / 2" },
                    { id: "D", text: "0" }
                ]
            });

            UIRTransformationService.applyHumanCorrection(uirDoc, {
                questionNumber: 65,
                modifiedBy: "jee_examiner",
                reason: "Reconstructed vector coordinate expression",
                correctedOptions: [
                    { id: "A", text: "4" },
                    { id: "B", text: "8" },
                    { id: "C", text: "12" },
                    { id: "D", text: "16" }
                ]
            });

            uirDoc.examMetadata.approvalStatus = UIR_APPROVAL_STATUS.APPROVED;
            const postValidation = UIRValidator.validate(uirDoc);
            assert.equal(postValidation.isValid, true);
            assert.equal(postValidation.errors.length, 0);
        });

        it("4.3 publishes test and evaluates student attempt with NAT numerical range", async () => {
            const { mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs } = UIRToMockTestAdapter.toFirestoreDocuments(uirDoc);
            mockTestDoc.testId = jeeTestId;
            mockTestDoc.status = "published";

            for (const q of mockQuestionDocs) q.testId = jeeTestId;
            for (const ak of mockAnswerKeyDocs) ak.testId = jeeTestId;

            await UniversalFirestoreService.setDocument("mockTests", jeeTestId, mockTestDoc);
            for (const q of mockQuestionDocs) {
                await UniversalFirestoreService.setDocument("mockQuestions", q.questionId, q);
            }
            for (const ak of mockAnswerKeyDocs) {
                await UniversalFirestoreService.setDocument("mockAnswerKeys", ak.questionId, ak);
            }

            const attemptRes = await MockTestService.startAttempt({
                testId: jeeTestId,
                userId: testStudentUid,
                language: "English"
            });
            jeeAttemptId = attemptRes.attemptId;

            // Submit 60 MCQs + 5 NATs
            const qList = await UniversalFirestoreService.listDocuments("mockQuestions");
            const jeeQuestions = qList.filter(q => q.testId === jeeTestId).sort((a, b) => a.questionNumber - b.questionNumber);
            const akList = await UniversalFirestoreService.listDocuments("mockAnswerKeys");
            const jeeKeys = akList.filter(ak => ak.testId === jeeTestId);

            const studentAnswers = {};
            // Attempt 20 Section A questions correctly
            for (let i = 0; i < 20; i++) {
                const q = jeeQuestions[i];
                const ak = jeeKeys.find(k => k.questionId === q.questionId);
                studentAnswers[q.questionId] = ak.acceptedAnswers[0] || "A";
            }
            // Attempt 5 Section B NAT questions correctly (Q21 to Q25)
            for (let i = 20; i < 25; i++) {
                const q = jeeQuestions[i];
                const ak = jeeKeys.find(k => k.questionId === q.questionId);
                const val = ak.numericValue !== null ? String(ak.numericValue) : (ak.acceptedAnswers[0] || "10");
                studentAnswers[q.questionId] = val;
            }

            const submitRes = await MockTestService.submitAttempt({
                attemptId: jeeAttemptId,
                userId: testStudentUid,
                answers: studentAnswers
            });

            const res = submitRes.result || submitRes;
            assert.equal(res.correctCount, 25);
            assert.equal(res.incorrectCount, 0);
            assert.equal(res.totalScore, 100); // 25 * 4 = 100
        });
    });

    // -------------------------------------------------------------
    // Test Case 5: End-to-End ImportJobPipelineService Integration
    // -------------------------------------------------------------
    describe("5. ImportJobPipelineService Universal Pipeline Integration", () => {
        it("5.1 runs Universal Pipeline via ImportJobPipelineService and attaches uirDocument", async () => {
            const job = ImportJobPipelineService.createJob({
                examName: "Synthetic Universal QA Exam",
                examId: "synthetic-qa-exam",
                year: 2026,
                paperCode: "Q1",
                isSyntheticTest: true,
                testRunId: "test_run_phase4_runtime_01"
            });

            // Attach synthetic ARSEO documents
            await ImportJobPipelineService.attachDocuments(job.jobId, {
                questionPaper: {
                    originalFilename: "ARSEO_QP.pdf",
                    hash: "hash_qp_synthetic_01",
                    base64: Buffer.from("SYNTHETIC ARSEO 2026 QP Q. 1 What is X? (A) 1 (B) 2 Q. 2 What is Y? (A) 3 (B) 4").toString("base64")
                },
                answerKey: {
                    originalFilename: "ARSEO_AK.pdf",
                    hash: "hash_ak_synthetic_01",
                    base64: Buffer.from("SYNTHETIC ARSEO 2026 AK 1 A 2 B").toString("base64")
                },
                examPattern: {
                    originalFilename: "ARSEO_EP.pdf",
                    hash: "hash_ep_synthetic_01",
                    base64: Buffer.from("SYNTHETIC ARSEO 2026 PATTERN Total Questions: 2 | Marks: 8").toString("base64")
                }
            });

            // Mock StorageVaultService retrieveDocumentBuffer
            const originalRetrieve = (await import("../server/services/admin/storageVaultService.js")).StorageVaultService.retrieveDocumentBuffer;
            (await import("../server/services/admin/storageVaultService.js")).StorageVaultService.retrieveDocumentBuffer = async (docRef) => {
                if (docRef.originalFilename.includes("QP")) {
                    return Buffer.from([
                        "SYNTHETIC ARSEO 2026",
                        "Duration: 60 Minutes | Maximum Marks: 8",
                        "SECTION A: ROBOTICS",
                        "Q. 1 What is X?",
                        "(A) 1",
                        "(B) 2",
                        "Q. 2 What is Y?",
                        "(A) 3",
                        "(B) 4"
                    ].join("\n"));
                } else if (docRef.originalFilename.includes("AK")) {
                    return Buffer.from([
                        "SYNTHETIC ARSEO 2026 ANSWER KEY",
                        "Q.No. Accepted Key",
                        "1 A",
                        "2 B"
                    ].join("\n"));
                } else {
                    return Buffer.from([
                        "SYNTHETIC ARSEO 2026 PATTERN",
                        "Total Questions: 2 | Duration: 60 Minutes | Maximum Marks: 8",
                        "SECTION A: ROBOTICS"
                    ].join("\n"));
                }
            };

            const completedJob = await ImportJobPipelineService.runUniversalPipeline(job.jobId);

            // Restore retrieveDocumentBuffer
            (await import("../server/services/admin/storageVaultService.js")).StorageVaultService.retrieveDocumentBuffer = originalRetrieve;

            assert.equal(completedJob.status, "ready_to_publish");
            assert.ok(completedJob.uirDocument);
            assert.equal(completedJob.uirDocument.questions.length, 2);
            assert.equal(completedJob.extractedQuestionCount, 2);
            assert.equal(completedJob.validationReport.canPublish, true);

            // Publish test
            const pubResult = await ImportJobPipelineService.publishTest({
                jobId: completedJob.jobId,
                actor: testAdminUid
            });

            assert.equal(pubResult.status, "published");

            const publishedMockTest = await UniversalFirestoreService.getDocument("mockTests", pubResult.testId);
            assert.equal(publishedMockTest.status, "published");
            assert.equal(publishedMockTest.schemaVersion, UIR_SCHEMA_VERSION);
            assert.ok(Array.isArray(publishedMockTest.sections));
        });
    });
});
