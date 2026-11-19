import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { DiagramExtractionService, encodePng } from "../server/services/admin/diagramExtractionService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

test("Comprehensive Hybrid Question & Diagram Extraction Verification Suite", async (t) => {
    process.env.NODE_ENV = "test";
    process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

    // ============================================================
    // TEST 1: PURE-JS PNG ENCODER CAPABILITIES (ZERO BINARY DEPS)
    // ============================================================
    await t.test("1. Pure-JS PNG Encoder produces valid standard PNG files across channel formats", () => {
        // Test 1A: 4-channel RGBA buffer
        const rgbaWidth = 8;
        const rgbaHeight = 8;
        const rgbaBuf = Buffer.alloc(rgbaWidth * rgbaHeight * 4, 180);
        const pngRgba = encodePng(rgbaWidth, rgbaHeight, rgbaBuf, 4);

        assert.ok(Buffer.isBuffer(pngRgba), "Must return a Node Buffer");
        // PNG magic number: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
        assert.equal(pngRgba[0], 0x89);
        assert.equal(pngRgba[1], 0x50); // P
        assert.equal(pngRgba[2], 0x4E); // N
        assert.equal(pngRgba[3], 0x47); // G
        assert.ok(pngRgba.includes(Buffer.from("IHDR")), "Must contain IHDR chunk");
        assert.ok(pngRgba.includes(Buffer.from("IDAT")), "Must contain IDAT compressed chunk");
        assert.ok(pngRgba.includes(Buffer.from("IEND")), "Must contain IEND terminator chunk");

        // Test 1B: 3-channel RGB buffer
        const rgbBuf = Buffer.alloc(4 * 4 * 3, 220);
        const pngRgb = encodePng(4, 4, rgbBuf, 3);
        assert.equal(pngRgb[0], 0x89);
        assert.ok(pngRgb.includes(Buffer.from("IHDR")));

        // Test 1C: 1-channel Grayscale buffer
        const grayBuf = Buffer.alloc(4 * 4, 100);
        const pngGray = encodePng(4, 4, grayBuf, 1);
        assert.equal(pngGray[0], 0x89);
        assert.ok(pngGray.includes(Buffer.from("IHDR")));

        // Test 1D: Invalid dimensions throw helpful error
        assert.throws(() => encodePng(0, 0, grayBuf, 1), /Invalid dimensions/);
    });

    // ============================================================
    // TEST 2: MULTI-FORMAT OPTION EXTRACTION (A-E, 1-5, HORIZONTAL)
    // ============================================================
    await t.test("2. Multi-Format Option Extraction handles all standard exam formats", () => {
        // Format A: Standard parenthesized letters (A) to (D)
        const formatA = "Which of the following is a scalar quantity?\n(A) Force\n(B) Velocity\n(C) Energy\n(D) Acceleration";
        const resA = QuestionNormalizationService.parseQuestionOptions(formatA);
        assert.equal(resA.options.length, 4);
        assert.equal(resA.options[0].label, "A");
        assert.equal(resA.options[0].text, "Force");
        assert.equal(resA.options[2].label, "C");
        assert.equal(resA.options[2].text, "Energy");

        // Format B: Parenthesized numbers (1) to (4)
        const formatB = "Find the momentum of a 2 kg object moving at 5 m/s:\n(1) 10 kg m/s\n(2) 20 kg m/s\n(3) 5 kg m/s\n(4) 15 kg m/s";
        const resB = QuestionNormalizationService.parseQuestionOptions(formatB);
        assert.equal(resB.options.length, 4);
        assert.equal(resB.options[0].id, "1");
        assert.equal(resB.options[0].label, "1");
        assert.equal(resB.options[0].text, "10 kg m/s");

        // Format C: Horizontal options on single line
        const formatC = "The roots of the equation x^2 - 5x + 6 = 0 are:\n(A) 2, 3    (B) 1, 6    (C) -2, -3    (D) -1, -6";
        const resC = QuestionNormalizationService.parseQuestionOptions(formatC);
        assert.equal(resC.options.length, 4);
        assert.equal(resC.options[0].text, "2, 3");
        assert.equal(resC.options[1].text, "1, 6");
        assert.equal(resC.options[3].text, "-1, -6");

        // Format D: Dot letters A. to D.
        const formatD = "Choose the correct spelling:\nA. Accommodation\nB. Accomodation\nC. Acommodation\nD. Acomodation";
        const resD = QuestionNormalizationService.parseQuestionOptions(formatD);
        assert.equal(resD.options.length, 4);
        assert.equal(resD.options[0].label, "A");
        assert.equal(resD.options[0].text, "Accommodation");

        // Format E: Paren-close letters A) to D)
        const formatE = "What is the capital of India?\nA) Mumbai\nB) New Delhi\nC) Kolkata\nD) Chennai";
        const resE = QuestionNormalizationService.parseQuestionOptions(formatE);
        assert.equal(resE.options.length, 4);
        assert.equal(resE.options[1].label, "B");
        assert.equal(resE.options[1].text, "New Delhi");

        // Format F: 5-option exam (A to E)
        const formatF = "In banking exams, 5 options are standard:\n(A) Option 1 (B) Option 2 (C) Option 3 (D) Option 4 (E) Option 5";
        const resF = QuestionNormalizationService.parseQuestionOptions(formatF);
        assert.equal(resF.options.length, 5);
        assert.equal(resF.options[4].label, "E");
        assert.equal(resF.options[4].id, "5");
    });

    // ============================================================
    // TEST 3: NUMBERED STATEMENTS VS QUESTION BOUNDARIES (DEFECT FIX)
    // ============================================================
    await t.test("3. Numbered statements (1. and 2.) inside questions do NOT trigger phantom question splits", () => {
        // Construct a question text that contains numbered statements inside its stem
        const statementQuestion = `Q. 18 Consider the following two statements:
1. All alkali metals react vigorously with water.
2. Lithium is the least dense solid element.
Which of the statements given above is/are correct?
(A) 1 only
(B) 2 only
(C) Both 1 and 2
(D) Neither 1 nor 2`;

        const parsed = QuestionNormalizationService.parseQuestionOptions(statementQuestion);
        assert.equal(parsed.options.length, 4);
        assert.ok(parsed.questionText.includes("1. All alkali metals"), "Statement 1 must be part of question stem");
        assert.ok(parsed.questionText.includes("2. Lithium is the least dense"), "Statement 2 must be part of question stem");
        assert.equal(parsed.options[0].text, "1 only");
        assert.equal(parsed.options[2].text, "Both 1 and 2");
    });

    // ============================================================
    // TEST 4: NUMERICAL (NAT) QUESTION CLASSIFICATION & 0-OPTION GATE
    // ============================================================
    await t.test("4. Numerical (NAT) questions are correctly classified and pass validation with options: []", () => {
        // Question A: Explicit calculation / numerical value
        const fidelityNat = QuestionNormalizationService.evaluateQuestionFidelity({
            questionText: "A 5 kg block slides down an incline with acceleration 2 m/s^2. Calculate the net force in Newtons.",
            options: [],
            questionType: "numerical",
            hasDiagram: false
        });

        // Crucial requirement: NAT questions with options: [] MUST BE VALID!
        assert.equal(fidelityNat.validationStatus, "valid", "NAT questions with options: [] must evaluate as valid");
        assert.equal(fidelityNat.flagReason, null, "NAT questions must not have missing option flag");

        // Question B: Standard MCQ with fewer than 2 options MUST be flagged
        const fidelityBrokenMcq = QuestionNormalizationService.evaluateQuestionFidelity({
            questionText: "What is the charge of an electron?",
            options: [{ id: "1", label: "A", text: "-1.6e-19 C" }],
            questionType: "mcq",
            hasDiagram: false
        });
        assert.equal(fidelityBrokenMcq.validationStatus, "flagged", "MCQ with 1 option must be flagged");
        assert.ok(fidelityBrokenMcq.flagReason.includes("only 1 options parsed"), "Must mention broken option count");
    });

    // ============================================================
    // TEST 5: SHORT ENGLISH QUESTIONS PRESERVED
    // ============================================================
    await t.test("5. Concise English / Math questions (>= 5 chars) with valid options are not falsely flagged", () => {
        const shortQ = QuestionNormalizationService.evaluateQuestionFidelity({
            questionText: "Select the antonym of 'Vague':",
            options: [
                { id: "1", label: "A", text: "Clear" },
                { id: "2", label: "B", text: "Obscure" },
                { id: "3", label: "C", text: "Dim" },
                { id: "4", label: "D", text: "Shadowy" }
            ],
            questionType: "mcq",
            hasDiagram: false
        });

        assert.equal(shortQ.validationStatus, "valid", "Short English vocabulary question must be valid");
        assert.equal(shortQ.flagReason, null);
    });

    // ============================================================
    // TEST 6: DIAGRAM ASSOCIATION & MEDIA LINKING
    // ============================================================
    await t.test("6. DiagramExtractionService associates diagrams with questions and provides structured metadata", () => {
        const mockQuestions = [
            {
                questionId: "test-q1",
                questionNumber: 1,
                sourcePage: 2,
                hasDiagram: true,
                questionText: "In the circuit diagram shown in figure below, find the current through R1.",
                options: [
                    { id: "1", label: "A", text: "1 A" },
                    { id: "2", label: "B", text: "2 A" }
                ],
                media: []
            },
            {
                questionId: "test-q2",
                questionNumber: 2,
                sourcePage: 2,
                hasDiagram: false,
                questionText: "Which gas is evolved when zinc reacts with dilute sulfuric acid?",
                options: [
                    { id: "1", label: "A", text: "Hydrogen" },
                    { id: "2", label: "B", text: "Oxygen" }
                ],
                media: []
            }
        ];

        const mockDiagrams = [
            {
                diagramId: "diag_test_p2_img1",
                id: "diag_test_p2_img1",
                pageNumber: 2,
                type: "raster_image",
                width: 400,
                height: 250,
                bbox: [50, 200, 400, 250],
                filename: "diag_test_p2_img1.png",
                localPath: path.join(rootDir, "uploads/vault/diagrams/test.png"),
                remoteUrl: "https://res.cloudinary.com/demo/image/upload/diag_test_p2_img1.png"
            }
        ];

        const enriched = DiagramExtractionService.associateDiagramsWithQuestions({
            questions: mockQuestions,
            diagrams: mockDiagrams,
            jobId: "test_job_123"
        });

        assert.equal(enriched.length, 2);
        // Q1 references diagram -> should be enriched with diagram asset
        const q1 = enriched[0];
        assert.equal(q1.hasDiagram, true);
        assert.equal(q1.diagramId, "diag_test_p2_img1");
        assert.equal(q1.diagramUrl, "https://res.cloudinary.com/demo/image/upload/diag_test_p2_img1.png");
        assert.ok(q1.media.length >= 1);
        assert.equal(q1.media[0].type, "diagram");
        assert.equal(q1.media[0].width, 400);

        // Q2 has no diagram -> hasDiagram remains false
        const q2 = enriched[1];
        assert.equal(q2.hasDiagram, false);
    });

    // ============================================================
    // TEST 7: ANSWER KEY RECONCILIATION SYNCHRONIZES NUMERICAL NAT
    // ============================================================
    await t.test("7. AnswerKeyReconciliationService synchronizes numerical question types when answer key specifies numerical answers", () => {
        const questions = [
            {
                questionId: "sync-q21",
                questionNumber: 21,
                questionType: "mcq", // Initially misclassified as MCQ by parser
                options: [], // 0 options parsed
                hasDiagram: false
            }
        ];

        const answerMap = new Map();
        // Answer key states answer for Q21 is "225" (numerical value)
        answerMap.set(21, {
            answerType: "numerical",
            correctOptionIds: [],
            acceptedAnswers: ["225"],
            isDropped: false,
            rawString: "225"
        });

        const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
            questions,
            answerMap,
            sourceReference: "Official Key",
            keyMetadata: { isOfficialKey: true }
        });

        // Question type must have been synchronized to 'numerical'
        assert.equal(questions[0].questionType, "numerical", "Must synchronize misclassified question to numerical");
        assert.equal(reconciliation.reconciledKeys[0].answerType, "numerical");
        assert.equal(reconciliation.reconciledKeys[0].acceptedAnswers[0], "225");
        assert.equal(reconciliation.conflicts.length, 0, "No scoring conflicts generated");
    });

    // ============================================================
    // TEST 8: PIPELINE DISCREPANCY CLASSIFICATION EXEMPTS NAT
    // ============================================================
    await t.test("8. ImportJobPipelineService discrepancy classification does NOT block numerical questions with options: []", () => {
        const mockJob = {
            jobId: "test_job_disc",
            sourceDocuments: {
                questionPaper: { hash: "qp_hash_123" },
                answerKey: { hash: "ak_hash_123" },
                examPattern: { hash: "ep_hash_123" }
            },
            sourceHashes: {
                questionPaper: "qp_hash_123",
                answerKey: "ak_hash_123",
                examPattern: "ep_hash_123"
            },
            draftPackage: {
                questions: [
                    {
                        questionId: "disc-q1",
                        questionNumber: 1,
                        questionType: "mcq",
                        questionText: "What is the unit of force?",
                        options: [
                            { id: "1", label: "A", text: "Newton" },
                            { id: "2", label: "B", text: "Joule" }
                        ],
                        validationStatus: "valid"
                    },
                    {
                        questionId: "disc-q21",
                        questionNumber: 21,
                        questionType: "numerical",
                        questionText: "Calculate the acceleration in m/s^2 when force is 10 N and mass is 2 kg.",
                        options: [], // 0 options is completely valid for numerical questions!
                        validationStatus: "valid"
                    }
                ],
                answerKeys: [
                    {
                        questionId: "disc-q1",
                        questionNumber: 1,
                        answerType: "single_choice",
                        correctOptionIds: ["1"],
                        verificationStatus: "verified"
                    },
                    {
                        questionId: "disc-q21",
                        questionNumber: 21,
                        answerType: "numerical",
                        acceptedAnswers: ["5"],
                        verificationStatus: "verified"
                    }
                ],
                examConfig: {
                    totalQuestions: 2,
                    durationMinutes: 60,
                    markingScheme: { correct: 4, incorrect: -1 }
                }
            }
        };

        // Compute validation fingerprint for job
        const fp = ImportJobPipelineService.computeValidationFingerprint({
            questions: mockJob.draftPackage.questions,
            answerKeys: mockJob.draftPackage.answerKeys,
            examConfig: mockJob.draftPackage.examConfig
        });
        mockJob.validationFingerprint = fp;
        mockJob.validationReport = { validatedFingerprint: fp };

        const classification = ImportJobPipelineService.classifyDiscrepancies(mockJob);

        // Crucial assertion: Must have 0 mandatory blockers!
        const brokenMcqBlocker = classification.mandatoryBlockers.find(b => b.id === "broken_mcq_options");
        assert.equal(brokenMcqBlocker, undefined, "NAT question with options: [] must NEVER trigger broken_mcq_options blocker");
        assert.equal(classification.mandatoryBlockers.length, 0, "No fatal blockers should exist");
    });

    // ============================================================
    // TEST 9: VECTOR DIAGRAM EXTRACTION & SVG GENERATION FALLBACK
    // ============================================================
    await t.test("9. Vector diagram extraction converts PDF vector paths into standalone SVG assets in vault", async () => {
        const vaultDir = path.join(rootDir, "uploads/vault");
        const qpFiles = fs.readdirSync(vaultDir).filter(f => f.includes("JEE_Main_21_Jan_2026_Shift_1.pdf"));
        if (qpFiles.length > 0) {
            const buf = fs.readFileSync(path.join(vaultDir, qpFiles[0]));
            const diagrams = await DiagramExtractionService.extractDiagrams({
                pdfBuffer: buf,
                jobId: "vector_audit_test"
            });

            const vectorDiags = diagrams.filter(d => d.type === "vector_diagram");
            assert.ok(vectorDiags.length >= 1, "Must extract at least one vector diagram asset from vector-dense pages");

            const sampleVec = vectorDiags[0];
            assert.ok(sampleVec.filename.endsWith(".svg"), "Vector diagram filename must have .svg extension");
            assert.equal(sampleVec.hasBuffer, true, "Vector diagram asset must be generated with buffer");
            assert.ok(fs.existsSync(sampleVec.localPath), "Vector SVG file must exist on disk in diagrams vault");

            const svgContent = fs.readFileSync(sampleVec.localPath, "utf8");
            assert.ok(svgContent.includes("<svg"), "Must be valid XML/SVG markup");
            assert.ok(svgContent.includes("<path"), "Must contain rendered path geometry");
            assert.ok(svgContent.includes("viewBox="), "Must contain responsive SVG viewBox preserving aspect ratio");
        }
    });

    // ============================================================
    // TEST 10: DIAGRAM-ONLY OPTIONS & FAIL-CLOSED SAFEGUARDS
    // ============================================================
    await t.test("10. Diagram-only options: associates diagrams with options and fails closed on unverified placeholders", () => {
        // 10A: Options with diagram text are flagged for manual visual review
        const qWithDiagramOpts = {
            questionText: "Identify product X in the reaction sequence:",
            options: [
                { id: "1", label: "A", text: "[Diagram / Structure in source PDF]" },
                { id: "2", label: "B", text: "[Diagram / Structure in source PDF]" },
                { id: "3", label: "C", text: "[Diagram / Structure in source PDF]" },
                { id: "4", label: "D", text: "[Diagram / Structure in source PDF]" }
            ],
            questionType: "mcq",
            hasDiagram: true
        };

        const fid = QuestionNormalizationService.evaluateQuestionFidelity(qWithDiagramOpts);
        assert.equal(fid.validationStatus, "flagged", "Questions with diagram placeholder options must be flagged");
        assert.ok(fid.flagReason.includes("visual diagrams/structures"), "Flag reason must request administrator visual verification");

        // 10B: Unmapped diagram placeholder options without visual assets trigger fatal blocker in classifyDiscrepancies
        const mockJobUnmapped = {
            jobId: "unmapped_opt_job",
            sourceDocuments: {
                questionPaper: { hash: "qp1" },
                answerKey: { hash: "ak1" },
                examPattern: { hash: "ep1" }
            },
            sourceHashes: { questionPaper: "qp1", answerKey: "ak1", examPattern: "ep1" },
            draftPackage: {
                questions: [{
                    questionId: "q_unmapped",
                    questionNumber: 5,
                    questionType: "mcq",
                    questionText: "Identify the correct organic isomer:",
                    options: [
                        { id: "1", label: "A", text: "[Diagram / Structure in source PDF]" },
                        { id: "2", label: "B", text: "[Diagram / Structure in source PDF]" }
                    ],
                    media: [],
                    validationStatus: "flagged"
                }],
                answerKeys: [{
                    questionId: "q_unmapped",
                    questionNumber: 5,
                    answerType: "single_choice",
                    correctOptionIds: ["1"],
                    verificationStatus: "verified"
                }],
                examConfig: { totalQuestions: 1, durationMinutes: 30, markingScheme: { correct: 4, incorrect: -1 } }
            }
        };

        const fp = ImportJobPipelineService.computeValidationFingerprint({
            questions: mockJobUnmapped.draftPackage.questions,
            answerKeys: mockJobUnmapped.draftPackage.answerKeys,
            examConfig: mockJobUnmapped.draftPackage.examConfig
        });
        mockJobUnmapped.validationFingerprint = fp;
        mockJobUnmapped.validationReport = { validatedFingerprint: fp };

        const classification = ImportJobPipelineService.classifyDiscrepancies(mockJobUnmapped);
        const unresolvedBlocker = classification.mandatoryBlockers.find(b => b.code === "UNRESOLVED_DIAGRAM_OPTIONS");
        assert.ok(unresolvedBlocker, "Must create fatal blocker for unmapped diagram options lacking assets");
        assert.equal(classification.canPublish, false, "Publication must be blocked");
    });

    // ============================================================
    // TEST 11: ENGLISH AND NUMERICAL QUESTION TYPE DIVERSITY
    // ============================================================
    await t.test("11. Zero valid English and numerical question types omitted across diversity patterns", () => {
        const patterns = [
            {
                name: "Sentence completion",
                input: "Complete the sentence:\nHer presentation was so _______ that everyone was convinced.\n(A) articulate\n(B) ambiguous\n(C) abrasive\n(D) archaic",
                optsExpected: 4,
                firstText: "articulate"
            },
            {
                name: "Antonyms / Synonyms",
                input: "Choose the antonym of ALACRITY:\n(1) Sluggishness\n(2) Eagerness\n(3) Keenness\n(4) Promptness",
                optsExpected: 4,
                firstText: "Sluggishness"
            },
            {
                name: "Basic arithmetic",
                input: "Evaluate the expression: 48 / (6 + 2) * 3\n(A) 18\n(B) 2\n(C) 12\n(D) 24",
                optsExpected: 4,
                firstText: "18"
            },
            {
                name: "Pure numbers & squares",
                input: "Which number is a prime number?\n(A) 91\n(B) 97\n(C) 119\n(D) 133",
                optsExpected: 4,
                firstText: "91"
            },
            {
                name: "Fractions & decimals",
                input: "Simplify the fraction: 7/12 + 5/18\n(A) 31/36\n(B) 29/36\n(C) 1/2\n(D) 12/30",
                optsExpected: 4,
                firstText: "31/36"
            },
            {
                name: "Physical formulas",
                input: "The capacitance of a parallel plate capacitor is given by:\n(A) ε₀A / d\n(B) ε₀d / A\n(C) A / (ε₀d)\n(D) ε₀ / (Ad)",
                optsExpected: 4,
                firstText: "ε₀A / d"
            }
        ];

        for (const p of patterns) {
            const parsed = QuestionNormalizationService.parseQuestionOptions(p.input);
            assert.equal(parsed.options.length, p.optsExpected, `${p.name} must extract ${p.optsExpected} options`);
            assert.equal(parsed.options[0].text, p.firstText, `${p.name} first option must match`);
            const fid = QuestionNormalizationService.evaluateQuestionFidelity({
                questionText: parsed.questionText,
                options: parsed.options,
                questionType: "mcq"
            });
            assert.equal(fid.validationStatus, "valid", `${p.name} must evaluate as valid with 0 false flags`);
        }
    });

    // ============================================================
    // TEST 12: DETERMINISTIC SCORING ACROSS MCQ, MSQ, AND NAT
    // ============================================================
    await t.test("12. MockTestScoringService executes deterministic scoring for MCQ, MSQ, and NAT", () => {
        const testQuestions = [
            { questionId: "q_mcq_1", questionNumber: 1, questionType: "mcq", subject: "Physics" },
            { questionId: "q_msq_1", questionNumber: 2, questionType: "msq", subject: "Physics" },
            { questionId: "q_nat_int", questionNumber: 3, questionType: "numerical", subject: "Mathematics" },
            { questionId: "q_nat_dec", questionNumber: 4, questionType: "numerical", subject: "Mathematics" },
            { questionId: "q_nat_neg", questionNumber: 5, questionType: "numerical", subject: "Chemistry" },
            { questionId: "q_nat_tol", questionNumber: 6, questionType: "numerical", subject: "Chemistry" }
        ];

        const testKeys = [
            { questionId: "q_mcq_1", answerType: "single_choice", correctOptionIds: ["2"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "q_msq_1", answerType: "msq", correctOptionIds: ["1", "3", "4"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "q_nat_int", answerType: "numerical", acceptedAnswers: ["1333"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "q_nat_dec", answerType: "numerical", acceptedAnswers: ["120.20"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "q_nat_neg", answerType: "numerical", acceptedAnswers: ["-15"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "q_nat_tol", answerType: "numerical", acceptedAnswers: ["50.0"], numericTolerance: 0.5, marksAwarded: 4, marksDeducted: 1 }
        ];

        // Scenario A: Full marks across all types (+24 marks)
        const studentAnswersA = {
            q_mcq_1: "2",
            q_msq_1: ["1", "3", "4"], // Array input matching MSQ
            q_nat_int: "1333",
            q_nat_dec: "120.2",       // Decimal equivalence: 120.2 === 120.20
            q_nat_neg: "-15.0",       // Negative decimal equivalence
            q_nat_tol: "49.8"         // Within numeric tolerance: |49.8 - 50.0| = 0.2 <= 0.5
        };

        const resultA = MockTestScoringService.evaluateAttempt({
            questions: testQuestions,
            answerKeys: testKeys,
            studentAnswers: studentAnswersA
        });

        assert.equal(resultA.totalScore, 24, "All 6 correct questions must yield 24 marks");
        assert.equal(resultA.correctCount, 6);
        assert.equal(resultA.incorrectCount, 0);
        assert.equal(resultA.accuracyPercent, 100);

        // Scenario B: Partial MSQ and incorrect NAT
        const studentAnswersB = {
            q_mcq_1: "1",            // Incorrect MCQ (-1)
            q_msq_1: ["1", "3"],     // Partial MSQ (missing 4) -> Incorrect (-1)
            q_nat_int: "999",        // Incorrect NAT (-1)
            q_nat_dec: "",           // Unanswered NAT (0)
            q_nat_neg: "-15",        // Correct NAT (+4)
            q_nat_tol: "60.0"        // Out of tolerance NAT (-1)
        };

        const resultB = MockTestScoringService.evaluateAttempt({
            questions: testQuestions,
            answerKeys: testKeys,
            studentAnswers: studentAnswersB
        });

        // Expected: -1 - 1 - 1 + 0 + 4 - 1 = 0
        assert.equal(resultB.totalScore, 0);
        assert.equal(resultB.correctCount, 1);
        assert.equal(resultB.incorrectCount, 4);
        assert.equal(resultB.unansweredCount, 1);
    });

    // ============================================================
    // TEST 13: REAL PDF EXTRACTION VALIDATION (JEE MAIN & SYNTHETIC)
    // ============================================================
    await t.test("13. Real examination PDF extraction achieves 100% question recall with zero omissions", async () => {
        // Test 13A: Synthetic NEET 2024 QP fixture
        const synthPath = path.join(rootDir, "tests/fixtures/synthetic_neet_2024_qp.pdf");
        if (fs.existsSync(synthPath)) {
            const synthBuf = fs.readFileSync(synthPath);
            const synthRes = await QuestionNormalizationService.extractAndNormalizeQuestions({
                pdfBuffer: synthBuf,
                examId: "neet-ug",
                year: 2024,
                paperCode: "Q1"
            });

            assert.ok(synthRes.totalExtracted > 0, "Must extract questions from synthetic NEET paper");
            assert.ok(synthRes.questions.every(q => q.questionNumber > 0), "All questions must have valid sequence numbers");
        }

        // Test 13B: JEE Main 2026 Shift 1 Real PDF
        const vaultDir = path.join(rootDir, "uploads/vault");
        const jeeFiles = fs.readdirSync(vaultDir).filter(f => f.includes("JEE_Main_21_Jan_2026_Shift_1.pdf"));
        if (jeeFiles.length > 0) {
            const jeeBuf = fs.readFileSync(path.join(vaultDir, jeeFiles[0]));
            const jeeRes = await QuestionNormalizationService.extractAndNormalizeQuestions({
                pdfBuffer: jeeBuf,
                examId: "jee-main",
                year: 2026,
                paperCode: "SHIFT_1"
            });

            assert.equal(jeeRes.totalExtracted, 75, "JEE Main 2026 Shift 1 must extract exactly 75 questions (100% recall)");
            assert.equal(jeeRes.questions[0].questionNumber, 1, "First question must be Q1");
            assert.equal(jeeRes.questions[74].questionNumber, 75, "Last question must be Q75");

            // Verify diagram option associations
            const q55 = jeeRes.questions.find(q => q.questionNumber === 55);
            assert.ok(q55, "Question 55 must exist");
            assert.ok(q55.options.some(o => o.diagramUrl), "Q55 must have visual diagram URL associated with its options");
            assert.ok(q55.media.some(m => m.type === "option_diagram"), "Q55 media must contain option_diagram entries");
        }
    });
});

