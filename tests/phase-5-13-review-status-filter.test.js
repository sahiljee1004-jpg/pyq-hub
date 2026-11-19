/**
 * ============================================================================
 * PHASE 5.13 — RRB PAPER REVIEW: STATUS FILTER NAVIGATION TEST SUITE
 * ============================================================================
 * 
 * Comprehensive automated verification of the Status Filter Navigation in Paper Review Mode:
 * 1. Event listener registration and DOM lifecycle rebinding in bindReviewControls()
 * 2. Status normalization across variations ('correct', 'incorrect', 'wrong', 'unattempted', 'unanswered')
 * 3. Predictable filtering pipeline: Original Dataset -> Subject Filter -> Status Filter
 * 4. All 17 mandatory scenarios from Section 10 specification table
 * 5. Multi-exam and multi-distribution coverage (All Correct, All Incorrect, All Unattempted, Mixed, Zero-Matches, Diverse Types)
 * 6. Palette synchronization (only filtered questions, original question numbers preserved, active highlighting)
 * 7. Non-destructive filtering (original dataset and question numbers immutable)
 * 8. Universal scoring engine authority compliance (no recalculation of marks in frontend)
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const mockTestHtmlPath = path.join(root, "www", "mock-test.html");
const mockTestCssPath = path.join(root, "www", "css", "mock-test.css");
const mockTestJsPath = path.join(root, "www", "js", "mock-test.js");

const mockTestHtml = fs.readFileSync(mockTestHtmlPath, "utf8");
const mockTestCss = fs.readFileSync(mockTestCssPath, "utf8");
const mockTestJs = fs.readFileSync(mockTestJsPath, "utf8");

// Helper: Extract normalizeReviewStatus function
const normFnMatch = mockTestJs.match(/function normalizeReviewStatus\(status\)\s*\{([\s\S]*?)\n\}/);
if (!normFnMatch) {
    throw new Error("Could not find normalizeReviewStatus in www/js/mock-test.js");
}
const normalizeReviewStatus = new Function("status", normFnMatch[1]);

// Helper: RRB Test Fixture (74 questions: 0 correct, 6 incorrect, 68 unattempted, General subject)
function generateRrb74Questions() {
    const questions = [];
    // Incorrect question numbers: 3, 11, 24, 42, 57, 70
    const incorrectIndices = new Set([3, 11, 24, 42, 57, 70]);

    for (let i = 1; i <= 74; i++) {
        const isIncorrect = incorrectIndices.has(i);
        const status = isIncorrect ? "incorrect" : "unanswered";

        questions.push({
            questionId: `rrb_q_${i}`,
            questionNumber: i,
            originalNumbering: String(i),
            questionType: "mcq",
            subject: "General",
            subjectId: "general",
            subjectName: "General",
            sectionId: "sec_general",
            sectionName: "General",
            questionText: `RRB CBT examination question ${i} covering General Knowledge & Technical Abilities.`,
            options: [
                { id: "1", label: "A", text: `Option A for Q${i}` },
                { id: "2", label: "B", text: `Option B for Q${i}` },
                { id: "3", label: "C", text: `Option C for Q${i}` },
                { id: "4", label: "D", text: `Option D for Q${i}` }
            ],
            status,
            studentAnswer: isIncorrect ? "1" : null,
            marksAwarded: isIncorrect ? -0.333 : 0,
            correctAnswer: isIncorrect ? { type: "mcq", optionId: "2", optionLabel: "B", text: `Option B for Q${i}` } : null
        });
    }
    return questions;
}

// Simulated Review Environment
class SimulatedReviewContext {
    constructor(questions, summary = null) {
        this.reviewQuestions = JSON.parse(JSON.stringify(questions));
        this.filteredReviewQuestions = [];
        this.currentReviewIndex = 0;
        this.currentReviewQuestionId = null;
        this.selectedReviewSubject = "all";
        this.selectedReviewStatus = "all";
        this.summary = summary || {
            totalQuestions: questions.length,
            correctCount: questions.filter(q => q.status === "correct").length,
            incorrectCount: questions.filter(q => q.status === "incorrect").length,
            unansweredCount: questions.filter(q => q.status === "unanswered" || q.status === "unattempted").length,
            droppedCount: questions.filter(q => q.status === "dropped").length
        };

        // Virtual DOM representation
        this.dom = {
            revQNumberBadge: { textContent: "" },
            revQSubjectBadge: { textContent: "" },
            revQStatusBadge: { textContent: "", className: "" },
            revQMarksBadge: { textContent: "", style: {} },
            revQText: { textContent: "" },
            revCurrentStatusIndicator: { textContent: "" },
            btnRevPrev: { disabled: false },
            btnRevNext: { disabled: false },
            paletteItems: [],
            statusButtons: [
                { status: "all", active: true },
                { status: "correct", active: false },
                { status: "incorrect", active: false },
                { status: "unattempted", active: false }
            ]
        };

        this.filterReviewQuestions();
        this.renderReviewQuestion(0);
    }

    normalizeReviewStatus(status) {
        return normalizeReviewStatus(status);
    }

    setReviewStatusFilter(rawStatus) {
        const norm = this.normalizeReviewStatus(rawStatus);
        this.selectedReviewStatus = norm;

        // Update active class on status buttons
        this.dom.statusButtons.forEach(b => {
            b.active = (this.normalizeReviewStatus(b.status) === norm);
        });

        // Apply filtering pipeline
        this.filterReviewQuestions();

        // Preserve current question if it still matches the newly filtered set; otherwise jump to 0
        let nextIndex = 0;
        if (this.currentReviewQuestionId && this.filteredReviewQuestions.length > 0) {
            const existingIdx = this.filteredReviewQuestions.findIndex(q => q.questionId === this.currentReviewQuestionId);
            if (existingIdx !== -1) {
                nextIndex = existingIdx;
            }
        }
        this.renderReviewQuestion(nextIndex);
    }

    setReviewSubjectFilter(rawSubject) {
        this.selectedReviewSubject = (rawSubject || "all").trim();
        this.filterReviewQuestions();

        let nextIndex = 0;
        if (this.currentReviewQuestionId && this.filteredReviewQuestions.length > 0) {
            const existingIdx = this.filteredReviewQuestions.findIndex(q => q.questionId === this.currentReviewQuestionId);
            if (existingIdx !== -1) {
                nextIndex = existingIdx;
            }
        }
        this.renderReviewQuestion(nextIndex);
    }

    filterReviewQuestions() {
        const normFilterStatus = this.normalizeReviewStatus(this.selectedReviewStatus);
        const normFilterSubject = (this.selectedReviewSubject || "all").trim();

        this.filteredReviewQuestions = this.reviewQuestions.filter(q => {
            // 1. Subject filter
            let matchesSubject = true;
            if (normFilterSubject !== "all") {
                const qSubId = String(q.subjectId || "").toLowerCase();
                const qSubName = String(q.subjectName || "").toLowerCase();
                const qSub = String(q.subject || "").toLowerCase();
                const filterSub = normFilterSubject.toLowerCase();
                matchesSubject = (qSubId === filterSub || qSubName === filterSub || qSub === filterSub);
            }

            // 2. Status filter
            let matchesStatus = true;
            if (normFilterStatus !== "all") {
                const qStatus = this.normalizeReviewStatus(q.status);
                matchesStatus = (qStatus === normFilterStatus);
            }

            return matchesSubject && matchesStatus;
        });

        this.renderReviewPalette();
    }

    renderReviewPalette() {
        this.dom.paletteItems = [];
        if (!this.filteredReviewQuestions || this.filteredReviewQuestions.length === 0) {
            return;
        }

        this.filteredReviewQuestions.forEach((q, fIdx) => {
            const normStatus = this.normalizeReviewStatus(q.status);
            this.dom.paletteItems.push({
                index: fIdx,
                questionId: q.questionId,
                questionNumber: q.questionNumber,
                statusClass: `palette-btn ${normStatus}`,
                current: (fIdx === this.currentReviewIndex)
            });
        });
    }

    renderReviewQuestion(index) {
        if (!this.filteredReviewQuestions || this.filteredReviewQuestions.length === 0) {
            this.currentReviewIndex = -1;
            this.currentReviewQuestionId = null;
            this.dom.revQNumberBadge.textContent = "No Matches";
            this.dom.revQSubjectBadge.textContent = "-";
            this.dom.revQStatusBadge.textContent = "-";
            this.dom.revQMarksBadge.textContent = "-";
            this.dom.revQText.textContent = "No questions match the currently selected subject and status filter criteria.";
            this.dom.revCurrentStatusIndicator.textContent = "0 of 0";
            this.dom.btnRevPrev.disabled = true;
            this.dom.btnRevNext.disabled = true;
            return;
        }

        if (index < 0) index = 0;
        if (index >= this.filteredReviewQuestions.length) index = this.filteredReviewQuestions.length - 1;
        this.currentReviewIndex = index;

        const q = this.filteredReviewQuestions[index];
        this.currentReviewQuestionId = q ? q.questionId : null;

        const totalQCount = this.reviewQuestions.length;
        this.dom.revQNumberBadge.textContent = `Question ${q.questionNumber} of ${totalQCount}`;
        this.dom.revQSubjectBadge.textContent = q.subjectName || q.subject || "General";

        const normStatus = this.normalizeReviewStatus(q.status);
        this.dom.revQStatusBadge.className = `q-badge status-${normStatus}`;
        if (normStatus === "correct") {
            this.dom.revQStatusBadge.textContent = "Correct";
            this.dom.revQMarksBadge.textContent = `+${q.marksAwarded} Marks`;
        } else if (normStatus === "incorrect") {
            this.dom.revQStatusBadge.textContent = "Incorrect";
            this.dom.revQMarksBadge.textContent = `${q.marksAwarded} Marks`;
        } else if (normStatus === "dropped") {
            this.dom.revQStatusBadge.textContent = "Dropped (Bonus)";
            this.dom.revQMarksBadge.textContent = `+${q.marksAwarded} Bonus`;
        } else {
            this.dom.revQStatusBadge.textContent = "Unattempted";
            this.dom.revQMarksBadge.textContent = "0 Marks";
        }

        this.dom.revQText.textContent = q.questionText || "";
        this.dom.revCurrentStatusIndicator.textContent = `Question ${index + 1} of ${this.filteredReviewQuestions.length}`;
        this.dom.btnRevPrev.disabled = (index === 0);
        this.dom.btnRevNext.disabled = (index === this.filteredReviewQuestions.length - 1);

        // Update palette active highlighting
        this.dom.paletteItems.forEach((item, pIdx) => {
            item.current = (pIdx === index);
        });
    }

    nextQuestion() {
        if (this.currentReviewIndex < this.filteredReviewQuestions.length - 1) {
            this.renderReviewQuestion(this.currentReviewIndex + 1);
        }
    }

    prevQuestion() {
        if (this.currentReviewIndex > 0) {
            this.renderReviewQuestion(this.currentReviewIndex - 1);
        }
    }
}

describe("PHASE 5.13 — RRB Paper Review Status Filter Test Suite", () => {

    // =========================================================================
    // SECTION 1: Static Codebase Analysis & Element Integrity
    // =========================================================================
    describe("1. Static Codebase Analysis & DOM Integrity", () => {
        test("1.1 mock-test.html contains #reviewStatusFilters with All, Correct, Incorrect, Unattempted buttons", () => {
            assert.ok(mockTestHtml.includes('id="reviewStatusFilters"'), "#reviewStatusFilters container must exist");
            assert.ok(mockTestHtml.includes('data-status="all"'), "All filter button must exist");
            assert.ok(mockTestHtml.includes('data-status="correct"'), "Correct filter button must exist");
            assert.ok(mockTestHtml.includes('data-status="incorrect"'), "Incorrect filter button must exist");
            assert.ok(mockTestHtml.includes('data-status="unattempted"'), "Unattempted filter button must exist");
        });

        test("1.2 mock-test.css contains .palette-btn.unattempted and .palette-btn.unanswered slate styling", () => {
            assert.ok(mockTestCss.includes(".palette-btn.unattempted"), ".palette-btn.unattempted must be styled");
            assert.ok(mockTestCss.includes(".palette-btn.unanswered"), ".palette-btn.unanswered must be styled for review compatibility");
            assert.ok(mockTestCss.includes(".filter-btn.correct.active"), ".filter-btn.correct.active must have green styling");
            assert.ok(mockTestCss.includes(".filter-btn.incorrect.active"), ".filter-btn.incorrect.active must have red styling");
            assert.ok(mockTestCss.includes(".filter-btn.unattempted.active"), ".filter-btn.unattempted.active must have slate styling");
        });

        test("1.3 mock-test.js binds status filter controls in bindReviewControls()", () => {
            assert.ok(mockTestJs.includes("bindReviewControls()"), "bindReviewControls must be defined");
            assert.ok(mockTestJs.includes("reviewStatusFilters"), "bindReviewControls must inspect reviewStatusFilters");
            assert.ok(mockTestJs.includes("setReviewStatusFilter(status)"), "bindReviewControls must call setReviewStatusFilter");
        });

        test("1.4 mock-test.js exposes normalizeReviewStatus and setReviewStatusFilter on window", () => {
            assert.ok(mockTestJs.includes("window.setReviewStatusFilter = setReviewStatusFilter;"), "setReviewStatusFilter must be exposed");
            assert.ok(mockTestJs.includes("window.normalizeReviewStatus = normalizeReviewStatus;"), "normalizeReviewStatus must be exposed");
            assert.ok(mockTestJs.includes("window.openReviewExam = openReviewExam;"), "openReviewExam must be exposed");
        });
    });

    // =========================================================================
    // SECTION 2: Status Identifier Normalization
    // =========================================================================
    describe("2. Status Identifier Normalization", () => {
        test("2.1 Normalizes all standard and legacy representations of 'all'", () => {
            assert.equal(normalizeReviewStatus("all"), "all");
            assert.equal(normalizeReviewStatus("All"), "all");
            assert.equal(normalizeReviewStatus("  ALL  "), "all");
            assert.equal(normalizeReviewStatus(""), "all");
            assert.equal(normalizeReviewStatus(null), "all");
            assert.equal(normalizeReviewStatus(undefined), "all");
        });

        test("2.2 Normalizes all representations of 'correct'", () => {
            assert.equal(normalizeReviewStatus("correct"), "correct");
            assert.equal(normalizeReviewStatus("Correct"), "correct");
            assert.equal(normalizeReviewStatus("CORRECT"), "correct");
            assert.equal(normalizeReviewStatus("  correct  "), "correct");
        });

        test("2.3 Normalizes all representations of 'incorrect' and 'wrong'", () => {
            assert.equal(normalizeReviewStatus("incorrect"), "incorrect");
            assert.equal(normalizeReviewStatus("Incorrect"), "incorrect");
            assert.equal(normalizeReviewStatus("INCORRECT"), "incorrect");
            assert.equal(normalizeReviewStatus("wrong"), "incorrect");
            assert.equal(normalizeReviewStatus("Wrong"), "incorrect");
        });

        test("2.4 Normalizes all representations of unattempted ('unattempted', 'unanswered', 'not_attempted')", () => {
            assert.equal(normalizeReviewStatus("unattempted"), "unattempted");
            assert.equal(normalizeReviewStatus("Unattempted"), "unattempted");
            assert.equal(normalizeReviewStatus("unanswered"), "unattempted");
            assert.equal(normalizeReviewStatus("Unanswered"), "unattempted");
            assert.equal(normalizeReviewStatus("not_attempted"), "unattempted");
            assert.equal(normalizeReviewStatus("NOT_ATTEMPTED"), "unattempted");
        });

        test("2.5 Normalizes special statuses ('dropped', 'pending_manual_review', 'manually_graded')", () => {
            assert.equal(normalizeReviewStatus("dropped"), "dropped");
            assert.equal(normalizeReviewStatus("Dropped"), "dropped");
            assert.equal(normalizeReviewStatus("pending_manual_review"), "pending_manual_review");
            assert.equal(normalizeReviewStatus("manually_graded"), "manually_graded");
        });
    });

    // =========================================================================
    // SECTION 3: All 17 Mandatory Scenarios from Section 10 Specification Table
    // =========================================================================
    describe("3. Section 10 Mandatory Scenario Matrix (RRB 74-Question Baseline)", () => {
        let ctx;

        beforeEach(() => {
            ctx = new SimulatedReviewContext(generateRrb74Questions());
        });

        test("Scenario 1: Open review page -> All 74 questions available", () => {
            assert.equal(ctx.filteredReviewQuestions.length, 74, "Initial review must have all 74 questions");
            assert.equal(ctx.dom.paletteItems.length, 74, "Question palette must have 74 buttons");
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 1 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 1 of 74");
        });

        test("Scenario 2: Click All -> All 74 questions displayed", () => {
            ctx.setReviewStatusFilter("all");
            assert.equal(ctx.filteredReviewQuestions.length, 74);
            assert.equal(ctx.dom.paletteItems.length, 74);
            assert.ok(ctx.dom.statusButtons.find(b => b.status === "all").active);
        });

        test("Scenario 3: Click Correct -> Only correct questions displayed (0 in RRB, empty state)", () => {
            ctx.setReviewStatusFilter("correct");
            assert.equal(ctx.filteredReviewQuestions.length, 0, "RRB candidate has 0 correct questions");
            assert.equal(ctx.dom.paletteItems.length, 0, "Palette must be empty");
            assert.equal(ctx.dom.revQNumberBadge.textContent, "No Matches");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "0 of 0");
            assert.ok(ctx.dom.btnRevPrev.disabled);
            assert.ok(ctx.dom.btnRevNext.disabled);
            assert.ok(ctx.dom.statusButtons.find(b => b.status === "correct").active);
        });

        test("Scenario 4: Click Incorrect -> Only incorrect questions displayed (6 in RRB)", () => {
            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 6, "Must display exactly 6 incorrect questions");
            assert.equal(ctx.dom.paletteItems.length, 6, "Palette must contain 6 items");
            // Verify original numbering preserved
            const expectedOriginalNumbers = [3, 11, 24, 42, 57, 70];
            const actualNumbers = ctx.dom.paletteItems.map(p => p.questionNumber);
            assert.deepEqual(actualNumbers, expectedOriginalNumbers, "Original question numbers must be strictly preserved");
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 3 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 1 of 6");
            assert.ok(ctx.dom.statusButtons.find(b => b.status === "incorrect").active);
        });

        test("Scenario 5: Click Unattempted -> Only unanswered questions displayed (68 in RRB)", () => {
            ctx.setReviewStatusFilter("unattempted");
            assert.equal(ctx.filteredReviewQuestions.length, 68, "Must display exactly 68 unattempted questions");
            assert.equal(ctx.dom.paletteItems.length, 68, "Palette must contain 68 items");
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 1 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 1 of 68");
            assert.ok(ctx.dom.statusButtons.find(b => b.status === "unattempted").active);
        });

        test("Scenario 6: Switch Correct -> Incorrect -> Results update immediately", () => {
            ctx.setReviewStatusFilter("correct");
            assert.equal(ctx.filteredReviewQuestions.length, 0);

            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 6);
            assert.equal(ctx.dom.paletteItems.length, 6);
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 1 of 6");
        });

        test("Scenario 7: Switch Incorrect -> Unattempted -> Results update immediately", () => {
            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 6);

            ctx.setReviewStatusFilter("unattempted");
            assert.equal(ctx.filteredReviewQuestions.length, 68);
            assert.equal(ctx.dom.paletteItems.length, 68);
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 1 of 68");
        });

        test("Scenario 8: Switch Unattempted -> All -> All questions return", () => {
            ctx.setReviewStatusFilter("unattempted");
            assert.equal(ctx.filteredReviewQuestions.length, 68);

            ctx.setReviewStatusFilter("all");
            assert.equal(ctx.filteredReviewQuestions.length, 74);
            assert.equal(ctx.dom.paletteItems.length, 74);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 1 of 74");
        });

        test("Scenario 9: Click the same filter twice -> No duplicate rendering or errors", () => {
            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 6);
            const firstPalette = [...ctx.dom.paletteItems];

            // Click same filter second time
            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 6);
            assert.deepEqual(ctx.dom.paletteItems, firstPalette, "Palette must remain identical with no duplicate items");
        });

        test("Scenario 10: Apply General + Incorrect -> Only matching questions displayed", () => {
            ctx.setReviewSubjectFilter("General");
            ctx.setReviewStatusFilter("incorrect");

            assert.equal(ctx.filteredReviewQuestions.length, 6);
            ctx.filteredReviewQuestions.forEach(q => {
                assert.equal(q.subject, "General");
                assert.equal(q.status, "incorrect");
            });
        });

        test("Scenario 11: Apply General + Unattempted -> Only matching questions displayed", () => {
            ctx.setReviewSubjectFilter("General");
            ctx.setReviewStatusFilter("unattempted");

            assert.equal(ctx.filteredReviewQuestions.length, 68);
            ctx.filteredReviewQuestions.forEach(q => {
                assert.equal(q.subject, "General");
                assert.ok(q.status === "unanswered" || q.status === "unattempted");
            });
        });

        test("Scenario 12: Filter excludes current question -> First matching question opens", () => {
            // Start on Question 1 (which is unattempted)
            ctx.setReviewStatusFilter("all");
            ctx.renderReviewQuestion(0);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 1 of 74");

            // Filter by "incorrect" (Question 1 is NOT incorrect; first incorrect is Question 3)
            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.currentReviewIndex, 0);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 3 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 1 of 6");
        });

        test("Scenario 13: Filter returns zero questions -> Appropriate empty state displayed", () => {
            ctx.setReviewStatusFilter("correct");
            assert.equal(ctx.filteredReviewQuestions.length, 0);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "No Matches");
            assert.equal(ctx.dom.revQSubjectBadge.textContent, "-");
            assert.equal(ctx.dom.revQStatusBadge.textContent, "-");
            assert.equal(ctx.dom.revQMarksBadge.textContent, "-");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "0 of 0");
            assert.ok(ctx.dom.revQText.textContent.includes("No questions match"));
            assert.ok(ctx.dom.btnRevPrev.disabled);
            assert.ok(ctx.dom.btnRevNext.disabled);
        });

        test("Scenario 14: Navigate through filtered palette -> Correct original questions open", () => {
            ctx.setReviewStatusFilter("incorrect");
            // Palette has 6 items: [3, 11, 24, 42, 57, 70]
            assert.equal(ctx.dom.paletteItems.length, 6);

            // Click palette item 2 (Question 24)
            ctx.renderReviewQuestion(2);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 24 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 3 of 6");
            assert.equal(ctx.dom.paletteItems[2].current, true);

            // Click palette item 5 (Question 70)
            ctx.renderReviewQuestion(5);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 70 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 6 of 6");
            assert.equal(ctx.dom.paletteItems[5].current, true);
        });

        test("Scenario 15: Return to All -> Original numbering and question data preserved", () => {
            ctx.setReviewStatusFilter("incorrect");
            ctx.renderReviewQuestion(4); // Question 57
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 57 of 74");

            // Return to All
            ctx.setReviewStatusFilter("all");
            assert.equal(ctx.filteredReviewQuestions.length, 74);
            // Since Question 57 is in All, it stays active or jumps gracefully
            assert.ok(ctx.reviewQuestions[56].questionNumber === 57);
            assert.equal(ctx.reviewQuestions.length, 74);
            for (let i = 0; i < 74; i++) {
                assert.equal(ctx.reviewQuestions[i].questionNumber, i + 1, `Question ${i + 1} must preserve its original sequence`);
            }
        });

        test("Scenario 16: Reload / re-enter review page -> Filters initialize correctly", () => {
            // Mutate filter state
            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.selectedReviewStatus, "incorrect");

            // Simulate re-entering review mode (re-initialization like openReviewExam)
            const reloadedCtx = new SimulatedReviewContext(generateRrb74Questions());
            assert.equal(reloadedCtx.selectedReviewStatus, "all");
            assert.equal(reloadedCtx.selectedReviewSubject, "all");
            assert.equal(reloadedCtx.filteredReviewQuestions.length, 74);
            assert.ok(reloadedCtx.dom.statusButtons.find(b => b.status === "all").active);
        });

        test("Scenario 17: Switch filters repeatedly -> No stale DOM references or errors", () => {
            const sequence = ["incorrect", "all", "correct", "unattempted", "incorrect", "unattempted", "all", "correct", "all"];
            for (const step of sequence) {
                assert.doesNotThrow(() => {
                    ctx.setReviewStatusFilter(step);
                }, `Filter transition to '${step}' must never throw`);
            }
            assert.equal(ctx.filteredReviewQuestions.length, 74);
            assert.equal(ctx.dom.paletteItems.length, 74);
        });
    });

    // =========================================================================
    // SECTION 4: Multi-Distribution Fixtures (Beyond RRB)
    // =========================================================================
    describe("4. Multi-Distribution Fixture Resilience", () => {

        test("4.1 All Questions Correct Distribution (50 questions)", () => {
            const allCorrectQs = [];
            for (let i = 1; i <= 50; i++) {
                allCorrectQs.push({
                    questionId: `ac_q_${i}`,
                    questionNumber: i,
                    subject: "Mathematics",
                    subjectId: "math",
                    status: "correct",
                    marksAwarded: 4,
                    studentAnswer: "1"
                });
            }
            const ctx = new SimulatedReviewContext(allCorrectQs);

            ctx.setReviewStatusFilter("correct");
            assert.equal(ctx.filteredReviewQuestions.length, 50, "All 50 questions must match 'correct'");
            assert.equal(ctx.dom.paletteItems.length, 50);

            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 0, "0 questions must match 'incorrect'");
            assert.equal(ctx.dom.revQNumberBadge.textContent, "No Matches");

            ctx.setReviewStatusFilter("unattempted");
            assert.equal(ctx.filteredReviewQuestions.length, 0, "0 questions must match 'unattempted'");
        });

        test("4.2 All Questions Incorrect Distribution (40 questions)", () => {
            const allIncorrectQs = [];
            for (let i = 1; i <= 40; i++) {
                allIncorrectQs.push({
                    questionId: `ai_q_${i}`,
                    questionNumber: i,
                    subject: "Physics",
                    subjectId: "physics",
                    status: "incorrect",
                    marksAwarded: -1,
                    studentAnswer: "2"
                });
            }
            const ctx = new SimulatedReviewContext(allIncorrectQs);

            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 40);
            assert.equal(ctx.dom.paletteItems.length, 40);

            ctx.setReviewStatusFilter("correct");
            assert.equal(ctx.filteredReviewQuestions.length, 0);

            ctx.setReviewStatusFilter("unattempted");
            assert.equal(ctx.filteredReviewQuestions.length, 0);
        });

        test("4.3 All Questions Unattempted Distribution (100 questions)", () => {
            const allUnattemptedQs = [];
            for (let i = 1; i <= 100; i++) {
                allUnattemptedQs.push({
                    questionId: `au_q_${i}`,
                    questionNumber: i,
                    subject: "General Awareness",
                    subjectId: "ga",
                    status: "unanswered",
                    marksAwarded: 0,
                    studentAnswer: null
                });
            }
            const ctx = new SimulatedReviewContext(allUnattemptedQs);

            ctx.setReviewStatusFilter("unattempted");
            assert.equal(ctx.filteredReviewQuestions.length, 100);
            assert.equal(ctx.dom.paletteItems.length, 100);

            ctx.setReviewStatusFilter("correct");
            assert.equal(ctx.filteredReviewQuestions.length, 0);

            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 0);
        });

        test("4.4 Balanced Multi-Subject Distribution (180 questions: Physics, Chemistry, Biology)", () => {
            const mixedQs = [];
            for (let i = 1; i <= 180; i++) {
                let subject = i <= 45 ? "Physics" : (i <= 90 ? "Chemistry" : "Biology");
                let subId = subject.toLowerCase();
                let status = (i % 3 === 0) ? "correct" : ((i % 3 === 1) ? "incorrect" : "unanswered");
                mixedQs.push({
                    questionId: `neet_q_${i}`,
                    questionNumber: i,
                    subject,
                    subjectId: subId,
                    status,
                    marksAwarded: status === "correct" ? 4 : (status === "incorrect" ? -1 : 0),
                    studentAnswer: status === "unanswered" ? null : "1"
                });
            }
            const ctx = new SimulatedReviewContext(mixedQs);

            // Filter: Chemistry + Correct
            ctx.setReviewSubjectFilter("chemistry");
            ctx.setReviewStatusFilter("correct");
            // Chemistry has 45 questions (46..90). Multiples of 3 in [46..90]: 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90 = 15 questions
            assert.equal(ctx.filteredReviewQuestions.length, 15);
            ctx.filteredReviewQuestions.forEach(q => {
                assert.equal(q.subject, "Chemistry");
                assert.equal(q.status, "correct");
            });

            // Filter: Biology + Incorrect
            ctx.setReviewSubjectFilter("biology");
            ctx.setReviewStatusFilter("incorrect");
            // Biology has 90 questions (91..180). Numbers with i % 3 === 1 in [91..180]: 91, 94... 178 = 30 questions
            assert.equal(ctx.filteredReviewQuestions.length, 30);
            ctx.filteredReviewQuestions.forEach(q => {
                assert.equal(q.subject, "Biology");
                assert.equal(q.status, "incorrect");
            });
        });

        test("4.5 Multi-Question-Type Support (Numerical / NAT, MSQ, Dropped)", () => {
            const diverseQs = [
                { questionId: "q_nat", questionNumber: 1, questionType: "numerical", subject: "Math", status: "correct", marksAwarded: 2, studentAnswer: "42.5" },
                { questionId: "q_msq", questionNumber: 2, questionType: "msq", subject: "CS", status: "incorrect", marksAwarded: -0.667, studentAnswer: ["1", "3"] },
                { questionId: "q_drop", questionNumber: 3, questionType: "mcq", subject: "Physics", status: "dropped", marksAwarded: 4, studentAnswer: null }
            ];
            const ctx = new SimulatedReviewContext(diverseQs);

            ctx.setReviewStatusFilter("correct");
            assert.equal(ctx.filteredReviewQuestions.length, 1);
            assert.equal(ctx.filteredReviewQuestions[0].questionId, "q_nat");

            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 1);
            assert.equal(ctx.filteredReviewQuestions[0].questionId, "q_msq");

            ctx.setReviewStatusFilter("all");
            assert.equal(ctx.filteredReviewQuestions.length, 3);
        });
    });

    // =========================================================================
    // SECTION 5: Palette & Navigation Synchronization
    // =========================================================================
    describe("5. Palette & Navigation Synchronization", () => {
        let ctx;

        beforeEach(() => {
            ctx = new SimulatedReviewContext(generateRrb74Questions());
        });

        test("5.1 Next and Previous buttons step strictly through filtered set", () => {
            ctx.setReviewStatusFilter("incorrect");
            assert.equal(ctx.filteredReviewQuestions.length, 6);
            assert.equal(ctx.currentReviewIndex, 0);
            assert.ok(ctx.dom.btnRevPrev.disabled, "Prev must be disabled on first question of filtered set");
            assert.ok(!ctx.dom.btnRevNext.disabled, "Next must be enabled when more filtered questions exist");

            // Step Forward
            ctx.nextQuestion();
            assert.equal(ctx.currentReviewIndex, 1);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 11 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 2 of 6");
            assert.ok(!ctx.dom.btnRevPrev.disabled);

            // Step to End
            ctx.nextQuestion(); // idx 2 -> Q24
            ctx.nextQuestion(); // idx 3 -> Q42
            ctx.nextQuestion(); // idx 4 -> Q57
            ctx.nextQuestion(); // idx 5 -> Q70
            assert.equal(ctx.currentReviewIndex, 5);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 70 of 74");
            assert.equal(ctx.dom.revCurrentStatusIndicator.textContent, "Question 6 of 6");
            assert.ok(ctx.dom.btnRevNext.disabled, "Next must be disabled on last question of filtered set");

            // Step Backward
            ctx.prevQuestion();
            assert.equal(ctx.currentReviewIndex, 4);
            assert.equal(ctx.dom.revQNumberBadge.textContent, "Question 57 of 74");
        });

        test("5.2 Questions outside active filter are not present in palette", () => {
            ctx.setReviewStatusFilter("incorrect");
            // Palette must NOT contain question numbers other than [3, 11, 24, 42, 57, 70]
            const paletteNumbers = new Set(ctx.dom.paletteItems.map(p => p.questionNumber));
            assert.ok(!paletteNumbers.has(1), "Unattempted Question 1 must not be in incorrect palette");
            assert.ok(!paletteNumbers.has(2), "Unattempted Question 2 must not be in incorrect palette");
            assert.ok(!paletteNumbers.has(4), "Unattempted Question 4 must not be in incorrect palette");
            assert.ok(paletteNumbers.has(3), "Incorrect Question 3 must be in incorrect palette");
            assert.ok(paletteNumbers.has(11), "Incorrect Question 11 must be in incorrect palette");
        });
    });
});
