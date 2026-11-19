process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { QuestionReconstructionService } from "../server/services/documentUnderstanding/questionReconstructionService.js";
import { UniversalPdfPageProcessor } from "../server/services/documentUnderstanding/universalPdfPageProcessor.js";
import { UniversalQuestionType } from "../server/services/ingestion/extractionSchema.js";

describe("Phase 4.5 — Question Reconstruction & Layout Disambiguation", () => {

    it("1.1 reconstructs horizontal 2x2 option grids into 4 distinct choices", () => {
        const visionQuestions = [
            {
                questionNumber: 1,
                stem: "A particle starts from origin with velocity $\\vec{v} = 3\\hat{i} + 4\\hat{j}$ m/s.",
                hasDiagram: false,
                options: [
                    { label: "(1)", text: "3" },
                    { label: "(2)", text: "1" },
                    { label: "(3)", text: "\\frac{1}{3}" },
                    { label: "(4)", text: "\\frac{1}{2}" }
                ]
            }
        ];

        const reconstructed = QuestionReconstructionService.reconstructQuestions(visionQuestions);
        assert.equal(reconstructed.length, 1);

        const q = reconstructed[0];
        assert.equal(q.questionNumber, 1);
        assert.equal(q.options.length, 4, "Must reconstruct exactly 4 options");
        assert.deepEqual(q.options.map(o => o.id), ["A", "B", "C", "D"]);
        assert.equal(q.options[0].text, "3");
        assert.equal(q.options[1].text, "1");
        assert.equal(q.options[2].text, "\\frac{1}{3}");
        assert.equal(q.options[3].text, "\\frac{1}{2}");
    });

    it("1.2 cleanly separates solution derivations from question stems", () => {
        const rawStemWithSol = "What is the force on a charge $q$ moving in magnetic field $\\vec{B}$?\nAns. (2)\nSol. Lorentz force is given by $\\vec{F} = q(\\vec{v} \\times \\vec{B})$.";
        const { cleanStem, solutionText } = QuestionReconstructionService.extractSolutionFromStem(rawStemWithSol);

        assert.ok(!cleanStem.includes("Ans."), "Question stem must NOT contain 'Ans.'");
        assert.ok(!cleanStem.includes("Sol."), "Question stem must NOT contain 'Sol.'");
        assert.equal(cleanStem, "What is the force on a charge $q$ moving in magnetic field $\\vec{B}$?");
        assert.ok(solutionText.includes("Lorentz force"));
    });

    it("1.3 preserves complex LaTeX formulas and scientific units", () => {
        const complexStem = "The de Broglie wavelength is $\\lambda = \\frac{h}{\\sqrt{2mE}}$. If kinetic energy increases 4-fold, the new wavelength is:";
        const { cleanStem } = QuestionReconstructionService.extractSolutionFromStem(complexStem);

        assert.ok(cleanStem.includes("\\frac{h}{\\sqrt{2mE}}"), "Must preserve exact LaTeX fraction and square root");
        assert.ok(cleanStem.includes("\\lambda"), "Must preserve Greek symbols");
    });

    it("1.4 detects Universal Question Types reliably", () => {
        // Assertion - Reason
        const arType = QuestionReconstructionService.detectQuestionType(
            "Given below are two statements: Assertion (A): Photosynthesis requires light. Reason (R): Light energizes chlorophyll."
        );
        assert.equal(arType, UniversalQuestionType.ASSERTION_REASON);

        // Match the Following
        const matchType = QuestionReconstructionService.detectQuestionType(
            "Match List-I with List-II:\nList-I (A) Root (B) Stem\nList-II (1) Water uptake (2) Support"
        );
        assert.equal(matchType, UniversalQuestionType.MATCH_FOLLOWING);

        // Numerical / NAT
        const natType = QuestionReconstructionService.detectQuestionType(
            "Calculate the nearest integer value of gravitational potential energy.",
            []
        );
        assert.equal(natType, UniversalQuestionType.NUMERICAL_NAT);

        // Standard Single Choice MCQ
        const mcqType = QuestionReconstructionService.detectQuestionType(
            "Which of the following elements has the highest electronegativity?",
            [{ id: "A", text: "F" }, { id: "B", text: "Cl" }, { id: "C", text: "Br" }, { id: "D", text: "I" }]
        );
        assert.equal(mcqType, UniversalQuestionType.SINGLE_CHOICE_MCQ);
    });

    it("1.5 computes multi-component confidence metrics accurately", () => {
        const confComplete = QuestionReconstructionService.computeMultiComponentConfidence({
            stem: "A ray of light enters a glass slab of refractive index $\\mu = 1.5$ at angle $30^\\circ$.",
            options: [
                { id: "A", text: "15 deg" },
                { id: "B", text: "19.5 deg" },
                { id: "C", text: "30 deg" },
                { id: "D", text: "45 deg" }
            ],
            hasDiagram: false
        });

        assert.ok(confComplete.stemConfidence >= 0.85, "Stem confidence should be high for clear text");
        assert.equal(confComplete.optionsConfidence, 0.98, "Options confidence should be 0.98 for 4 distinct options");
        assert.ok(confComplete.mathConfidence >= 0.90, "Math confidence should be >= 0.90");
        assert.ok(confComplete.overallConfidence >= 0.90, "Overall confidence should be >= 0.90");

        // Partial options penalty
        const confPartial = QuestionReconstructionService.computeMultiComponentConfidence({
            stem: "Short stem",
            options: [{ id: "A", text: "Option A only" }]
        });
        assert.ok(confPartial.optionsConfidence <= 0.30, "Single option should have low options confidence");
        assert.ok(confPartial.overallConfidence < 0.60, "Overall confidence should reflect partial options");
    });

    it("1.6 enforces minimum 32x32 pixel bounds in pure-JS image cropping", () => {
        const testImgPath = path.join(process.cwd(), "uploads", "vault", "diagrams", "diag_test_raster_p1_img1.png");
        if (fs.existsSync(testImgPath)) {
            // Attempt to crop a tiny 10x10 rectangle
            const cropTiny = UniversalPdfPageProcessor.cropImage(testImgPath, [100, 100, 110, 110]);
            assert.ok(cropTiny.width >= 32, "Cropped width must be expanded to at least 32px");
            assert.ok(cropTiny.height >= 32, "Cropped height must be expanded to at least 32px");
            assert.ok(Buffer.isBuffer(cropTiny.buffer), "Cropped result must return a valid PNG Buffer");
            assert.equal(cropTiny.buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Must have valid PNG signature");
        }
    });

    it("1.7 enhances incomplete OCR questions with vision 4-option reconstruction", () => {
        // Mock OCR question with only 2 options extracted (due to 2x2 horizontal layout)
        const ocrQuestions = [
            {
                questionNumber: 5,
                questionText: "Which of the following is correct?",
                options: [
                    { id: "A", text: "First option" },
                    { id: "B", text: "Second option" }
                ],
                sectionId: "sec_physics",
                sectionName: "Physics",
                provenance: {
                    sourceDocId: "question_paper",
                    originalPdfPage: 2,
                    confidence: 0.60,
                    bbox: [100, 200, 500, 400],
                    extractionMethod: "ocr_layout_reconstruction"
                }
            }
        ];

        // Vision output from that page with all 4 options resolved
        const visionQuestions = [
            {
                questionNumber: 5,
                stem: "Which of the following is correct?",
                options: [
                    { label: "(1)", text: "First option" },
                    { label: "(2)", text: "Second option" },
                    { label: "(3)", text: "Third option" },
                    { label: "(4)", text: "Fourth option" }
                ]
            }
        ];

        const enhanced = QuestionReconstructionService.enhanceOcrQuestionsWithVision(ocrQuestions, visionQuestions);
        assert.equal(enhanced.length, 1);

        const q5 = enhanced[0];
        assert.equal(q5.options.length, 4, "Must elevate to 4 clean options");
        assert.equal(q5.sectionId, "sec_physics", "Must preserve section assignment");
        assert.equal(q5.provenance.extractionMethod, "hybrid_ocr_vision");
        assert.deepEqual(q5.provenance.bbox, [100, 200, 500, 400], "Must preserve spatial bounding box from OCR");
    });
});
