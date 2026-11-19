import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { QuestionPaperParser } from "../server/services/ingestion/questionPaperParser.js";

describe("Universal Question Parser Accuracy Remediation (Phase 5.1)", () => {

    describe("1. Statement-to-Option Separation: Lettered statements with numbered choices", () => {
        it("retains (a)-(d) statements in stem and captures (1)-(4) as choices", () => {
            const rawBlock = `Consider the following statements regarding photosynthesis:
(a) Chlorophyll a is the primary pigment.
(b) Photolysis of water occurs in PS II.
(c) ATP synthesis occurs only during cyclic photophosphorylation.
(d) Dark reactions take place in the stroma.
Choose the correct answer from the options given below:
(1) (a), (b) and (d) only
(2) (a) and (c) only
(3) (b), (c) and (d) only
(4) (a) and (d) only`;

            const parsed = QuestionPaperParser.extractOptionsAndStem(rawBlock);
            assert.equal(parsed.options.length, 4, "Should extract exactly 4 options");
            assert.equal(parsed.options[0].id, "A");
            assert.equal(parsed.options[0].label, "(1)");
            assert.equal(parsed.options[0].text, "(a), (b) and (d) only");
            assert.equal(parsed.options[3].id, "D");
            assert.equal(parsed.options[3].label, "(4)");
            assert.equal(parsed.options[3].text, "(a) and (d) only");

            assert.match(parsed.stem, /\(a\)\s+Chlorophyll\s+a/);
            assert.match(parsed.stem, /\(b\)\s+Photolysis/);
            assert.match(parsed.stem, /\(c\)\s+ATP\s+synthesis/);
            assert.match(parsed.stem, /\(d\)\s+Dark\s+reactions/);
            assert.doesNotMatch(parsed.stem, /\(1\)\s+\(a\),\s+\(b\)/);
        });
    });

    describe("2. Variable Statement Sequences: Five or more statements (a) through (g)", () => {
        it("preserves extensive statement collections (a)-(g) in stem without truncating", () => {
            const rawBlock = `Read the following statements about vertebrate taxonomy:
(a) Cyclostomes have a sucking and circular mouth.
(b) Chondrichthyes have placoid scales.
(c) Osteichthyes possess four pairs of gills.
(d) Amphibians have three-chambered heart.
(e) Reptiles are homoiotherms.
(f) Birds have pneumatic bones.
(g) Mammals possess mammary glands.
Which of the above statements are correct?
(1) (a), (b), (c), (d), (f) and (g) only
(2) (a), (b), (e) and (g) only
(3) (c), (d), (e) and (f) only
(4) All of the above`;

            const parsed = QuestionPaperParser.extractOptionsAndStem(rawBlock);
            assert.equal(parsed.options.length, 4);
            assert.match(parsed.stem, /\(e\)\s+Reptiles\s+are\s+homoiotherms/);
            assert.match(parsed.stem, /\(g\)\s+Mammals\s+possess\s+mammary\s+glands/);
            assert.equal(parsed.options[0].text, "(a), (b), (c), (d), (f) and (g) only");
            assert.equal(parsed.options[3].text, "All of the above");
        });
    });

    describe("3. Lettered Sub-References Inside Option Text", () => {
        it("does not split options containing references like (a) and (b)", () => {
            const rawBlock = `Given below are two statements:
Statement I: Assertion text.
Statement II: Reason text.
In light of the above statements, choose the most appropriate answer:
(1) Both (a) and (b) are correct
(2) Both (a) and (b) are incorrect
(3) (a) is correct but (b) is incorrect
(4) (a) is incorrect but (b) is correct`;

            const parsed = QuestionPaperParser.extractOptionsAndStem(rawBlock);
            assert.equal(parsed.options.length, 4);
            assert.equal(parsed.options[0].text, "Both (a) and (b) are correct");
            assert.equal(parsed.options[1].text, "Both (a) and (b) are incorrect");
            assert.equal(parsed.options[2].text, "(a) is correct but (b) is incorrect");
            assert.equal(parsed.options[3].text, "(a) is incorrect but (b) is correct");
        });
    });

    describe("4. Embedded Figure and Diagram Delimiters", () => {
        it("ignores delimiters inside [Figure: ...] and extracts genuine trailing options", () => {
            const rawBlock = `Identify the correct pair of graphs for thermodynamic processes shown below:
[Figure: Cycle (1) Isochoric and Cycle (2) Isobaric]
The correct combination is:
(1) Graph pair (1)
(2) Graph pair (2)
(3) Both (1) and (2)
(4) Neither (1) nor (2)`;

            const parsed = QuestionPaperParser.extractOptionsAndStem(rawBlock);
            assert.equal(parsed.options.length, 4);
            assert.equal(parsed.options[0].label, "(1)");
            assert.equal(parsed.options[0].text, "Graph pair (1)");
            assert.equal(parsed.options[1].label, "(2)");
            assert.equal(parsed.options[1].text, "Graph pair (2)");
            assert.equal(parsed.options[2].text, "Both (1) and (2)");
            assert.equal(parsed.options[3].text, "Neither (1) nor (2)");
        });
    });

    describe("5. Multi-column and Inline Horizontal Options", () => {
        it("correctly extracts horizontally formatted inline options", () => {
            const rawBlock = `A thermodynamic system undergoes an expansion doing work W. Calculate the heat absorbed:
(1) 400 J    (2) 500 J    (3) 600 J    (4) 700 J`;

            const parsed = QuestionPaperParser.extractOptionsAndStem(rawBlock);
            assert.equal(parsed.options.length, 4);
            assert.equal(parsed.options[0].text, "400 J");
            assert.equal(parsed.options[1].text, "500 J");
            assert.equal(parsed.options[2].text, "600 J");
            assert.equal(parsed.options[3].text, "700 J");
        });
    });

    describe("6. Page Boundary and Repeating Header/Footer Filtering", () => {
        it("strips repeating running headers and footers across pages generically", () => {
            const mockPages = [
                {
                    pageNumber: 1,
                    text: `RE-NEET (UG) 2026 – Code 50 – Typed Question Paper Page 1
SECTION A - PHYSICS
1. A particle moves along a straight line.
(1) 10 m/s
(2) 20 m/s
(3) 30 m/s
(4) 40 m/s
Page 1 / 40`
                },
                {
                    pageNumber: 2,
                    text: `RE-NEET (UG) 2026 – Code 50 – Typed Question Paper Page 2
2. The acceleration of the particle is:
(1) 2 m/s^2
(2) 4 m/s^2
(3) 6 m/s^2
(4) 8 m/s^2
Page 2 / 40`
                }
            ];

            const cleaned = QuestionPaperParser.detectAndFilterPageHeadersFooters(mockPages);
            assert.equal(cleaned.length, 2);
            assert.doesNotMatch(cleaned[0].text, /RE-NEET.*Page\s*1/);
            assert.doesNotMatch(cleaned[0].text, /Page\s*1\s*\/\s*40/);
            assert.doesNotMatch(cleaned[1].text, /RE-NEET.*Page\s*2/);
            assert.doesNotMatch(cleaned[1].text, /Page\s*2\s*\/\s*40/);

            assert.match(cleaned[0].text, /1\.\s+A\s+particle\s+moves/);
            assert.match(cleaned[1].text, /2\.\s+The\s+acceleration/);
        });
    });

    describe("7. Mathematical Formulas, Exponents and Fractional Powers", () => {
        it("preserves exponents like R^{1/2} and R^{3/2} without false fraction filtering", () => {
            const rawBlock = `The radius of gyration of a solid sphere of radius R about its tangent is:
(1) R^{1/2}
(2) R^{3/2}
(3) \\sqrt{7/5} R
(4) \\sqrt{2/5} R`;

            const parsed = QuestionPaperParser.extractOptionsAndStem(rawBlock);
            assert.equal(parsed.options.length, 4);
            assert.equal(parsed.options[0].text, "R^{1/2}");
            assert.equal(parsed.options[1].text, "R^{3/2}");
            assert.equal(parsed.options[2].text, "\\sqrt{7/5} R");
            assert.equal(parsed.options[3].text, "\\sqrt{2/5} R");
        });
    });

    describe("8. Matching-List Tables", () => {
        it("preserves List-I and List-II in stem and extracts trailing match combinations", () => {
            const rawBlock = `Match List-I with List-II:
List-I                List-II
A. Glycolysis         I. Mitochondrial matrix
B. TCA cycle          II. Cytoplasm
C. ETS                III. Thylakoid
D. Photophosphorylation IV. Inner mitochondrial membrane
Choose the correct answer from the options given below:
(1) A-II, B-I, C-IV, D-III
(2) A-I, B-II, C-III, D-IV
(3) A-II, B-IV, C-I, D-III
(4) A-III, B-I, C-IV, D-II`;

            const parsed = QuestionPaperParser.extractOptionsAndStem(rawBlock);
            assert.equal(parsed.options.length, 4);
            assert.match(parsed.stem, /List-I\s+List-II/);
            assert.match(parsed.stem, /A\.\s+Glycolysis/);
            assert.equal(parsed.options[0].text, "A-II, B-I, C-IV, D-III");
            assert.equal(parsed.options[1].text, "A-I, B-II, C-III, D-IV");
        });
    });

    describe("9. NEET Code 50 Full Paper Regression (180 Questions)", () => {
        it("extracts all 180 questions with zero statement collisions and zero footer leaks", async () => {
            const pdfPath = path.resolve("uploads/vault/ecb694d5c0051891_1794769946358_RE-NEET-UG-2026_Code50_Typed_Question_Paper.pdf");
            if (!fs.existsSync(pdfPath)) {
                return; // Skip if test environment does not contain vault
            }
            const buf = fs.readFileSync(pdfPath);
            const result = await QuestionPaperParser.parse(buf);

            assert.equal(result.questions.length, 180, "Must extract exactly 180 questions");

            // Verify statement collisions are 0
            const collidingQuestions = [];
            const footerLeakingQuestions = [];
            const non4OptionsQuestions = [];

            const targetCollisionList = [8, 12, 23, 32, 35, 36, 82, 94, 99, 113, 119, 122, 134, 141, 144, 157, 165, 178];
            const targetFooterList = [6, 13, 20, 26, 33, 40, 53, 61, 69, 77, 85, 90, 108, 117, 126, 135, 153, 161, 170];

            for (const q of result.questions) {
                if (q.options.length !== 4) {
                    non4OptionsQuestions.push(q.questionNumber);
                }

                // Check footer leaks in stem or options
                const stemText = q.stem?.text || q.rawStem || "";
                let hasFooter = /Page\s*\d+|RE-NEET/i.test(stemText);
                for (const opt of q.options) {
                    if (/Page\s*\d+|RE-NEET/i.test(opt.text)) hasFooter = true;
                    // Check statement collision (sub-options embedded inside option text)
                    if (/(?:\([1-4]\)|\b[1-4]\.\s+)[\s\S]*?(?:\([1-4]\)|\b[1-4]\.\s+)/.test(opt.text)) {
                        collidingQuestions.push(q.questionNumber);
                    }
                }
                if (hasFooter) {
                    footerLeakingQuestions.push(q.questionNumber);
                }
            }

            assert.deepEqual(non4OptionsQuestions, [], "No question should have non-4 options");
            assert.deepEqual(collidingQuestions, [], "Zero questions should have statement collisions in options");
            assert.deepEqual(footerLeakingQuestions, [], "Zero questions should leak running headers or footers");

            // Verify Q119 and Q144 specifically
            const q119 = result.questions.find(q => q.questionNumber === 119);
            assert.ok(q119, "Q119 must exist");
            assert.equal(q119.options.length, 4, "Q119 must have exactly 4 options");
            const q119Stem = q119.stem?.text || q119.rawStem || "";
            assert.match(q119Stem, /\(a\)/, "Q119 stem must contain lettered statement (a)");
            assert.match(q119Stem, /\(d\)/, "Q119 stem must contain lettered statement (d)");

            const q144 = result.questions.find(q => q.questionNumber === 144);
            assert.ok(q144, "Q144 must exist");
            assert.equal(q144.options.length, 4, "Q144 must have exactly 4 options");
            const q144Stem = q144.stem?.text || q144.rawStem || "";
            assert.match(q144Stem, /\(a\)/, "Q144 stem must contain lettered statement (a)");
            assert.match(q144Stem, /\(d\)/, "Q144 stem must contain lettered statement (d)");

            // Verify all 18 collision questions now have clean 4 options
            for (const qNum of targetCollisionList) {
                const q = result.questions.find(item => item.questionNumber === qNum);
                assert.ok(q, `Q${qNum} must exist`);
                assert.equal(q.options.length, 4, `Q${qNum} must have exactly 4 options`);
            }

            // Verify all 19 footer questions have no footer leaks
            for (const qNum of targetFooterList) {
                const q = result.questions.find(item => item.questionNumber === qNum);
                assert.ok(q, `Q${qNum} must exist`);
                const stemT = q.stem?.text || q.rawStem || "";
                assert.doesNotMatch(stemT, /Page\s*\d+|RE-NEET/i, `Q${qNum} stem must not leak footer`);
                for (const o of q.options) {
                    assert.doesNotMatch(o.text, /Page\s*\d+|RE-NEET/i, `Q${qNum} option ${o.label} must not leak footer`);
                }
            }
        });
    });

});
