import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ExtractionStatus,
    DocumentType,
    ExtractionMethod,
    UniversalQuestionType,
    OptionalPolicyType,
    createExtractionField,
    createQuestionExtraction,
    createSectionExtraction,
    createAnswerKeyExtraction,
    createPaperFormatExtraction
} from "../server/services/ingestion/extractionSchema.js";
import { QuestionPaperParser } from "../server/services/ingestion/questionPaperParser.js";
import { AnswerKeyParser } from "../server/services/ingestion/answerKeyParser.js";
import { PaperFormatParser } from "../server/services/ingestion/paperFormatParser.js";
import { UniversalDocumentIngestionService } from "../server/services/ingestion/universalDocumentIngestionService.js";
import { IngestionValidator } from "../server/services/ingestion/ingestionValidator.js";
import { SyntheticExamFixtures } from "./fixtures/documents/syntheticExamFixtures.js";

describe("Universal Three-Document Ingestion Engine (Phase 2)", () => {

    describe("1. Canonical Extraction Schema & Provenance Models", () => {
        it("1.1 creates explicit extraction fields with full provenance", () => {
            const field = createExtractionField(120, {
                documentId: DocumentType.PAPER_FORMAT,
                pageNumber: 2,
                evidenceText: "Duration: 120 Minutes",
                extractionMethod: ExtractionMethod.TOKEN_PATTERN,
                confidence: 0.95
            });

            assert.equal(field.value, 120);
            assert.equal(field.documentId, "paper_format");
            assert.equal(field.pageNumber, 2);
            assert.equal(field.evidenceText, "Duration: 120 Minutes");
            assert.equal(field.confidence, 0.95);
            assert.equal(field.status, ExtractionStatus.EXPLICIT);
        });

        it("1.2 automatically tags null or empty values as UNKNOWN with confidence 0.0", () => {
            const field = createExtractionField(null, {
                documentId: DocumentType.PAPER_FORMAT,
                evidenceText: ""
            });

            assert.equal(field.value, null);
            assert.equal(field.status, ExtractionStatus.UNKNOWN);
            assert.equal(field.confidence, 0.0);
        });

        it("1.3 preserves question and section extraction canonical structure", () => {
            const q = createQuestionExtraction({
                questionNumber: 5,
                stem: { text: "Calculate current I in amperes" },
                options: [
                    { id: "A", label: "(1)", text: "2 A" },
                    { id: "B", label: "(2)", text: "4 A" }
                ],
                questionType: UniversalQuestionType.SINGLE_CHOICE_MCQ
            });

            assert.equal(q.questionId, "q_5");
            assert.equal(q.questionNumber, 5);
            assert.equal(q.options.length, 2);
            assert.equal(q.options[0].id, "A");
            assert.equal(q.options[0].label, "(1)");
            assert.equal(q.isUnreadable, false);
        });
    });

    describe("2. Scenario 1: Conventional MCQ Exam Ingestion", () => {
        it("2.1 successfully ingests and parses a standard 3-question MCQ paper", async () => {
            const fixture = SyntheticExamFixtures.scenario1_conventionalMcq();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.ok(result.ingestionJobId);
            assert.equal(result.validation.isValid, true);
            assert.equal(result.validation.blockers.length, 0);

            // Document provenance
            assert.equal(result.documentProvenance.questionPaper.questionCount, 3);
            assert.equal(result.documentProvenance.answerKey.answerCount, 3);
            assert.equal(result.documentProvenance.paperFormat.declaredTotalQuestions, 3);
            assert.equal(result.documentProvenance.paperFormat.declaredMaxMarks, 200);

            // Question Paper extractions
            const qp = result.extractions.questionPaper;
            assert.equal(qp.questions.length, 3);
            assert.equal(qp.questions[0].options.length, 4);
            assert.equal(qp.questions[0].questionType, UniversalQuestionType.SINGLE_CHOICE_MCQ);
            assert.ok(qp.questions[0].stem.text.includes("Reserve Bank of India"));

            // Answer Key extractions
            const ak = result.extractions.answerKey;
            assert.equal(ak.answers.length, 3);
            assert.deepEqual(ak.answers[0].acceptedAnswers, ["B"]);
            assert.deepEqual(ak.answers[1].acceptedAnswers, ["C"]);
            assert.deepEqual(ak.answers[2].acceptedAnswers, ["A"]);

            // Paper Format extractions
            const pf = result.extractions.paperFormat;
            assert.equal(pf.durationSeconds.value, 7200); // 120 mins = 7200s
            assert.equal(pf.totalQuestions.value, 3);
            assert.equal(pf.maximumMarks.value, 200);
            assert.equal(pf.markingRules.positiveMarks.value, 2);
            assert.equal(pf.markingRules.negativeMarks.value, -0.66);
            assert.equal(pf.markingRules.unansweredMarks.value, 0);
        });
    });

    describe("3. Scenario 2: Multiple Sections with Distinct Marking Rules", () => {
        it("3.1 identifies distinct sections and their respective question boundaries", async () => {
            const fixture = SyntheticExamFixtures.scenario2_multiSectionDifferentMarking();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.equal(result.validation.isValid, true);

            const qp = result.extractions.questionPaper;
            assert.equal(qp.sections.length, 2);
            assert.ok(qp.sections[0].sectionName.includes("SECTION A"));
            assert.ok(qp.sections[1].sectionName.includes("SECTION B"));

            // Section question attributions
            assert.equal(qp.questions[0].sectionName, qp.sections[0].sectionName);
            assert.equal(qp.questions[1].sectionName, qp.sections[0].sectionName);
            assert.equal(qp.questions[2].sectionName, qp.sections[1].sectionName);
            assert.equal(qp.questions[3].sectionName, qp.sections[1].sectionName);

            // Format document section rules
            const pf = result.extractions.paperFormat;
            assert.equal(pf.sections.length, 2);
            assert.equal(pf.sections[0].questionCount, 2);
            assert.equal(pf.sections[1].questionCount, 2);
        });
    });

    describe("4. Scenario 3: Optional Questions Policy Extraction", () => {
        it("4.1 extracts choose-n-of-m optional question rule with exact provenance", async () => {
            const fixture = SyntheticExamFixtures.scenario3_optionalQuestions();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.equal(result.validation.isValid, true);

            const pf = result.extractions.paperFormat;
            assert.equal(pf.optionalQuestionRules.length, 1);
            const optRule = pf.optionalQuestionRules[0];

            assert.equal(optRule.policy, OptionalPolicyType.CHOOSE_N_OF_M);
            assert.equal(optRule.requiredCount, 5);
            assert.equal(optRule.totalCount, 10);
            assert.ok(optRule.evidenceText.includes("attempt 5 questions out of 10"));
            assert.ok(optRule.confidence >= 0.95);
        });
    });

    describe("5. Scenario 4: Numerical / NAT Questions with Ranges", () => {
        it("5.1 classifies optionless questions as numerical_nat and extracts answer key ranges", async () => {
            const fixture = SyntheticExamFixtures.scenario4_numericalWithRanges();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.equal(result.validation.isValid, true);

            const qp = result.extractions.questionPaper;
            assert.equal(qp.questions.length, 3);
            for (const q of qp.questions) {
                assert.equal(q.questionType, UniversalQuestionType.NUMERICAL_NAT);
                assert.equal(q.options.length, 0);
            }

            const ak = result.extractions.answerKey;
            assert.equal(ak.answers.length, 3);

            // Q1: Range [4.8, 5.0]
            assert.equal(ak.answers[0].answerType, "range");
            assert.deepEqual(ak.answers[0].numericRange, { min: 4.8, max: 5.0 });

            // Q2: 12.5 +/- 0.5 -> Range [12.0, 13.0]
            assert.equal(ak.answers[1].answerType, "range");
            assert.equal(ak.answers[1].numericRange.min, 12.0);
            assert.equal(ak.answers[1].numericRange.max, 13.0);

            // Q3: 50 -> single numerical
            assert.equal(ak.answers[2].answerType, "numerical");
            assert.equal(ak.answers[2].numericValue, 50);

            // Paper format: "no negative marking"
            const pf = result.extractions.paperFormat;
            assert.equal(pf.markingRules.negativeMarks.value, 0);
        });
    });

    describe("6. Scenario 5: Scanned Question Paper OCR Detection Gate", () => {
        it("6.1 flags scanned PDF when text density is < 50 characters per page and produces validation blocker", async () => {
            const fixture = SyntheticExamFixtures.scenario5_scannedQuestionPaper();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.equal(result.validation.isValid, false);
            assert.ok(result.validation.blockers.some(b => b.includes("scanned or image-only")));
            assert.equal(result.extractions.questionPaper.isScanned, true);
            assert.ok(result.extractions.questionPaper.scanDetection.averageCharsPerPage < 50);
        });
    });

    describe("7. Scenario 6: Paper Containing Tables and Diagrams", () => {
        it("7.1 preserves embedded diagram markers and tabular structures", async () => {
            const fixture = SyntheticExamFixtures.scenario6_tablesAndDiagrams();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.equal(result.validation.isValid, true);

            const qp = result.extractions.questionPaper;
            assert.equal(qp.questions.length, 2);

            // Q1 has diagram
            assert.equal(qp.questions[0].hasDiagram, true);
            assert.equal(qp.questions[0].stem.diagrams.length, 1);
            assert.ok(qp.questions[0].stem.diagrams[0].reference.includes("Figure 3"));

            // Q2 has embedded table
            assert.equal(qp.questions[1].stem.tables.length, 1);
            assert.ok(qp.questions[1].stem.tables[0].rawTable.includes("Pressure (atm)"));
            assert.ok(qp.questions[1].stem.tables[0].rawTable.includes("Volume (L)"));
        });
    });

    describe("8. Scenario 7: Answer Key with Deleted and Bonus Questions", () => {
        it("8.1 extracts dropped and bonus questions with proper flags and format policy", async () => {
            const fixture = SyntheticExamFixtures.scenario7_deletedAndBonusQuestions();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.equal(result.validation.isValid, true);

            const ak = result.extractions.answerKey;
            assert.equal(ak.answers.length, 3);

            // Q1: Standard A
            assert.equal(ak.answers[0].isDropped, false);
            assert.deepEqual(ak.answers[0].acceptedAnswers, ["A"]);

            // Q2: Dropped
            assert.equal(ak.answers[1].isDropped, true);
            assert.equal(ak.answers[1].isBonus, true);
            assert.equal(ak.answers[1].answerType, "dropped");
            assert.deepEqual(ak.answers[1].acceptedAnswers, ["*"]);

            // Q3: Bonus
            assert.equal(ak.answers[2].isDropped, true);
            assert.equal(ak.answers[2].isBonus, true);
            assert.equal(ak.answers[2].answerType, "dropped");

            // Format dropped policy
            const pf = result.extractions.paperFormat;
            assert.equal(pf.droppedQuestionPolicy.value, "full_marks_for_all");
            assert.equal(pf.droppedQuestionPolicy.status, ExtractionStatus.EXPLICIT);
        });
    });

    describe("9. Scenario 8: Incomplete & Contradictory Format Rules", () => {
        it("9.1 flags contradictory counts as CONTRADICTORY blocker and missing rules as UNKNOWN", async () => {
            const fixture = SyntheticExamFixtures.scenario8_incompleteContradictoryRules();

            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            // Must NOT be valid due to contradiction
            assert.equal(result.validation.isValid, false);
            assert.ok(result.validation.blockers.some(b => b.includes("contradictory total question counts")));

            const pf = result.extractions.paperFormat;

            // Total questions contradictory (100 vs 90)
            assert.equal(pf.totalQuestions.status, ExtractionStatus.CONTRADICTORY);
            assert.equal(pf.totalQuestions.confidence, 0.0);
            assert.equal(pf.totalQuestions.value, null);

            // Negative marking omitted -> strictly UNKNOWN with confidence 0. NEVER DEFAULTED!
            assert.equal(pf.markingRules.negativeMarks.status, ExtractionStatus.UNKNOWN);
            assert.equal(pf.markingRules.negativeMarks.confidence, 0.0);
            assert.equal(pf.markingRules.negativeMarks.value, null);

            // Duration omitted -> strictly UNKNOWN with confidence 0. NEVER DEFAULTED!
            assert.equal(pf.durationSeconds.status, ExtractionStatus.UNKNOWN);
            assert.equal(pf.durationSeconds.confidence, 0.0);
            assert.equal(pf.durationSeconds.value, null);

            // Positive marks explicitly stated as 4
            assert.equal(pf.markingRules.positiveMarks.status, ExtractionStatus.EXPLICIT);
            assert.equal(pf.markingRules.positiveMarks.value, 4);

            // Warnings contain notice of unknown rules
            assert.ok(result.validation.warnings.some(w => w.includes("negative marking rules (marked UNKNOWN)")));
            assert.ok(result.validation.warnings.some(w => w.includes("duration (marked UNKNOWN)")));
        });
    });

    describe("10. Architectural Robustness & Exam-Agnostic Guarantee", () => {
        it("10.1 parses multi-option answer key entries (e.g. 'A or C', '2 or 4')", async () => {
            const rawAk = [
                "FINAL ANSWER KEY",
                "1   A or C",
                "2   B, D",
                "3   1 or 3"
            ].join("\n");

            const parsed = await AnswerKeyParser.parse(rawAk);
            assert.equal(parsed.answers.length, 3);
            assert.deepEqual(parsed.answers[0].acceptedAnswers, ["A", "C"]);
            assert.deepEqual(parsed.answers[1].acceptedAnswers, ["B", "D"]);
            assert.deepEqual(parsed.answers[2].acceptedAnswers, ["A", "C"]); // 1 or 3 -> A or C
        });

        it("10.2 handles dense / non-sequential answer keys and detects sequence gaps", async () => {
            const rawAk = [
                "1   A",
                "2   B",
                "5   C" // Q3 and Q4 missing!
            ].join("\n");

            const parsed = await AnswerKeyParser.parse(rawAk);
            assert.equal(parsed.answers.length, 3);
            assert.ok(parsed.warnings.some(w => w.includes("Sequence gap detected")));
        });

        it("10.3 computes stable SHA-256 digests and provenance records for all source inputs", async () => {
            const fixture = SyntheticExamFixtures.scenario1_conventionalMcq();
            const result = await UniversalDocumentIngestionService.ingestDocuments({
                questionPaper: fixture.questionPaper,
                answerKey: fixture.answerKey,
                paperFormat: fixture.paperFormat
            });

            assert.equal(typeof result.documentProvenance.questionPaper.sha256, "string");
            assert.equal(result.documentProvenance.questionPaper.sha256.length, 64);
            assert.equal(typeof result.documentProvenance.answerKey.sha256, "string");
            assert.equal(result.documentProvenance.answerKey.sha256.length, 64);
            assert.equal(typeof result.documentProvenance.paperFormat.sha256, "string");
            assert.equal(result.documentProvenance.paperFormat.sha256.length, 64);
        });

        it("10.4 maps decoupled and scrambled answer keys correctly without assuming QP sequence", async () => {
            // Answer keys given in random non-sequential order
            const scrambledAk = [
                "OFFICIAL ANSWER KEY",
                "15   D",
                "3    A",
                "1    C",
                "8    B"
            ].join("\n");

            const parsed = await AnswerKeyParser.parse(scrambledAk);
            assert.equal(parsed.answers.length, 4);
            // Should be sorted by questionNumber
            assert.equal(parsed.answers[0].questionNumber, 1);
            assert.deepEqual(parsed.answers[0].acceptedAnswers, ["C"]);
            assert.equal(parsed.answers[1].questionNumber, 3);
            assert.deepEqual(parsed.answers[1].acceptedAnswers, ["A"]);
            assert.equal(parsed.answers[2].questionNumber, 8);
            assert.deepEqual(parsed.answers[2].acceptedAnswers, ["B"]);
            assert.equal(parsed.answers[3].questionNumber, 15);
            assert.deepEqual(parsed.answers[3].acceptedAnswers, ["D"]);
        });

        it("10.5 detects corrupted font glyphs (\\uFFFD) and marks question as unreadable", async () => {
            const corruptedQp = [
                "GENERAL APTITUDE TEST",
                "Q. 1 What is the value of \uFFFD\uFFFD\uFFFD\uFFFD corrupted content?",
                "(A) Option A",
                "(B) Option B"
            ].join("\n");

            const parsed = await QuestionPaperParser.parse(corruptedQp);
            assert.equal(parsed.questions.length, 1);
            assert.equal(parsed.questions[0].isUnreadable, true);
            assert.ok(parsed.questions[0].unreadableReason.includes("Corrupted text contains unmapped font glyphs"));
        });

        it("10.6 preserves mathematical formulas, LaTeX fragments, and physical units", async () => {
            const mathQp = [
                "PHYSICS EXAMINATION",
                "Q. 1 A particle moves with velocity $v = 10 m/s$ and mass $m = 2 kg$. Find energy $E = \\frac{1}{2}mv^2$:",
                "(A) 50 J",
                "(B) 100 J"
            ].join("\n");

            const parsed = await QuestionPaperParser.parse(mathQp);
            assert.equal(parsed.questions.length, 1);
            assert.ok(parsed.questions[0].stem.formulas.length > 0);
            assert.ok(parsed.questions[0].stem.formulas.some(f => f.includes("m/s")));
        });

        it("10.7 throws descriptive error when mandatory documents are missing", async () => {
            await assert.rejects(
                () => UniversalDocumentIngestionService.ingestDocuments({
                    questionPaper: null,
                    answerKey: "1 A",
                    paperFormat: "Total: 1"
                }),
                /Missing required document: questionPaper/
            );
        });
    });

    describe("11. Phase 2.2 Critical Document Resilience Regressions", () => {
        it("11.1 preserves numbered statements inside question bodies without treating them as new questions", async () => {
            const rawQp = [
                "CIVIL SERVICES PRELIMINARY EXAMINATION",
                "Q. 7 Consider the following statements:",
                "1. The earliest epigraphic use of zero occurs in India.",
                "2. In the ninth century, mathematical texts formalized it.",
                "3. Pingala discussed zero-like concepts in Chandas Shastra.",
                "Which of the statements given above are correct?",
                "(A) 1 and 2 only",
                "(B) 2 and 3 only",
                "(C) 1 and 3 only",
                "(D) 1, 2 and 3",
                "Q. 8 Which constitutional amendment introduced the Goods and Services Tax (GST)?",
                "(A) 99th Amendment",
                "(B) 100th Amendment",
                "(C) 101st Amendment",
                "(D) 102nd Amendment"
            ].join("\n");

            const parsed = await QuestionPaperParser.parse(rawQp);
            assert.equal(parsed.questions.length, 2);
            assert.equal(parsed.questions[0].questionNumber, 7);
            assert.equal(parsed.questions[0].options.length, 4);
            assert.ok(parsed.questions[0].stem.text.includes("1. The earliest epigraphic use"));
            assert.ok(parsed.questions[0].stem.text.includes("2. In the ninth century"));
            assert.ok(parsed.questions[0].stem.text.includes("3. Pingala discussed"));

            assert.equal(parsed.questions[1].questionNumber, 8);
            assert.equal(parsed.questions[1].options.length, 4);
        });

        it("11.2 supports section-based numbering restarts", async () => {
            const restartQp = [
                "JOINT ENTRANCE TEST",
                "SECTION 1: PHYSICS",
                "Q. 1 Find gravitational force between two masses:",
                "(A) 9.8 N",
                "(B) 10 N",
                "SECTION 2: CHEMISTRY",
                "Q. 1 Find pH of 0.01 M HCl solution:",
                "(A) 1",
                "(B) 2"
            ].join("\n");

            const parsed = await QuestionPaperParser.parse(restartQp);
            assert.equal(parsed.questions.length, 2);
            assert.equal(parsed.sections.length, 2);
            assert.equal(parsed.questions[0].sectionName, "SECTION 1: PHYSICS");
            assert.equal(parsed.questions[1].sectionName, "SECTION 2: CHEMISTRY");
        });

        it("11.3 parses spaced parentheses and tabular multi-column layouts in answer keys", async () => {
            const multiAk = [
                "OFFICIAL ANSWER KEY",
                "1 ( d ) 11 ( d ) 21 ( b ) 31 ( a ) 41 ( c )",
                "50 100*"
            ].join("\n");

            const parsed = await AnswerKeyParser.parse(multiAk);
            assert.equal(parsed.answers.length, 6);
            assert.deepEqual(parsed.answers[0].acceptedAnswers, ["D"]);
            assert.deepEqual(parsed.answers[1].acceptedAnswers, ["D"]);
            assert.deepEqual(parsed.answers[2].acceptedAnswers, ["B"]);
            assert.deepEqual(parsed.answers[3].acceptedAnswers, ["A"]);
            assert.deepEqual(parsed.answers[4].acceptedAnswers, ["C"]);
            assert.equal(parsed.answers[5].numericValue, 100);
        });

        it("11.4 parses fractional negative marking (1/3, 1/4, one-third) accurately", async () => {
            const bpscPattern = [
                "BPSC Preliminary Examination - Exam Pattern",
                "Questions 150 objective-type (MCQ)",
                "Maximum marks 150",
                "Duration 2 hours",
                "Marking Scheme",
                "Correct answer +1",
                "Incorrect answer -1/3",
                "Option E (Not Attempted) leaving blank attracts the 1/3 penalty"
            ].join("\n");

            const parsed = await PaperFormatParser.parse(bpscPattern);
            assert.equal(parsed.totalQuestions.value, 150);
            assert.equal(parsed.maximumMarks.value, 150);
            assert.equal(parsed.markingRules.positiveMarks.value, 1);
            assert.equal(parsed.markingRules.negativeMarks.value, -0.3333);
        });

        it("11.5 cross-document validation catches question count mismatch > 10% as fatal blocker", async () => {
            // QP has 10 questions, AK has 8 answers -> 20% mismatch
            const qpQuestions = Array.from({ length: 10 }, (_, i) => createQuestionExtraction({
                questionNumber: i + 1,
                stem: { text: `Question stem ${i + 1}` },
                options: [{ id: "A", text: "Opt A" }]
            }));
            const akAnswers = Array.from({ length: 8 }, (_, i) => createAnswerKeyExtraction({
                questionNumber: i + 1,
                acceptedAnswers: ["A"]
            }));
            const format = createPaperFormatExtraction({
                totalQuestions: 10,
                maximumMarks: 100,
                positiveMarks: 1,
                negativeMarks: -0.25
            });

            const validation = IngestionValidator.validate({
                questionPaperExtraction: { isScanned: false, questions: qpQuestions, warnings: [] },
                answerKeyExtraction: { answers: akAnswers, duplicates: [], warnings: [] },
                paperFormatExtraction: format
            });

            assert.equal(validation.isValid, false);
            assert.ok(validation.blockers.some(b => b.includes("Fatal cross-document count mismatch")));
        });

        it("11.6 cross-document validation catches answer key coverage < 50% as fatal blocker", async () => {
            const qpQuestions = Array.from({ length: 10 }, (_, i) => createQuestionExtraction({
                questionNumber: i + 1,
                stem: { text: `Question stem ${i + 1}` },
                options: [{ id: "A", text: "Opt A" }]
            }));
            const akAnswers = Array.from({ length: 4 }, (_, i) => createAnswerKeyExtraction({
                questionNumber: i + 1,
                acceptedAnswers: ["A"]
            }));

            const validation = IngestionValidator.validate({
                questionPaperExtraction: { isScanned: false, questions: qpQuestions, warnings: [] },
                answerKeyExtraction: { answers: akAnswers, duplicates: [], warnings: [] },
                paperFormatExtraction: createPaperFormatExtraction({})
            });

            assert.equal(validation.isValid, false);
            assert.ok(validation.blockers.some(b => b.includes("Answer key coverage is critical")));
        });

        it("11.7 rejects non-finite marking values (NaN, Infinity) as fatal blockers", async () => {
            const format = createPaperFormatExtraction({
                totalQuestions: 5,
                positiveMarks: NaN,
                negativeMarks: -Infinity
            });

            const validation = IngestionValidator.validate({
                questionPaperExtraction: { isScanned: false, questions: [], warnings: [] },
                answerKeyExtraction: { answers: [], duplicates: [], warnings: [] },
                paperFormatExtraction: format
            });

            assert.equal(validation.isValid, false);
            assert.ok(validation.blockers.some(b => b.includes("Non-finite numeric value detected in marking rule 'positiveMarks'")));
            assert.ok(validation.blockers.some(b => b.includes("Non-finite numeric value detected in marking rule 'negativeMarks'")));
        });

        it("11.8 preserves dropped, bonus, and asterisk answer key entries with proper flags", async () => {
            const akText = [
                "OFFICIAL KEY",
                "1   A",
                "2   Dropped",
                "3   Bonus",
                "4   *"
            ].join("\n");

            const parsed = await AnswerKeyParser.parse(akText);
            assert.equal(parsed.answers.length, 4);
            assert.equal(parsed.answers[0].isDropped, false);
            assert.equal(parsed.answers[1].isDropped, true);
            assert.equal(parsed.answers[1].isBonus, true);
            assert.equal(parsed.answers[2].isDropped, true);
            assert.equal(parsed.answers[2].isBonus, true);
            assert.equal(parsed.answers[3].isDropped, true);
            assert.equal(parsed.answers[3].isBonus, true);
        });
    });

    describe("12. Strict Publication Validation Gate & Bilingual Integrity (Phase 2.3)", () => {
        it("12.1 blocks publication on exact question count mismatch (tolerance is 0)", () => {
            const qpExtraction = {
                questions: [
                    createQuestionExtraction({ questionNumber: 1 }),
                    createQuestionExtraction({ questionNumber: 2 })
                ]
            };
            const akExtraction = {
                answers: [
                    { questionNumber: 1, acceptedAnswers: ["A"], provenance: { value: "A" } },
                    { questionNumber: 2, acceptedAnswers: ["B"], provenance: { value: "B" } },
                    { questionNumber: 3, acceptedAnswers: ["C"], provenance: { value: "C" } }
                ]
            };
            const pfExtraction = createPaperFormatExtraction({
                totalQuestions: 2,
                durationSeconds: 3600,
                maximumMarks: 100,
                positiveMarks: 1,
                negativeMarks: 0
            });

            const res = IngestionValidator.validatePublication({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction
            });

            assert.equal(res.isApproved, false);
            assert.ok(res.publicationBlockers.some(b => b.includes("0 tolerance") && b.includes("Question Paper question count (2) does not match Answer Key count (3)")));
        });

        it("12.2 blocks publication on unmapped questions in answer key", () => {
            const qpExtraction = {
                questions: [
                    createQuestionExtraction({ questionNumber: 1 }),
                    createQuestionExtraction({ questionNumber: 2 }),
                    createQuestionExtraction({ questionNumber: 3 })
                ]
            };
            const akExtraction = {
                answers: [
                    { questionNumber: 1, acceptedAnswers: ["A"], provenance: { value: "A" } },
                    { questionNumber: 2, acceptedAnswers: ["B"], provenance: { value: "B" } },
                    { questionNumber: 4, acceptedAnswers: ["D"], provenance: { value: "D" } }
                ]
            };
            const pfExtraction = createPaperFormatExtraction({
                totalQuestions: 3,
                durationSeconds: 3600,
                maximumMarks: 100,
                positiveMarks: 1,
                negativeMarks: 0
            });

            const res = IngestionValidator.validatePublication({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction
            });

            assert.equal(res.isApproved, false);
            assert.ok(res.publicationBlockers.some(b => b.includes("Question 3 has no corresponding answer in Answer Key")));
        });

        it("12.3 blocks publication when scoring rules or duration are UNKNOWN or non-finite", () => {
            const qpExtraction = {
                questions: [createQuestionExtraction({ questionNumber: 1 })]
            };
            const akExtraction = {
                answers: [{ questionNumber: 1, acceptedAnswers: ["A"], provenance: { value: "A" } }]
            };
            const pfExtraction = createPaperFormatExtraction({
                totalQuestions: 1,
                durationSeconds: NaN,
                maximumMarks: 100,
                positiveMarks: 1
            });
            pfExtraction.markingRules.negativeMarks = createExtractionField(null, {
                documentId: DocumentType.PAPER_FORMAT,
                status: ExtractionStatus.UNKNOWN
            });

            const res = IngestionValidator.validatePublication({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction
            });

            assert.equal(res.isApproved, false);
            assert.ok(res.publicationBlockers.some(b => b.includes("Negative marking rule is unresolved")));
            assert.ok(res.publicationBlockers.some(b => b.includes("Examination duration must be a positive finite number")));
        });

        it("12.4 blocks publication when single-choice questions have duplicate options", () => {
            const qpExtraction = {
                questions: [
                    createQuestionExtraction({
                        questionNumber: 1,
                        options: [
                            { id: "A", label: "(A)", text: "Paris" },
                            { id: "B", label: "(B)", text: "Paris" }
                        ]
                    })
                ]
            };
            const akExtraction = {
                answers: [{ questionNumber: 1, acceptedAnswers: ["A"], provenance: { value: "A" } }]
            };
            const pfExtraction = createPaperFormatExtraction({
                totalQuestions: 1,
                durationSeconds: 3600,
                maximumMarks: 100,
                positiveMarks: 1,
                negativeMarks: 0
            });

            const res = IngestionValidator.validatePublication({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction
            });

            assert.equal(res.isApproved, false);
            assert.ok(res.publicationBlockers.some(b => b.includes("Question 1 has duplicate option content: \"Paris\"")));
        });

        it("12.5 blocks publication when question stem references a diagram but no diagram is extracted", () => {
            const qpExtraction = {
                questions: [
                    createQuestionExtraction({
                        questionNumber: 1,
                        stem: { text: "Refer to Figure 1. What is the electric field at point P?" },
                        hasDiagram: false,
                        diagrams: [],
                        options: [
                            { id: "A", label: "(A)", text: "10 N/C" },
                            { id: "B", label: "(B)", text: "20 N/C" }
                        ]
                    })
                ]
            };
            const akExtraction = {
                answers: [{ questionNumber: 1, acceptedAnswers: ["A"], provenance: { value: "A" } }]
            };
            const pfExtraction = createPaperFormatExtraction({
                totalQuestions: 1,
                durationSeconds: 3600,
                maximumMarks: 100,
                positiveMarks: 1,
                negativeMarks: 0
            });

            const res = IngestionValidator.validatePublication({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction
            });

            assert.equal(res.isApproved, false);
            assert.ok(res.publicationBlockers.some(b => b.includes("Question 1 references an external figure/diagram in its stem")));
        });

        it("12.6 allows administrative override audit trail with recorded approver, timestamp, and rationale", () => {
            const qpExtraction = {
                questions: [
                    createQuestionExtraction({
                        questionNumber: 1,
                        options: [
                            { id: "A", label: "(A)", text: "and" },
                            { id: "B", label: "(B)", text: "and" }
                        ]
                    })
                ]
            };
            const akExtraction = {
                answers: [{ questionNumber: 1, acceptedAnswers: ["A"], provenance: { value: "A" } }]
            };
            const pfExtraction = createPaperFormatExtraction({
                totalQuestions: 1,
                durationSeconds: 3600,
                maximumMarks: 100,
                positiveMarks: 1,
                negativeMarks: 0
            });

            // Without overrides -> strictly blocked
            const unapproved = IngestionValidator.validatePublication({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction
            });
            assert.equal(unapproved.isApproved, false);
            assert.equal(unapproved.overridesApplied.length, 0);

            // With administrative override
            const approved = IngestionValidator.validatePublication({
                questionPaperExtraction: qpExtraction,
                answerKeyExtraction: akExtraction,
                paperFormatExtraction: pfExtraction,
                options: {
                    administrativeOverrides: {
                        approvedBy: "examiner@domain.com",
                        approvedAt: "2026-11-14T10:00:00Z",
                        rationale: "Approved manual formula verification for duplicate text",
                        overrideExceptions: ["duplicate option content"]
                    }
                }
            });

            assert.equal(approved.isApproved, true);
            assert.equal(approved.publicationBlockers.length, 0);
            assert.equal(approved.overridesApplied.length, 1);
            assert.equal(approved.overridesApplied[0].approvedBy, "examiner@domain.com");
            assert.equal(approved.overridesApplied[0].approvedAt, "2026-11-14T10:00:00Z");
        });

        it("12.7 verifies bilingual parallel stream correlation for interleaved documents", () => {
            // Simulated 4-page interleaved booklet:
            // Page 2: Q1 in English
            // Page 3: Q1 in Hindi
            // Page 4: Q2 in English
            // Page 5: Q2 in Hindi
            const pages = [
                {
                    pageNumber: 2,
                    text: "1. Which of the following is correct?\n(A) Option A\n(B) Option B\n(C) Option C\n(D) Option D"
                },
                {
                    pageNumber: 3,
                    text: "1. निम्नलिखित में से कौन सा सही है?\n(A) विकल्प क\n(B) विकल्प ख\n(C) विकल्प ग\n(D) विकल्प घ"
                },
                {
                    pageNumber: 4,
                    text: "2. Consider the following statements:\n(A) Statement 1\n(B) Statement 2\n(C) Statement 3\n(D) Statement 4"
                },
                {
                    pageNumber: 5,
                    text: "2. निम्नलिखित कथनों पर विचार करें:\n(A) कथन १\n(B) कथन २\n(C) कथन ३\n(D) कथन ४"
                }
            ];

            const res = QuestionPaperParser.extractSectionsAndQuestions(pages);
            assert.equal(res.questions.length, 2);
            assert.equal(res.questions[0].questionNumber, 1);
            assert.ok(res.questions[0].bilingual);
            assert.ok(res.questions[0].bilingual.parallelStem.includes("निम्नलिखित में से कौन सा सही है"));
            assert.equal(res.questions[0].options.length, 4);

            assert.equal(res.questions[1].questionNumber, 2);
            assert.ok(res.questions[1].bilingual);
            assert.ok(res.questions[1].bilingual.parallelStem.includes("निम्नलिखित कथनों पर विचार करें"));
            assert.equal(res.questions[1].options.length, 4);
        });

        it("12.8 verifies monotonic option extraction preserves multi-line options and Assertion/Reason", () => {
            const rawBlock = [
                "Assertion (A) : Electric field inside a conductor is zero.",
                "Reason (R) : Conductors contain free charge carriers that redistribute.",
                "Select the correct answer:",
                "(A) Both (A) and (R) are true and (R) is correct explanation of (A)",
                "(B) Both (A) and (R) are true but (R) is not correct explanation",
                "(C) (A) is true but (R) is false",
                "(D) (A) is false but (R) is true"
            ].join("\n");

            const q = QuestionPaperParser.parseSingleQuestion(1, "1 .", rawBlock);
            assert.equal(q.questionNumber, 1);
            assert.equal(q.options.length, 4);
            assert.equal(q.options[0].id, "A");
            assert.equal(q.options[0].text, "Both (A) and (R) are true and (R) is correct explanation of (A)");
            assert.equal(q.options[3].id, "D");
            assert.ok(q.stem.text.includes("Assertion (A) : Electric field inside a conductor is zero."));
            assert.ok(q.stem.text.includes("Reason (R) : Conductors contain free charge carriers that redistribute."));
        });
    });
});
