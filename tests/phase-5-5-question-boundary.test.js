import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { QuestionPaperParser } from "../server/services/ingestion/questionPaperParser.js";
import { AnswerKeyParser } from "../server/services/ingestion/answerKeyParser.js";
import { PaperFormatParser } from "../server/services/ingestion/paperFormatParser.js";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { UniversalDocumentIngestionService } from "../server/services/ingestion/universalDocumentIngestionService.js";

describe("Phase 5.5 — Question Boundary Extraction & 65-Question Reconciliation Suite", () => {
    process.env.NODE_ENV = "test";

    const findVaultFile = (suffix) => {
        const files = fs.readdirSync("uploads/vault");
        const found = files.find(f => f.endsWith(suffix));
        return found ? path.join("uploads/vault", found) : null;
    };

    const qpPath = findVaultFile("GATE_2026_CS1_Typed.pdf");
    const akPath = findVaultFile("GATE_2026_CS1_Answer_Key.pdf");
    const patternPath = findVaultFile("GATE_2026_CS_Exam_Pattern.pdf");

    test("1.1 Unit Test: Boundary parser separates Q4 and Q5 with Unicode smart quote", () => {
        const syntheticPageStream = [
            "Q.1 – Q.5 Carry ONE mark Each",
            "Q.4 Which one of the following is correct?",
            "(A) First option",
            "(B) Second option",
            "(C) Third option",
            "(D) Fourth option",
            "Q.5 \u2018When the teacher is in the room, students are quiet.\u2019 Which inference is valid?",
            "(A) Teacher speaks",
            "(B) Students speak",
            "(C) Nobody speaks",
            "(D) Teacher is absent",
            "Q.6 – Q.10 Carry TWO marks Each"
        ].join("\n");

        const parsed = QuestionPaperParser._parsePageStream([{ pageNumber: 1, text: syntheticPageStream }]);

        assert.strictEqual(parsed.questions.length, 2, "Must extract exactly 2 questions (Q4 and Q5), excluding section headers");
        assert.strictEqual(parsed.questions[0].questionNumber, 4);
        assert.strictEqual(parsed.questions[1].questionNumber, 5);
        assert.ok(parsed.questions[0].stem.text.includes("Which one"));
        assert.ok(parsed.questions[1].stem.text.includes("teacher"));
    });

    test("1.2 Unit Test: extractOptionsAndStem does not split mathematical parentheses as options (Q58)", () => {
        const mathNatText = [
            "Q.58 Consider a Poisson random variable X with parameter lambda.",
            "If Pr(X = 1) = Pr(X = 2) = 2 * Pr(X = 3), the value of lambda is",
            "(rounded off to 2 decimal places)."
        ].join("\n");

        const result = QuestionPaperParser.extractOptionsAndStem(mathNatText, 58);

        assert.strictEqual(result.options.length, 0, "Math equation parentheticals like Pr(X = 1) must NOT be parsed as options");
        assert.ok(result.stem.includes("Pr(X = 1)"), "Question stem must retain mathematical equations");
    });

    test("2.1 Full PDF Parsing: GATE 2026 CS1 Question Paper extracts exactly 65 questions", async () => {
        assert.ok(fs.existsSync(qpPath), `Question paper PDF must exist at ${qpPath}`);

        const result = await QuestionPaperParser.parse(fs.readFileSync(qpPath));

        assert.ok(result);
        assert.strictEqual(result.questions.length, 65, "Must extract exactly 65 questions from GATE 2026 CS1 PDF");

        // Verify Question 4
        const q4 = result.questions.find(q => q.questionNumber === 4);
        assert.ok(q4, "Question 4 must exist");
        assert.strictEqual(q4.options.length, 4, "Question 4 must have 4 options");

        // Verify Question 5
        const q5 = result.questions.find(q => q.questionNumber === 5);
        assert.ok(q5, "Question 5 must exist");
        assert.strictEqual(q5.options.length, 4, "Question 5 must have 4 options");
        assert.ok(q5.stem.text.includes("teacher"), "Question 5 must contain stem text about teacher");

        // Verify Question 58
        const q58 = result.questions.find(q => q.questionNumber === 58);
        assert.ok(q58, "Question 58 must exist");
        assert.strictEqual(q58.options.length, 0, "Question 58 must have 0 options (NAT question)");
    });

    test("2.2 Answer Key Parsing: GATE 2026 CS1 Answer Key extracts exactly 65 answers with 0 warnings", async () => {
        assert.ok(fs.existsSync(akPath), `Answer key PDF must exist at ${akPath}`);

        const result = await AnswerKeyParser.parse(fs.readFileSync(akPath));

        assert.ok(result);
        assert.strictEqual(result.answers.length, 65, "Must extract exactly 65 answers");
        assert.strictEqual(result.warnings.length, 0, "Must have 0 warnings");

        // Verify NAT answer 32 (value: 3)
        const ak32 = result.answers.find(a => a.questionNumber === 32);
        assert.ok(ak32, "Answer for Q32 must exist");
        assert.strictEqual(ak32.answerType, "numerical");
        assert.strictEqual(ak32.numericValue, 3);
        assert.strictEqual(ak32.acceptedAnswers[0], "3");

        // Verify MSQ answer 19 (values: A, C, D)
        const ak19 = result.answers.find(a => a.questionNumber === 19);
        assert.ok(ak19, "Answer for Q19 must exist");
        assert.strictEqual(ak19.acceptedAnswers.length, 3);
        assert.deepStrictEqual(ak19.acceptedAnswers.sort(), ["A", "C", "D"]);
    });

    test("3.1 End-to-End Pipeline & UIR Transformation: reconciles all 65 questions", async () => {
        const ingestionResult = await UniversalDocumentIngestionService.ingestDocuments({
            questionPaper: qpPath,
            answerKey: akPath,
            paperFormat: patternPath,
            examId: "gate",
            year: 2026,
            skipStrictPublicationBlock: false
        });

        assert.ok(ingestionResult);
        assert.strictEqual(ingestionResult.publicationValidation.publicationStatus, "APPROVED");
        assert.strictEqual(ingestionResult.publicationValidation.canPublish, true);
        assert.strictEqual(ingestionResult.publicationValidation.publicationBlockers.length, 0);

        const { uirDocument } = UIRTransformationService.transformIngestionManifest(ingestionResult, {
            examId: "gate",
            year: 2026
        });
        assert.ok(uirDocument);
        assert.strictEqual(uirDocument.questions.length, 65, "UIR Document must contain exactly 65 questions");

        // Breakdown by canonical UIR v3.0 question type: 33 MCQ, 19 MSQ, 13 NAT
        const mcqCount = uirDocument.questions.filter(q => q.questionType === "single_choice_mcq").length;
        const msqCount = uirDocument.questions.filter(q => q.questionType === "multiple_choice_msq").length;
        const natCount = uirDocument.questions.filter(q => q.questionType === "numerical_nat").length;

        assert.strictEqual(mcqCount, 33, "Must have exactly 33 single_choice_mcq questions");
        assert.strictEqual(msqCount, 19, "Must have exactly 19 multiple_choice_msq questions");
        assert.strictEqual(natCount, 13, "Must have exactly 13 numerical_nat questions");
        assert.strictEqual(mcqCount + msqCount + natCount, 65, "Sum of questions must equal 65");

        // Verify all 13 NAT questions have empty options and valid correctAnswer
        const natQuestions = uirDocument.questions.filter(q => q.questionType === "numerical_nat");
        for (const natQ of natQuestions) {
            assert.strictEqual(natQ.options.length, 0, `NAT question Q${natQ.questionNumber} must have options: []`);
            assert.ok(natQ.correctAnswer, `NAT question Q${natQ.questionNumber} must have correctAnswer`);
            assert.ok(
                natQ.correctAnswer.numericValue !== undefined ||
                (Array.isArray(natQ.correctAnswer.acceptedAnswers) && natQ.correctAnswer.acceptedAnswers.length > 0),
                `NAT question Q${natQ.questionNumber} must have numericValue or acceptedAnswers`
            );
        }
    });
});
