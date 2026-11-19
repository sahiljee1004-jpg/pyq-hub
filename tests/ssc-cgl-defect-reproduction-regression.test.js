import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionPaperParser } from '../server/services/ingestion/questionPaperParser.js';
import { AnswerKeyParser } from '../server/services/ingestion/answerKeyParser.js';
import { PaperFormatParser } from '../server/services/ingestion/paperFormatParser.js';
import { UIRTransformationService } from '../server/services/uir/uirTransformationService.js';
import { UIRValidator } from '../server/services/uir/uirValidator.js';

describe('Phase 5.4: SSC CGL Defect Reproduction & Remediation Regression Suite', () => {

    describe('1. Defect 1: Q2 inside Q10 Boundary Collision', () => {
        const q10Snippet = [
            "PART A – General Intelligence and Reasoning",
            "Q9. Complete the pattern.",
            "(1) 12",
            "(2) 14",
            "(3) 16",
            "(4) 18",
            "Q10.  Find the pair that does NOT follow the double-step pattern.",
            "Q2, R4, S6, T8, V12",
            "(1)  Q2",
            "(2)  R4",
            "(3)  S6",
            "(4)  V12",
            "Q11. Next letter in series.",
            "(1) A",
            "(2) B",
            "(3) C",
            "(4) D"
        ].join("\n");

        it('1.1 verifies that old unanchored regex produces spurious Q2 and truncates Q10', () => {
            const oldRegex = /^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})|(\d{1,3})\s*[\.\)])\s*(.*)/i;
            const line = "Q2, R4, S6, T8, V12";
            const match = line.match(oldRegex);
            assert.ok(match, "Old regex matches Q2,");
            assert.equal(match[1], "2", "Old regex extracted rawNum 2 from Q2,");
            const isExplicitQ = /^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d{1,3})/i.test(line);
            assert.equal(isExplicitQ, true, "Old regex considered Q2, as explicit question");
        });

        it('1.2 verifies that remediated parser preserves Q10 options and eliminates spurious duplicate Q2', async () => {
            const parsed = await QuestionPaperParser.parse(q10Snippet);
            assert.equal(parsed.questions.length, 3, "Exactly 3 questions extracted (Q9, Q10, Q11)");
            const q10 = parsed.questions.find(q => q.questionNumber === 10);
            assert.ok(q10, "Q10 exists");
            assert.equal(q10.options.length, 4, "Q10 has all 4 options intact");
            assert.equal(q10.options[0].text, "Q2");
            assert.equal(q10.options[1].text, "R4");
            assert.ok(q10.stem.text.includes("Q2, R4, S6, T8, V12"), "Q10 stem includes the series");

            const spuriousQ2 = parsed.questions.filter(q => q.questionNumber === 2);
            assert.equal(spuriousQ2.length, 0, "Zero spurious Question 2 created");
        });
    });

    describe('2. Defect 2: Three-Column Answer Key & Numerical Misclassification', () => {
        const threeColSnippet = [
            "1 3 38",
            "2 2 Patna, Bihar to Digha, West Bengal",
            "3 2 4th March",
            "4 1 1024"
        ].join("\n");

        it('2.1 verifies that old logic parses 3 38 as numerical with empty acceptedAnswers', () => {
            const clean = "3 38";
            const numVal = parseFloat(clean);
            assert.equal(numVal, 3);
            const isNum = Number.isFinite(numVal) && !isNaN(numVal) && !/[a-z]/i.test(clean);
            assert.equal(isNum, true, "Old logic falsely treats '3 38' as numerical 3");
        });

        it('2.2 verifies that remediated AnswerKeyParser extracts all entries as canonical single choice MCQs', async () => {
            const parsed = await AnswerKeyParser.parse(threeColSnippet);
            assert.equal(parsed.answers.length, 4);
            assert.deepEqual(parsed.answers[0].acceptedAnswers, ['C']);
            assert.equal(parsed.answers[0].answerType, 'single_choice');
            assert.deepEqual(parsed.answers[1].acceptedAnswers, ['B']);
            assert.equal(parsed.answers[1].answerType, 'single_choice');
            assert.deepEqual(parsed.answers[2].acceptedAnswers, ['B']);
            assert.deepEqual(parsed.answers[3].acceptedAnswers, ['A']);
        });
    });

    describe('3. Defect 3: Long Answer Descriptions (>8 Words)', () => {
        const longDescSnippet = [
            "41 1 Both A and R true, R explains A",
            "79 3 Sense how events or opinion are trending before acting",
            "97 1 He mentioned, \"My team will start the project next week.\""
        ].join("\n");

        it('3.1 verifies that old isInstructionSentence rejects lines with >8 words', () => {
            const text = "1 Both A and R true, R explains A";
            const isInstruction = text.split(/\s+/).length > 8;
            assert.equal(isInstruction, true, "Old logic rejected verbose option line");
        });

        it('3.2 verifies that remediated AnswerKeyParser extracts option without false instruction rejection', async () => {
            const parsed = await AnswerKeyParser.parse(longDescSnippet);
            assert.equal(parsed.answers.length, 3);
            assert.deepEqual(parsed.answers[0].acceptedAnswers, ['A']);
            assert.deepEqual(parsed.answers[1].acceptedAnswers, ['C']);
            assert.deepEqual(parsed.answers[2].acceptedAnswers, ['A']);
        });
    });

    describe('4. Defect 4: Hyphenated Number Descriptions in Multi-Pair Detection', () => {
        const hyphenSnippet = [
            "22 3 18-5-7-9-20",
            "99 1 1-2-4-3"
        ].join("\n");

        it('4.1 verifies that old multiRegex falsely matches 18-5 and 1-2 as second questions', () => {
            const multiRegex = /(?:^|\s)\b(\d{1,3})\b[\.\s\:\-\t\|]+(?:\(\s*([A-Za-z0-9\.\+\-\*,\/]+)\s*\)|([A-Za-z0-9\.\+\-\*,\/]+))(?=\s+\b\d{1,3}\b|\s*$)/gi;
            const matches22 = Array.from("22 3 18-5-7-9-20".matchAll(multiRegex));
            assert.equal(matches22.length, 2, "Old regex matched 18-5 as second question");
            assert.equal(matches22[1][1], "18");
        });

        it('4.2 verifies that remediated AnswerKeyParser enforces monotonic increasing question invariant', async () => {
            const parsed = await AnswerKeyParser.parse(hyphenSnippet);
            assert.equal(parsed.answers.length, 2);
            assert.equal(parsed.answers[0].questionNumber, 22);
            assert.deepEqual(parsed.answers[0].acceptedAnswers, ['C']);
            assert.equal(parsed.answers[1].questionNumber, 99);
            assert.deepEqual(parsed.answers[1].acceptedAnswers, ['A']);
            assert.equal(parsed.answers.find(a => a.questionNumber === 18), undefined);
            assert.equal(parsed.answers.find(a => a.questionNumber === 1), undefined);
        });
    });

    describe('5. Defect 5: Genuine Multi-Column Answer Key Preservation', () => {
        const multiColSnippet = "1 C 2 C 3 B 4 A 5 D";

        it('5.1 extracts all 5 pairs from a genuine monotonic multi-column line', async () => {
            const parsed = await AnswerKeyParser.parse(multiColSnippet);
            assert.equal(parsed.answers.length, 5);
            assert.deepEqual(parsed.answers.map(a => a.acceptedAnswers[0]), ['C', 'C', 'B', 'A', 'D']);
        });
    });

    describe('6. Defect 6: Section Numbering Restarts & Unique Question IDs', () => {
        const restartQP = [
            "PART A – Reasoning",
            "Q1. First reasoning question",
            "(1) A",
            "(2) B",
            "(3) C",
            "(4) D",
            "Q2. Second reasoning question",
            "(1) A",
            "(2) B",
            "(3) C",
            "(4) D",
            "PART B – Quant",
            "Q1. First quant question",
            "(1) A",
            "(2) B",
            "(3) C",
            "(4) D",
            "Q2. Second quant question",
            "(1) A",
            "(2) B",
            "(3) C",
            "(4) D"
        ].join("\n");

        it('6.1 generates unique question IDs across restarting sections', async () => {
            const qp = await QuestionPaperParser.parse(restartQP);
            assert.equal(qp.questions.length, 4);

            const { uirDocument, validation } = await UIRTransformationService.transformDocuments({
                questionPaper: restartQP,
                answerKey: "1 A 2 B",
                paperFormat: "Total Questions: 4\nDuration: 60 Minutes\nEach correct answer carries 1 mark.\nNo negative marking."
            });

            const qIds = uirDocument.questions.map(q => q.questionId);
            const uniqueQIds = new Set(qIds);
            assert.equal(uniqueQIds.size, 4, "All 4 question IDs are strictly unique");
        });
    });
});
