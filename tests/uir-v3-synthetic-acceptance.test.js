import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSimplePdf } from "./fixtures/documents/syntheticExamFixtures.js";
import { UniversalDocumentIngestionService } from "../server/services/ingestion/universalDocumentIngestionService.js";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { UIRValidator } from "../server/services/uir/uirValidator.js";
import {
    UIR_SCHEMA_VERSION,
    UIR_QUESTION_TYPES,
    UIR_ANSWER_TYPES,
    UIR_APPROVAL_STATUS,
    createUIRDocument,
    createUIRSection,
    createUIRQuestion,
    createUIRScoringRule
} from "../server/services/uir/uirSchema.js";
import {
    UIRToScoringAdapter,
    UIRToLegacyAdapter,
    UIRToMockTestAdapter,
    LegacyToUIRAdapter
} from "../server/services/uir/uirAdapters.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { LegacyScoringAdapter } from "../server/services/scoring/legacyScoringAdapter.js";
import { Rational } from "../server/services/scoring/rational.js";

describe("Phase 3: Universal Intermediate Representation (UIR v3.0) — Synthetic Acceptance Suite", () => {

    // Define Synthetic Examination: "Synthetic Advanced Robotics & Space Engineering Olympiad 2026"
    const qpText = [
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
        "Q. 3 The forward kinematics homogeneous transformation matrix determinant is always:",
        "(A) Exactly 1",
        "(B) Exactly 0",
        "(C) Exactly -1",
        "(D) Dependent on joint angles",
        "Q. 4 Which navigation sensor is immune to electromagnetic interference in deep space probes?",
        "(A) Magnetometer",
        "(B) Hall Effect Sensor",
        "(C) Optical Star Tracker",
        "(D) Fluxgate Compass",
        "SECTION B: SPACE PROPULSION AND ASTRODYNAMICS",
        "Q. 5 Calculate the specific impulse Isp in seconds for a vacuum arc thruster. Defective nozzle problem:",
        "Q. 6 Calculate the escape velocity from Earth surface in km/s. Enter numerical value or range:",
        "Q. 7 Which of the following orbits are non-coplanar with the Earth equatorial plane?",
        "(A) Polar Orbit",
        "(B) Geostationary Orbit",
        "(C) Sun-Synchronous Orbit",
        "(D) Equatorial Low Earth Orbit"
    ].join("\n");

    const akText = [
        "SYNTHETIC ARSEO 2026 OFFICIAL ANSWER KEY",
        "Paper Code: ARSEO-2026",
        "Q.No.  Accepted Key",
        "1   B",
        "2   A",
        "3   A",
        "4   C",
        "5   DROPPED",
        "6   [11.1, 11.3]",
        "7   A, C"
    ].join("\n");

    const pfText = [
        "SYNTHETIC ARSEO 2026 EXAMINATION PATTERN & NOTIFICATION",
        "Total Questions: 7 | Duration: 60 Minutes | Maximum Marks: 28",
        "SECTION A: ROBOTICS AND KINEMATICS",
        "Number of Questions: 4 | Marking: Correct +4, Incorrect -1, Unanswered 0",
        "SECTION B: SPACE PROPULSION AND ASTRODYNAMICS",
        "Number of Questions: 3 | Marking: Correct +4, Incorrect 0, Unanswered 0",
        "For dropped questions, full marks will be awarded to all candidates."
    ].join("\n");

    const qpBuf = buildSimplePdf(qpText);
    const akBuf = buildSimplePdf(akText);
    const pfBuf = buildSimplePdf(pfText);

    let syntheticUirDoc = null;
    let ingestionManifest = null;

    describe("1. End-to-End Document Ingestion to UIR v3.0 Transformation", () => {
        it("1.1 successfully processes three synthetic PDFs and transforms to UIR v3.0 without hardcoded heuristics", async () => {
            const result = await UIRTransformationService.transformDocuments({
                questionPaper: qpBuf,
                answerKey: akBuf,
                paperFormat: pfBuf
            }, {
                examId: "synthetic-arseo-2026",
                examTitle: "Synthetic Advanced Robotics & Space Engineering Olympiad 2026",
                year: 2026,
                approvalStatus: UIR_APPROVAL_STATUS.APPROVED
            });

            assert.ok(result);
            assert.ok(result.uirDocument);
            assert.equal(result.validation.isValid, true);
            assert.deepEqual(result.validation.errors, []);

            syntheticUirDoc = result.uirDocument;
            ingestionManifest = result.ingestionManifest;
        });

        it("1.2 preserves complete exam metadata and source document provenance", () => {
            const meta = syntheticUirDoc.examMetadata;
            assert.equal(meta.examId, "synthetic-arseo-2026");
            assert.equal(meta.examTitle, "Synthetic Advanced Robotics & Space Engineering Olympiad 2026");
            assert.equal(meta.year, 2026);
            assert.equal(meta.durationSeconds, 3600);
            assert.equal(meta.totalQuestions, 7);
            assert.equal(meta.maximumMarks, 28);
            assert.equal(meta.approvalStatus, UIR_APPROVAL_STATUS.APPROVED);
            assert.equal(syntheticUirDoc.schemaVersion, UIR_SCHEMA_VERSION);

            assert.equal(meta.sourceDocuments.length, 3);
            assert.ok(meta.sourceDocuments.some(d => d.type === "question_paper"));
            assert.ok(meta.sourceDocuments.some(d => d.type === "answer_key"));
            assert.ok(meta.sourceDocuments.some(d => d.type === "paper_format"));
        });

        it("1.3 reconciles multi-section hierarchy with distinct section-wise marking schemes", () => {
            assert.equal(syntheticUirDoc.sections.length, 2);

            const secA = syntheticUirDoc.sections[0];
            assert.equal(secA.sectionId, "sec_1");
            assert.ok(secA.sectionName.includes("ROBOTICS"));
            assert.equal(secA.questionCount, 4);
            assert.equal(secA.scoringRules.positiveMarks, 4);
            assert.equal(secA.scoringRules.negativeMarks, -1);
            assert.equal(secA.scoringRules.unansweredMarks, 0);
            assert.deepEqual(secA.scoringRules.positiveMarksRational, { num: "4", den: "1" });
            assert.deepEqual(secA.scoringRules.negativeMarksRational, { num: "-1", den: "1" });

            const secB = syntheticUirDoc.sections[1];
            assert.equal(secB.sectionId, "sec_2");
            assert.ok(secB.sectionName.includes("SPACE PROPULSION"));
            assert.equal(secB.questionCount, 3);
            assert.equal(secB.scoringRules.positiveMarks, 4);
            assert.equal(secB.scoringRules.negativeMarks, 0);
            assert.equal(secB.scoringRules.unansweredMarks, 0);
            assert.deepEqual(secB.scoringRules.negativeMarksRational, { num: "0", den: "1" });
        });

        it("1.4 extracts and reconciles diverse question types (MCQ, NAT with Range, Dropped, MSQ)", () => {
            const questions = syntheticUirDoc.questions;
            assert.equal(questions.length, 7);

            // Q1: Standard MCQ
            assert.equal(questions[0].questionNumber, 1);
            assert.equal(questions[0].questionType, UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ);
            assert.equal(questions[0].options.length, 4);
            assert.equal(questions[0].correctAnswer.acceptedAnswers[0], "B");
            assert.equal(questions[0].scoring.negativeMarks, -1);

            // Q2: MCQ with Diagram reference
            assert.equal(questions[1].questionNumber, 2);
            assert.equal(questions[1].questionType, UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ);
            assert.ok(questions[1].stem.text.includes("Figure 1"));

            // Q5: Dropped / Bonus question
            assert.equal(questions[4].questionNumber, 5);
            assert.equal(questions[4].correctAnswer.isDropped, true);
            assert.equal(questions[4].correctAnswer.isBonus, true);

            // Q6: Numerical NAT with Range
            assert.equal(questions[5].questionNumber, 6);
            assert.equal(questions[5].questionType, UIR_QUESTION_TYPES.NUMERICAL_NAT);
            assert.equal(questions[5].correctAnswer.answerType, UIR_ANSWER_TYPES.NUMERICAL_RANGE);
            assert.equal(questions[5].correctAnswer.numericRange.min, 11.1);
            assert.equal(questions[5].correctAnswer.numericRange.max, 11.3);

            // Q7: Multi-Select MSQ
            assert.equal(questions[6].questionNumber, 7);
            assert.equal(questions[6].questionType, UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ);
            assert.deepEqual(questions[6].correctAnswer.acceptedAnswers, ["A", "C"]);
            assert.equal(questions[6].scoring.negativeMarks, 0);
        });
    });

    describe("2. Lossless JSON Roundtrip & Structural Invariance", () => {
        it("2.1 serializes to JSON and deserializes with zero loss of questions, answers, sections, rules, diagrams, provenance", () => {
            const serialized = JSON.stringify(syntheticUirDoc, null, 2);
            assert.ok(serialized.length > 500);

            const deserialized = JSON.parse(serialized);

            // Verify strict validation on deserialized object
            const validation = UIRValidator.validate(deserialized);
            assert.equal(validation.isValid, true);
            assert.deepEqual(validation.errors, []);

            // Deep field-by-field equality checks
            assert.equal(deserialized.schemaVersion, syntheticUirDoc.schemaVersion);
            assert.deepEqual(deserialized.examMetadata, syntheticUirDoc.examMetadata);
            assert.deepEqual(deserialized.sections, syntheticUirDoc.sections);
            assert.deepEqual(deserialized.scoringConfig, syntheticUirDoc.scoringConfig);
            assert.equal(deserialized.questions.length, syntheticUirDoc.questions.length);

            for (let i = 0; i < syntheticUirDoc.questions.length; i++) {
                const orig = syntheticUirDoc.questions[i];
                const round = deserialized.questions[i];

                assert.equal(round.questionId, orig.questionId);
                assert.equal(round.questionNumber, orig.questionNumber);
                assert.equal(round.questionType, orig.questionType);
                assert.deepEqual(round.stem, orig.stem);
                assert.deepEqual(round.options, orig.options);
                assert.deepEqual(round.correctAnswer, orig.correctAnswer);
                assert.deepEqual(round.scoring, orig.scoring);
                assert.deepEqual(round.sourceReference, orig.sourceReference);
            }
        });
    });

    describe("3. Downstream Universal Scoring Engine Compatibility", () => {
        it("3.1 translates UIR v3.0 to scoring payload and evaluates attempt with exact rational arithmetic", () => {
            const studentAnswers = {
                "synthetic-arseo-2026_q_1": "B",     // Correct Section A (+4)
                "synthetic-arseo-2026_q_2": "B",     // Incorrect Section A (-1)
                "synthetic-arseo-2026_q_3": "A",     // Correct Section A (+4)
                "synthetic-arseo-2026_q_4": null,    // Unanswered Section A (0)
                "synthetic-arseo-2026_q_5": "999",   // Dropped question Section B (+4)
                "synthetic-arseo-2026_q_6": "11.2",  // Numerical NAT in range [11.1, 11.3] (+4)
                "synthetic-arseo-2026_q_7": ["A", "C"] // MSQ both correct Section B (+4)
            };

            const scoringPayload = UIRToScoringAdapter.toScoringPayload(syntheticUirDoc, studentAnswers);
            assert.equal(scoringPayload.questions.length, 7);
            assert.equal(scoringPayload.answerKeys.length, 7);
            assert.equal(scoringPayload.examProfile.examId, "synthetic-arseo-2026");

            const evalResult = UniversalScoringEngine.evaluateAttempt(scoringPayload);

            // Expected calculation:
            // Q1: +4
            // Q2: -1 (Total: 3)
            // Q3: +4 (Total: 7)
            // Q4: 0  (Total: 7)
            // Q5: +4 (Total: 11 - Dropped question awarded full marks)
            // Q6: +4 (Total: 15 - 11.2 within [11.1, 11.3])
            // Q7: +4 (Total: 19 - MSQ exact match A, C)
            assert.equal(evalResult.totalScore, 19);
            assert.equal(evalResult.rationalScore.num, 19n);
            assert.equal(evalResult.rationalScore.den, 1n);
            assert.equal(evalResult.correctCount, 4);
            assert.equal(evalResult.incorrectCount, 1);
            assert.equal(evalResult.unansweredCount, 1);
            assert.equal(evalResult.droppedCount, 1);

            // Verify Section B zero-negative marking enforcement
            const secBAnswersWrong = {
                "synthetic-arseo-2026_q_6": "99.9", // Incorrect NAT in Section B (penalty must be 0)
                "synthetic-arseo-2026_q_7": ["B"]    // Incorrect MSQ in Section B (penalty must be 0)
            };
            const evalWrongB = UniversalScoringEngine.evaluateAttempt(
                UIRToScoringAdapter.toScoringPayload(syntheticUirDoc, secBAnswersWrong)
            );
            const q6Eval = evalWrongB.breakdown.find(b => b.questionId === "synthetic-arseo-2026_q_6");
            const q7Eval = evalWrongB.breakdown.find(b => b.questionId === "synthetic-arseo-2026_q_7");
            assert.equal(q6Eval.marksAwarded, 0);
            assert.equal(q7Eval.marksAwarded, 0);
        });
    });

    describe("4. Legacy Scoring Adapter Integration", () => {
        it("4.1 converts UIR v3.0 to legacy attempt payload and scores attempt successfully", () => {
            const studentAnswers = {
                "1": "B",
                "2": "A",
                "3": "A",
                "4": "C"
            };

            const legacyPayload = UIRToLegacyAdapter.toLegacyAttemptPayload(syntheticUirDoc, studentAnswers);
            assert.ok(legacyPayload.questions);
            assert.equal(legacyPayload.questions.length, 7);

            const legacyEval = LegacyScoringAdapter.evaluateAttempt(legacyPayload);
            assert.ok(legacyEval);
            assert.equal(legacyEval.totalScore >= 16, true);
        });
    });

    describe("5. Firestore Storage Adapter & Backward Reconstruction", () => {
        it("5.1 converts UIR v3.0 to MockTestService Firestore documents", () => {
            const { mockTestDoc, mockQuestionDocs } = UIRToMockTestAdapter.toFirestoreDocuments(syntheticUirDoc);

            assert.equal(mockTestDoc.testId, "synthetic-arseo-2026");
            assert.equal(mockTestDoc.durationSeconds, 3600);
            assert.equal(mockTestDoc.totalQuestions, 7);
            assert.equal(mockTestDoc.maximumMarks, 28);
            assert.equal(mockTestDoc.status, "published");
            assert.equal(mockTestDoc.schemaVersion, "3.0.0");
            assert.equal(mockTestDoc.sections.length, 2);

            assert.equal(mockQuestionDocs.length, 7);
            assert.equal(mockQuestionDocs[0].questionId, "synthetic-arseo-2026_q_1");
            assert.equal(mockQuestionDocs[0].options.length, 4);
        });

        it("5.2 reconstructs a strictly valid UIR v3.0 document from legacy Firestore records", () => {
            const { mockTestDoc, mockQuestionDocs } = UIRToMockTestAdapter.toFirestoreDocuments(syntheticUirDoc);
            const scoringPayload = UIRToScoringAdapter.toScoringPayload(syntheticUirDoc);

            const reconstructedUIR = LegacyToUIRAdapter.fromFirestoreDocuments(
                mockTestDoc,
                mockQuestionDocs,
                scoringPayload.answerKeys
            );

            assert.ok(reconstructedUIR);
            const validation = UIRValidator.validate(reconstructedUIR);
            assert.equal(validation.isValid, true);
            assert.deepEqual(validation.errors, []);
            assert.equal(reconstructedUIR.questions.length, 7);
            assert.equal(reconstructedUIR.sections.length, 2);
        });
    });

    describe("6. Strict Schema Validation Gate & Adversarial Error Invariance", () => {
        it("6.1 rejects duplicate question IDs", () => {
            const badDoc = JSON.parse(JSON.stringify(syntheticUirDoc));
            badDoc.questions[1].questionId = badDoc.questions[0].questionId; // Duplicate!

            const res = UIRValidator.validate(badDoc);
            assert.equal(res.isValid, false);
            assert.ok(res.errors.some(e => e.includes("Duplicate questionId")));
            assert.throws(() => UIRValidator.validateOrThrow(badDoc), /Duplicate questionId/);
        });

        it("6.2 rejects questions referencing non-existent section IDs", () => {
            const badDoc = JSON.parse(JSON.stringify(syntheticUirDoc));
            badDoc.questions[0].sectionId = "non_existent_section";

            const res = UIRValidator.validate(badDoc);
            assert.equal(res.isValid, false);
            assert.ok(res.errors.some(e => e.includes("references nonexistent sectionId")));
        });

        it("6.3 rejects questions with accepted answers not present in declared options", () => {
            const badDoc = JSON.parse(JSON.stringify(syntheticUirDoc));
            badDoc.questions[0].correctAnswer.acceptedAnswers = ["Z"]; // Option Z does not exist!

            const res = UIRValidator.validate(badDoc);
            assert.equal(res.isValid, false);
            assert.ok(res.errors.some(e => e.includes("does not exist in declared options")));
        });

        it("6.4 rejects negative or non-finite duration and marks", () => {
            const badDoc = JSON.parse(JSON.stringify(syntheticUirDoc));
            badDoc.examMetadata.durationSeconds = -300;
            badDoc.examMetadata.maximumMarks = NaN;

            const res = UIRValidator.validate(badDoc);
            assert.equal(res.isValid, false);
            assert.ok(res.errors.some(e => e.includes("durationSeconds")));
            assert.ok(res.errors.some(e => e.includes("maximumMarks")));
        });

        it("6.5 refuses publication approval for questions with unverified content corruption", () => {
            const badDoc = JSON.parse(JSON.stringify(syntheticUirDoc));
            badDoc.examMetadata.approvalStatus = UIR_APPROVAL_STATUS.APPROVED;
            badDoc.questions[0].qualityFlags.contentCorruptionDetected = true;
            badDoc.questions[0].qualityFlags.manualVerificationCompleted = false;

            const res = UIRValidator.validate(badDoc);
            assert.equal(res.isValid, false);
            assert.ok(res.errors.some(e => e.includes("requires manual verification before approval")));
        });
    });
});
