import test from "node:test";
import assert from "node:assert/strict";
import { AutomatedReviewReductionService } from "../server/services/documentUnderstanding/automatedReviewReductionService.js";

test("AutomatedReviewReductionService - Layout Issue Classification", async (t) => {
    await t.test("classifies matching table questions accurately", () => {
        const q = {
            questionNumber: 80,
            questionText: "Match List-I with List-II:\nList-I\nList-II",
            options: []
        };
        const issue = AutomatedReviewReductionService.classifyIssue(q, []);
        assert.equal(issue, "matchingTable");
    });

    await t.test("classifies multi-statement questions accurately", () => {
        const q = {
            questionNumber: 94,
            questionText: "Which of the following are characteristics?\n(a) statement A\n(b) statement B",
            options: [
                { id: "1", text: "statement A" },
                { id: "2", text: "statement B" },
                { id: "3", text: "(a) and (b) only" },
                { id: "4", text: "(b) only" }
            ]
        };
        const issue = AutomatedReviewReductionService.classifyIssue(q, []);
        assert.equal(issue, "multiStatement");
    });

    await t.test("classifies OCR duplicate / collision questions accurately", () => {
        const q = {
            questionNumber: 68,
            questionText: "The formula of tetraammine...",
            options: [
                { id: "1", text: "[Co" },
                { id: "2", text: "[Co" },
                { id: "3", text: "[Co" },
                { id: "4", text: "[Co" }
            ]
        };
        const issue = AutomatedReviewReductionService.classifyIssue(q, []);
        assert.equal(issue, "ocrCollisionDuplicate");
    });

    await t.test("classifies inline delimiter questions accurately", () => {
        const q = {
            questionNumber: 8,
            questionText: "A beam of light falls...",
            options: []
        };
        const issue = AutomatedReviewReductionService.classifyIssue(q, []);
        assert.equal(issue, "inlineDelimiter");
    });

    await t.test("classifies diagram association questions accurately", () => {
        const q = {
            questionNumber: 3,
            questionText: "Two identical inductors as shown in figure...",
            diagram: { path: "uploads/vault/diagrams/d1.png", isVerified: true },
            options: [{ id: "1", text: "opt 1" }]
        };
        const issue = AutomatedReviewReductionService.classifyIssue(q, []);
        assert.equal(issue, "diagramAssociation");
    });

    await t.test("defaults to horizontalGrid for sub-4 options without table/diagram/statement", () => {
        const q = {
            questionNumber: 1,
            questionText: "A particle of mass M...",
            options: [
                { id: "1", text: "3" },
                { id: "2", text: "1" }
            ]
        };
        const issue = AutomatedReviewReductionService.classifyIssue(q, []);
        assert.equal(issue, "horizontalGrid");
    });
});

test("AutomatedReviewReductionService - Robust Bounding Box Calculation", async (t) => {
    await t.test("stops crop before printed solution (Ans. / Sol.)", () => {
        const lines = [
            { text: "1. A particle of mass M moves...", bbox: { x0: 72, y0: 269, x1: 574, y1: 288 } },
            { text: "(1) 3   (2) 1", bbox: { x0: 72, y0: 468, x1: 574, y1: 487 } },
            { text: "(3) 1/3 (4) 1/2", bbox: { x0: 72, y0: 511, x1: 574, y1: 541 } },
            { text: "Ans. (4)", bbox: { x0: 72, y0: 556, x1: 200, y1: 575 } },
            { text: "Sol. Friction force...", bbox: { x0: 72, y0: 586, x1: 574, y1: 607 } }
        ];

        const bbox = AutomatedReviewReductionService.computeCropBbox(1, lines);
        assert.ok(bbox, "Bounding box must be computed");
        const [x0, y0, x1, y1] = bbox;
        assert.equal(x0, 55, "Column 1 left margin snapped");
        assert.equal(x1, 585, "Column 1 right margin snapped");
        assert.ok(y0 <= 269, "Top boundary encompasses question header");
        assert.ok(y1 < 556, "Bottom boundary stops strictly before Ans. (4)");
        assert.ok(y1 >= 541, "Bottom boundary encompasses option choices");
    });

    await t.test("handles Column 2 layout gracefully", () => {
        const lines = [
            { text: "15. An alternating current...", bbox: { x0: 620, y0: 300, x1: 1100, y1: 320 } },
            { text: "(1) 5A (2) 10A", bbox: { x0: 620, y0: 400, x1: 1100, y1: 420 } },
            { text: "16. In a semiconductor...", bbox: { x0: 620, y0: 500, x1: 1100, y1: 520 } }
        ];

        const bbox = AutomatedReviewReductionService.computeCropBbox(15, lines);
        assert.ok(bbox);
        const [x0, y0, x1, y1] = bbox;
        assert.equal(x0, 585, "Column 2 left margin snapped");
        assert.equal(x1, 1125, "Column 2 right margin snapped");
        assert.ok(y1 < 500, "Stops before Question 16");
    });
});

test("AutomatedReviewReductionService - Layout Prompt Construction", async (t) => {
    await t.test("builds specialized prompt for 2x2 grids", () => {
        const prompt = AutomatedReviewReductionService.buildLayoutPrompt(1, "horizontalGrid", {});
        assert.ok(prompt.includes("2x2 horizontal grid"));
        assert.ok(prompt.includes("LaTeX"));
    });

    await t.test("builds specialized prompt for matching tables", () => {
        const prompt = AutomatedReviewReductionService.buildLayoutPrompt(80, "matchingTable", {});
        assert.ok(prompt.includes("matchingTable"));
        assert.ok(prompt.includes("List-I and List-II"));
    });

    await t.test("builds specialized prompt for multi-statement questions", () => {
        const prompt = AutomatedReviewReductionService.buildLayoutPrompt(94, "multiStatement", {});
        assert.ok(prompt.includes("KEEP ALL STATEMENTS IN THE QUESTION STEM"));
    });
});

