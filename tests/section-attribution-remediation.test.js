import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { HistoricalAttemptMigrationService } from "../server/services/admin/historicalAttemptMigrationService.js";
import { ExamProfileRegistry } from "../server/services/admin/examProfileRegistry.js";

/**
 * Section Attribution Remediation & Score Tolerance Investigation Suite
 *
 * Verifies:
 *  1. Single-section profile with missing section IDs maps to that single section.
 *  2. Multi-section profile with resolvable question metadata maps accurately.
 *  3. Multi-section profile with unresolvable question metadata is quarantined (no "default" invented).
 *  4. Unknown section ID fails closed and quarantines record.
 *  5. Section ID inconsistent with registered profile is quarantined.
 *  6. Mixed valid and missing section IDs are resolved cleanly.
 *  7. Existing valid historical sectionScores are preserved verbatim.
 *  8. Historical student marks and breakdown marks remain 100% immutable.
 *  9. Mathematical verification of profile-specific rounding drifts and safety of 0.05 tolerance.
 */
describe("Section Attribution Remediation & Score Tolerance Investigation", () => {

    beforeEach(async () => {
        process.env.NODE_ENV = "test";
        UniversalFirestoreService.clearLocalCache();
    });

    // -------------------------------------------------------------------------
    // 1. Single-section profile with missing section IDs
    // -------------------------------------------------------------------------
    test("1. Single-section profile (UPSC) maps missing question section IDs to single official section", async () => {
        const profile = ExamProfileRegistry.getProfile("upsc-prelims-2024");
        assert.equal(profile.sections.length, 1);
        const officialSectionId = profile.sections[0].id; // "general_studies"

        const breakdown = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 2 },
            { questionId: "q2", questionNumber: 2, marksAwarded: -0.6667 },
            { questionId: "q3", questionNumber: 3, marksAwarded: 2 }
        ];

        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, true);
        assert.deepEqual(synth.sectionScores, {
            [officialSectionId]: 3.3333
        });
        assert.equal(synth.sectionScores["default"], undefined, "Must NEVER invent a 'default' section");
    });

    // -------------------------------------------------------------------------
    // 2. Multi-section profile with resolvable question metadata
    // -------------------------------------------------------------------------
    test("2. Multi-section profile (JEE Main) resolves missing section IDs using question metadata and ranges", async () => {
        const profile = ExamProfileRegistry.getProfile("jee-main-2024");
        assert.equal(profile.sections.length, 6);

        // Q5 is in math_a (1-20), Q35 is in physics_a (31-50)
        const breakdown = [
            { questionId: "q5", questionNumber: 5, marksAwarded: 4 },
            { questionId: "q35", questionNumber: 35, marksAwarded: -1 }
        ];

        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, true);
        assert.equal(synth.sectionScores["math_a"], 4);
        assert.equal(synth.sectionScores["physics_a"], -1);
        assert.equal(synth.sectionScores["default"], undefined);
    });

    // -------------------------------------------------------------------------
    // 3. Multi-section profile with unresolvable question metadata
    // -------------------------------------------------------------------------
    test("3. Multi-section profile with unresolvable question metadata fails closed and quarantines", async () => {
        const profile = ExamProfileRegistry.getProfile("jee-main-2024");

        // Question has no sectionId, no questionNumber, and is not in questionsMap
        const breakdown = [
            { questionId: "unresolvable_q_999", marksAwarded: 4 }
        ];

        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, false);
        assert.equal(synth.reason, HistoricalAttemptMigrationService.QUARANTINE_REASONS.UNRESOLVED_SECTION_ATTRIBUTION);
        assert.match(synth.details, /could not be resolved to any valid section/i);
    });

    // -------------------------------------------------------------------------
    // 4. Unknown section ID fails closed
    // -------------------------------------------------------------------------
    test("4. Unknown section ID fails closed and prevents unverified sections from entering sectionScores", async () => {
        const profile = ExamProfileRegistry.getProfile("jee-main-2024");

        const breakdown = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 4, sectionId: "fake_non_existent_section" }
        ];

        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, false);
        assert.equal(synth.reason, HistoricalAttemptMigrationService.QUARANTINE_REASONS.UNRESOLVED_SECTION_ATTRIBUTION);
    });

    // -------------------------------------------------------------------------
    // 5. Section ID inconsistent with the registered profile
    // -------------------------------------------------------------------------
    test("5. Section ID inconsistent with target profile (e.g. JEE section on SSC profile) is quarantined", async () => {
        const profile = ExamProfileRegistry.getProfile("ssc-cgl-2024");

        // Attributing a JEE section to an SSC exam result
        const breakdown = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 2, sectionId: "math_a" }
        ];

        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, false);
        assert.equal(synth.reason, HistoricalAttemptMigrationService.QUARANTINE_REASONS.UNRESOLVED_SECTION_ATTRIBUTION);
    });

    // -------------------------------------------------------------------------
    // 6. Mixed valid and missing section IDs
    // -------------------------------------------------------------------------
    test("6. Mixed valid explicit section IDs and resolvable missing section IDs aggregate cleanly", async () => {
        const profile = ExamProfileRegistry.getProfile("jee-main-2024");

        const breakdown = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 4, sectionId: "math_a" },      // Explicit valid
            { questionId: "q2", questionNumber: 25, marksAwarded: 4 }                           // Resolvable by range: math_b (21-30)
        ];

        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, true);
        assert.equal(synth.sectionScores["math_a"], 4);
        assert.equal(synth.sectionScores["math_b"], 4);
    });

    // -------------------------------------------------------------------------
    // 7. Existing historical sectionScores are preserved verbatim
    // -------------------------------------------------------------------------
    test("7. Existing valid historical sectionScores are preserved verbatim without recomputation", async () => {
        const profile = ExamProfileRegistry.getProfile("gate-cs-2024");

        const legacyResult = {
            resultId: "res_gate_01",
            attemptId: "att_gate_01",
            testId: "test_gate",
            userId: "student_01",
            totalScore: 45,
            correctCount: 30,
            incorrectCount: 15,
            unansweredCount: 20,
            droppedCount: 0,
            sectionScores: {
                ga_section: 15,
                core_section: 30
            },
            breakdown: []
        };

        const transformed = HistoricalAttemptMigrationService.transformResult(legacyResult, profile);
        assert.deepEqual(transformed.sectionScores, {
            ga_section: 15,
            core_section: 30
        }, "Existing valid sectionScores must be preserved verbatim");
    });

    // -------------------------------------------------------------------------
    // 8. Historical marks remain exactly unchanged
    // -------------------------------------------------------------------------
    test("8. Score immutability assertion strictly verifies marks and counts", async () => {
        const origResult = {
            resultId: "res_01",
            totalScore: 98.6667,
            correctCount: 52,
            incorrectCount: 18,
            unansweredCount: 30,
            droppedCount: 0,
            breakdown: [{ questionId: "q1", marksAwarded: 2 }, { questionId: "q2", marksAwarded: -0.6667 }]
        };

        const migratedResult = {
            ...origResult,
            schemaVersion: 2,
            profileId: "upsc-prelims-2024"
        };

        // Assert no error thrown when identical
        assert.doesNotThrow(() => {
            HistoricalAttemptMigrationService.verifyScorePreservation(origResult, migratedResult);
        });

        // Assert throws if totalScore is modified even by 0.0001
        assert.throws(() => {
            HistoricalAttemptMigrationService.verifyScorePreservation(origResult, { ...migratedResult, totalScore: 98.6668 });
        }, /SCORE_MUTATION_DETECTED/);

        // Assert throws if breakdown item is modified
        assert.throws(() => {
            HistoricalAttemptMigrationService.verifyScorePreservation(origResult, {
                ...migratedResult,
                breakdown: [{ questionId: "q1", marksAwarded: 2.1 }, { questionId: "q2", marksAwarded: -0.6667 }]
            });
        }, /QUESTION_SCORE_MUTATION/);
    });

    // -------------------------------------------------------------------------
    // 9. Score Tolerance Investigation: Mathematical Verification of Rounding Drift
    // -------------------------------------------------------------------------
    test("9. Mathematical investigation of historical rounding drift across all supported profiles", () => {
        // Derive exact theoretical maximum rounding drift for all registered profiles:
        // Drift occurs in historical evaluateAttemptHistorical due to individual item toFixed(3) vs cumulative totalScore
        const profileDrifts = [
            { id: "jee-main-2024", penalty: 1.0, maxQ: 90, expectedMaxDrift: 0.000 },
            { id: "jee-main-2026", penalty: 1.0, maxQ: 75, expectedMaxDrift: 0.000 },
            { id: "neet-ug-2024", penalty: 1.0, maxQ: 200, expectedMaxDrift: 0.000 },
            { id: "ssc-cgl-2024", penalty: 0.5, maxQ: 100, expectedMaxDrift: 0.000 },
            { id: "banking-ibps-po-2024", penalty: 0.25, maxQ: 100, expectedMaxDrift: 0.000 },
            { id: "cuet-ug-2024", penalty: 1.0, maxQ: 50, expectedMaxDrift: 0.000 },
            { id: "gate-cs-2024", penalty: 1/3, maxQ: 65, expectedMaxDrift: 0.022 },
            { id: "upsc-prelims-2024", penalty: 2/3, maxQ: 100, expectedMaxDrift: 0.033 },
            { id: "upsc-prelims-2026", penalty: 2/3, maxQ: 100, expectedMaxDrift: 0.033 },
            { id: "bpsc-69th-2023", penalty: 1/3, maxQ: 150, expectedMaxDrift: 0.050 }
        ];

        for (const p of profileDrifts) {
            const singleItemRounded = Number((-p.penalty).toFixed(3));
            const singleItemDrift = Math.abs(singleItemRounded - (-p.penalty));
            const calculatedMaxDrift = Number((p.maxQ * singleItemDrift).toFixed(3));

            assert.equal(
                calculatedMaxDrift,
                p.expectedMaxDrift,
                `Profile ${p.id} theoretical max drift must be ${p.expectedMaxDrift}`
            );

            // Verify that for all profiles, the theoretical max drift is <= 0.05
            assert.ok(
                calculatedMaxDrift <= 0.050,
                `Profile ${p.id} max drift (${calculatedMaxDrift}) must not exceed 0.050 tolerance`
            );
        }

        // Verify that minimum corruption / tampering delta (0.25) is at least 5x greater than 0.05 tolerance
        const minScoringIncrement = 0.25; // 1 incorrect question in IBPS PO
        assert.ok(
            minScoringIncrement >= 5 * 0.05,
            "Tolerance 0.05 must be safely at least 5x below the minimum possible corruption increment (0.25)"
        );
    });
});

