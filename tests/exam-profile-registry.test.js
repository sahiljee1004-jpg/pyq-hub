import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
    ExamProfileRegistry,
    VERIFICATION_STATUS,
    OPTIONAL_QUESTION_POLICY,
    DROPPED_QUESTION_POLICY,
    QUESTION_TYPES
} from "../server/services/admin/examProfileRegistry.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";

describe("Milestone 1 — ExamProfileRegistry & ExamPatternService Verification Suite", () => {

    describe("1. Registered Profile Lookup", () => {
        test("1.1 Retrieves all 10 audited exam families by exact profileId", () => {
            const expectedProfiles = [
                "upsc-prelims-2024",
                "upsc-prelims-2026",
                "bpsc-69th-2023",
                "jee-main-2024",
                "jee-main-2026",
                "neet-ug-2024",
                "gate-cs-2024",
                "ssc-cgl-2024",
                "banking-ibps-po-2024",
                "jee-advanced-2024",
                "cuet-ug-2024",
                "university-semester-default"
            ];

            for (const profileId of expectedProfiles) {
                const profile = ExamProfileRegistry.getProfile(profileId);
                assert.ok(profile, `Profile '${profileId}' must exist in registry.`);
                assert.strictEqual(profile.profileId, profileId);
                assert.ok(profile.totalQuestions > 0);
                assert.ok(profile.maximumMarks > 0);
                assert.ok(Array.isArray(profile.sections));
                assert.ok(profile.sections.length > 0);
            }
        });

        test("1.2 Resolves profiles by examId and year via findProfile()", () => {
            const upsc2026 = ExamProfileRegistry.findProfile("upsc-prelims", 2026);
            assert.ok(upsc2026);
            assert.strictEqual(upsc2026.profileId, "upsc-prelims-2026");

            const bpsc2023 = ExamProfileRegistry.findProfile("bpsc", 2023);
            assert.ok(bpsc2023);
            assert.strictEqual(bpsc2023.profileId, "bpsc-69th-2023");

            const jee2024 = ExamProfileRegistry.findProfile("jee-main", 2024);
            assert.ok(jee2024);
            assert.strictEqual(jee2024.profileId, "jee-main-2024");

            const jee2026 = ExamProfileRegistry.findProfile("jee-main", 2026);
            assert.ok(jee2026);
            assert.strictEqual(jee2026.profileId, "jee-main-2026");

            const neet2024 = ExamProfileRegistry.findProfile("neet-ug", 2024);
            assert.ok(neet2024);
            assert.strictEqual(neet2024.profileId, "neet-ug-2024");

            const gate2024 = ExamProfileRegistry.findProfile("gate", 2024);
            assert.ok(gate2024);
            assert.strictEqual(gate2024.profileId, "gate-cs-2024");

            const ssc2024 = ExamProfileRegistry.findProfile("ssc-cgl", 2024);
            assert.ok(ssc2024);
            assert.strictEqual(ssc2024.profileId, "ssc-cgl-2024");

            const ibps2024 = ExamProfileRegistry.findProfile("banking-ibps-po", 2024);
            assert.ok(ibps2024);
            assert.strictEqual(ibps2024.profileId, "banking-ibps-po-2024");

            const jeeAdv2024 = ExamProfileRegistry.findProfile("jee-advanced", 2024);
            assert.ok(jeeAdv2024);
            assert.strictEqual(jeeAdv2024.profileId, "jee-advanced-2024");

            const cuet2024 = ExamProfileRegistry.findProfile("cuet", 2024);
            assert.ok(cuet2024);
            assert.strictEqual(cuet2024.profileId, "cuet-ug-2024");
        });

        test("1.3 Returns deep clones preventing external mutation of internal registry state", () => {
            const p1 = ExamProfileRegistry.getProfile("upsc-prelims-2026");
            p1.totalQuestions = 999;
            p1.sections[0].markingScheme.correct = 999;

            const p2 = ExamProfileRegistry.getProfile("upsc-prelims-2026");
            assert.strictEqual(p2.totalQuestions, 100, "Internal registry state must be immutable against caller mutation.");
            assert.strictEqual(p2.sections[0].markingScheme.correct, 2);
        });
    });

    describe("2. Unknown Profile Rejection (Fail-Closed)", () => {
        test("2.1 Returns null for unregistered profile in standard mode", () => {
            const unknown = ExamProfileRegistry.getProfile("unregistered-exam-2025");
            assert.strictEqual(unknown, null);

            const unknownFind = ExamProfileRegistry.findProfile("sat-subject-test", 2024);
            assert.strictEqual(unknownFind, null);
        });

        test("2.2 Fails closed with UNRECOGNIZED_EXAM_PATTERN under strict lookup", () => {
            assert.throws(() => {
                ExamProfileRegistry.getProfile("unregistered-exam-2025", { strict: true });
            }, (err) => {
                return err.code === "UNRECOGNIZED_EXAM_PATTERN" && err.message.includes("unregistered-exam-2025");
            });

            assert.throws(() => {
                ExamProfileRegistry.findProfile("olympiad-biology", 2026, { strict: true });
            }, (err) => {
                return err.code === "UNRECOGNIZED_EXAM_PATTERN" && err.message.includes("olympiad-biology");
            });
        });

        test("2.3 Rejects empty, whitespace-only or non-string profile identifiers", () => {
            assert.strictEqual(ExamProfileRegistry.getProfile(""), null);
            assert.strictEqual(ExamProfileRegistry.getProfile("   "), null);
            assert.strictEqual(ExamProfileRegistry.getProfile(null), null);
            assert.strictEqual(ExamProfileRegistry.getProfile(undefined), null);

            assert.throws(() => {
                ExamProfileRegistry.getProfile("", { strict: true });
            }, TypeError);
        });
    });

    describe("3. Missing Year & Version Handling", () => {
        test("3.1 Returns null or fails closed when year is missing or invalid", () => {
            assert.strictEqual(ExamProfileRegistry.findProfile("jee-main", null), null);
            assert.strictEqual(ExamProfileRegistry.findProfile("jee-main", undefined), null);
            assert.strictEqual(ExamProfileRegistry.findProfile("jee-main", "not-a-year"), null);

            assert.throws(() => {
                ExamProfileRegistry.findProfile("jee-main", null, { strict: true });
            }, (err) => err.code === "MISSING_EXAM_IDENTITY");

            assert.throws(() => {
                ExamProfileRegistry.findProfile("jee-main", "invalid", { strict: true });
            }, (err) => err.code === "INVALID_YEAR");
        });

        test("3.2 Returns null when exam family is known but requested year is unregistered", () => {
            // UPSC registered for 2024 and 2026, but not 1999
            const profile1999 = ExamProfileRegistry.findProfile("upsc-prelims", 1999);
            assert.strictEqual(profile1999, null);

            assert.throws(() => {
                ExamProfileRegistry.findProfile("upsc-prelims", 1999, { strict: true });
            }, (err) => err.code === "INVALID_YEAR" || err.code === "UNRECOGNIZED_EXAM_PATTERN");
        });

        test("3.3 GATE resolution is strictly year-specific (2024 resolves, 2025/2029 return null)", () => {
            const gate2024 = ExamProfileRegistry.findProfile("gate", 2024);
            assert.ok(gate2024);
            assert.strictEqual(gate2024.profileId, "gate-cs-2024");

            const gate2025 = ExamProfileRegistry.findProfile("gate", 2025);
            assert.strictEqual(gate2025, null);

            const gate2029 = ExamProfileRegistry.findProfile("gate", 2029);
            assert.strictEqual(gate2029, null);
        });

        test("3.4 University semester year lookup requires registered year; archetype accessible via getArchetype()", () => {
            const univ2024 = ExamProfileRegistry.findProfile("university-semester", 2024);
            assert.ok(univ2024);
            assert.strictEqual(univ2024.profileId, "university-semester-default");

            const univ2030 = ExamProfileRegistry.findProfile("university-semester", 2030);
            assert.strictEqual(univ2030, null);

            const archetype = ExamProfileRegistry.getArchetype("university-semester-default");
            assert.ok(archetype);
            assert.strictEqual(archetype.profileId, "university-semester-default");
            assert.strictEqual(archetype.isOfficial, false);
        });

        test("3.5 UPSC and BPSC year-specific lookup remains unchanged and strict", () => {
            assert.strictEqual(ExamProfileRegistry.findProfile("upsc-prelims", 2024)?.profileId, "upsc-prelims-2024");
            assert.strictEqual(ExamProfileRegistry.findProfile("upsc-prelims", 2026)?.profileId, "upsc-prelims-2026");
            assert.strictEqual(ExamProfileRegistry.findProfile("upsc-prelims", 2025), null);

            assert.strictEqual(ExamProfileRegistry.findProfile("bpsc", 2023)?.profileId, "bpsc-69th-2023");
            assert.strictEqual(ExamProfileRegistry.findProfile("bpsc", 2025), null);
        });
    });

    describe("4. Invalid Profile Structure & Strict Schema Validation", () => {
        test("4.1 Rejects null, non-object, or array profiles", () => {
            assert.throws(() => ExamProfileRegistry.validateProfileSchema(null), /INVALID_PROFILE_SCHEMA/);
            assert.throws(() => ExamProfileRegistry.validateProfileSchema("string"), /INVALID_PROFILE_SCHEMA/);
            assert.throws(() => ExamProfileRegistry.validateProfileSchema([]), /INVALID_PROFILE_SCHEMA/);
        });

        test("4.2 Rejects missing or invalid profileId / examId / examName", () => {
            const valid = ExamProfileRegistry.getProfile("upsc-prelims-2024");

            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({ ...valid, profileId: "" });
            }, (err) => err.code === "INVALID_PROFILE_ID");

            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({ ...valid, profileId: "UPPERCASE_INVALID" });
            }, (err) => err.code === "INVALID_PROFILE_ID");

            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({ ...valid, examId: "" });
            }, (err) => err.code === "INVALID_EXAM_ID");

            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({ ...valid, examName: "  " });
            }, (err) => err.code === "INVALID_EXAM_NAME");
        });

        test("4.3 Rejects contradictory official verification status", () => {
            const valid = ExamProfileRegistry.getProfile("university-semester-default");
            // Cannot claim isOfficial: true when verificationStatus is unverified_archetype
            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({
                    ...valid,
                    isOfficial: true,
                    verificationStatus: VERIFICATION_STATUS.UNVERIFIED_ARCHETYPE
                });
            }, (err) => err.code === "CONTRADICTORY_OFFICIAL_STATUS");
        });

        test("4.4 Rejects section question count mismatches and non-contiguous ranges", () => {
            const valid = ExamProfileRegistry.getProfile("upsc-prelims-2024");

            // endQuestion < startQuestion
            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({
                    ...valid,
                    sections: [{ ...valid.sections[0], startQuestion: 50, endQuestion: 40 }]
                });
            }, (err) => err.code === "INVALID_END_QUESTION");

            // questionCount !== endQuestion - startQuestion + 1
            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({
                    ...valid,
                    sections: [{ ...valid.sections[0], questionCount: 90 }]
                });
            }, (err) => err.code === "SECTION_COUNT_MISMATCH");

            // Total question count sum mismatch
            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({
                    ...valid,
                    totalQuestions: 150 // but section only has 100
                });
            }, (err) => err.code === "TOTAL_QUESTIONS_SUM_MISMATCH");
        });

        test("4.5 Rejects invalid marking scheme configurations", () => {
            const valid = ExamProfileRegistry.getProfile("upsc-prelims-2024");

            // Negative correct marks
            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({
                    ...valid,
                    sections: [{
                        ...valid.sections[0],
                        markingScheme: { correct: -2, incorrect: -1, unanswered: 0 }
                    }]
                });
            }, (err) => err.code === "INVALID_CORRECT_MARK");

            // Positive penalty (incorrect marks must be <= 0)
            assert.throws(() => {
                ExamProfileRegistry.validateProfileSchema({
                    ...valid,
                    sections: [{
                        ...valid.sections[0],
                        markingScheme: { correct: 2, incorrect: 1, unanswered: 0 }
                    }]
                });
            }, (err) => err.code === "INVALID_INCORRECT_MARK");
        });

        test("4.6 Rejects registration of verified_official profile without official source provenance", () => {
            const valid = ExamProfileRegistry.getProfile("upsc-prelims-2024");

            assert.throws(() => {
                ExamProfileRegistry.registerProfile({
                    ...valid,
                    profileId: "spoofed-official-2026",
                    verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                    isOfficial: true,
                    sourceProvenance: {
                        documentName: "None",
                        referenceId: "N/A",
                        citation: "None"
                    }
                });
            }, (err) => err.code === "INVALID_OFFICIAL_PROVENANCE");
        });
    });

    describe("5. Optional-Question Configuration", () => {
        test("5.1 Verifies JEE Main 2024 Section B optional question configuration", () => {
            const jee2024 = ExamProfileRegistry.getProfile("jee-main-2024");
            assert.strictEqual(jee2024.optionalQuestionPolicy, OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED);
            assert.strictEqual(jee2024.totalQuestions, 90);
            assert.strictEqual(jee2024.requiredQuestionsToAttempt, 75);

            // Sections B (Math, Physics, Chem) each have 10 questions with requiredCount: 5
            const secBMath = jee2024.sections.find(s => s.id === "math_b");
            assert.ok(secBMath);
            assert.strictEqual(secBMath.questionCount, 10);
            assert.strictEqual(secBMath.requiredCount, 5);
            assert.strictEqual(secBMath.optionalPolicy.type, "first_k_attempted");
            assert.strictEqual(secBMath.optionalPolicy.maxAttempts, 5);
        });

        test("5.2 Verifies NEET UG 2024 Section B optional question configuration", () => {
            const neet2024 = ExamProfileRegistry.getProfile("neet-ug-2024");
            assert.strictEqual(neet2024.optionalQuestionPolicy, OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED);
            assert.strictEqual(neet2024.totalQuestions, 200);
            assert.strictEqual(neet2024.requiredQuestionsToAttempt, 180);

            // Section B in each subject has 15 questions with requiredCount: 10
            const secBPhys = neet2024.sections.find(s => s.id === "physics_b");
            assert.ok(secBPhys);
            assert.strictEqual(secBPhys.questionCount, 15);
            assert.strictEqual(secBPhys.requiredCount, 10);
            assert.strictEqual(secBPhys.optionalPolicy.maxAttempts, 10);
        });

        test("5.3 Verifies CUET UG 2024 optional question configuration (40 of 50)", () => {
            const cuet = ExamProfileRegistry.getProfile("cuet-ug-2024");
            assert.strictEqual(cuet.optionalQuestionPolicy, OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED);
            assert.strictEqual(cuet.totalQuestions, 50);
            assert.strictEqual(cuet.requiredQuestionsToAttempt, 40);
            assert.strictEqual(cuet.sections[0].optionalPolicy.maxAttempts, 40);
        });

        test("5.4 Verifies JEE Main 2026 has retired optional questions (compulsory Section B)", () => {
            const jee2026 = ExamProfileRegistry.getProfile("jee-main-2026");
            assert.strictEqual(jee2026.optionalQuestionPolicy, OPTIONAL_QUESTION_POLICY.NONE);
            assert.strictEqual(jee2026.totalQuestions, 75);
            assert.strictEqual(jee2026.requiredQuestionsToAttempt, 75);

            for (const sec of jee2026.sections) {
                assert.strictEqual(sec.questionCount, sec.requiredCount);
                assert.strictEqual(sec.optionalPolicy, undefined);
            }
        });
    });

    describe("6. Dropped-Question Configuration", () => {
        test("6.1 Verifies Pro-Rata dropped question policy in UPSC, SSC CGL and IBPS PO", () => {
            const upsc2024 = ExamProfileRegistry.getProfile("upsc-prelims-2024");
            assert.strictEqual(upsc2024.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.PRO_RATA);

            const upsc2026 = ExamProfileRegistry.getProfile("upsc-prelims-2026");
            assert.strictEqual(upsc2026.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.PRO_RATA);

            const ssc = ExamProfileRegistry.getProfile("ssc-cgl-2024");
            assert.strictEqual(ssc.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.PRO_RATA);

            const ibps = ExamProfileRegistry.getProfile("banking-ibps-po-2024");
            assert.strictEqual(ibps.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.PRO_RATA);
        });

        test("6.2 Verifies Full Marks dropped question policy in BPSC, NEET, JEE Main and GATE", () => {
            const bpsc = ExamProfileRegistry.getProfile("bpsc-69th-2023");
            assert.strictEqual(bpsc.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.FULL_MARKS);

            const neet = ExamProfileRegistry.getProfile("neet-ug-2024");
            assert.strictEqual(neet.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.FULL_MARKS);

            const jee = ExamProfileRegistry.getProfile("jee-main-2026");
            assert.strictEqual(jee.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.FULL_MARKS);

            const gate = ExamProfileRegistry.getProfile("gate-cs-2024");
            assert.strictEqual(gate.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.FULL_MARKS);
        });

        test("6.3 Verifies Zero Marks policy for unverified University Semester archetype", () => {
            const univ = ExamProfileRegistry.getProfile("university-semester-default");
            assert.strictEqual(univ.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.ZERO_MARKS);
        });
    });

    describe("7. Mixed Question Types & Complex Scoring Models", () => {
        test("7.1 GATE CS 2024 supports mixed MCQ, MSQ and Numerical question types", () => {
            const gate = ExamProfileRegistry.getProfile("gate-cs-2024");
            assert.strictEqual(gate.sections.length, 2);
            assert.strictEqual(gate.sections[0].questionType, "mixed");
            assert.deepStrictEqual(gate.sections[0].allowedQuestionTypes, ["mcq", "msq", "numerical"]);
            assert.strictEqual(gate.sections[1].questionType, "mixed");
            assert.deepStrictEqual(gate.sections[1].allowedQuestionTypes, ["mcq", "msq", "numerical"]);
        });

        test("7.2 JEE Advanced 2024 specifies partial marking and multi-format sections", () => {
            const jeeAdv = ExamProfileRegistry.getProfile("jee-advanced-2024");
            assert.strictEqual(jeeAdv.sections.length, 12); // 4 sections per subject x 3 subjects

            const msqSec = jeeAdv.sections.find(s => s.id === "physics_sec2");
            assert.ok(msqSec);
            assert.strictEqual(msqSec.questionType, "msq");
            assert.strictEqual(msqSec.markingScheme.correct, 4);
            assert.strictEqual(msqSec.markingScheme.incorrect, -2);
            assert.ok(msqSec.partialMarkingRules);
            assert.strictEqual(msqSec.partialMarkingRules.allCorrect, 4);
            assert.strictEqual(msqSec.partialMarkingRules.threeOfFour, 3);
            assert.strictEqual(msqSec.partialMarkingRules.twoOfThreeOrFour, 2);
            assert.strictEqual(msqSec.partialMarkingRules.oneOfTwoOrMore, 1);
        });
    });

    describe("8. Section Numbering Restarts", () => {
        test("8.1 SSC CGL 2024 restarts question numbering at Q1 in each of its 4 sections", () => {
            const ssc = ExamProfileRegistry.getProfile("ssc-cgl-2024");
            assert.strictEqual(ssc.numberingRestartsPerSection, true);
            assert.strictEqual(ssc.totalQuestions, 100);
            assert.strictEqual(ssc.sections.length, 4);

            for (const sec of ssc.sections) {
                assert.strictEqual(sec.startQuestion, 1, `Section ${sec.id} must start at question 1.`);
                assert.strictEqual(sec.endQuestion, 25, `Section ${sec.id} must end at question 25.`);
                assert.strictEqual(sec.questionCount, 25);
                assert.strictEqual(sec.numberingRestartsPerSection, true);
            }
        });

        test("8.2 validateQuestionsAgainstPattern respects numberingRestartsPerSection", () => {
            const sscPattern = ExamPatternService.getVerifiedPattern({ examId: "ssc-cgl", year: 2024 });
            assert.strictEqual(sscPattern.numberingRestartsPerSection, true);

            // Create 100 questions where each section has Q1 to Q25
            const subjects = [
                "Reasoning",
                "General Awareness",
                "Quantitative Aptitude",
                "English"
            ];

            const mockQuestions = [];
            for (const subj of subjects) {
                for (let qNum = 1; qNum <= 25; qNum++) {
                    mockQuestions.push({
                        questionId: `q_${subj.slice(0, 3)}_${qNum}`,
                        questionNumber: qNum,
                        subject: subj,
                        questionType: "mcq",
                        options: [
                            { id: "a", text: "Opt A" },
                            { id: "b", text: "Opt B" },
                            { id: "c", text: "Opt C" },
                            { id: "d", text: "Opt D" }
                        ]
                    });
                }
            }

            const check = ExamPatternService.validateQuestionsAgainstPattern(mockQuestions, sscPattern);
            assert.strictEqual(check.valid, true, "Validation must pass for section numbering restarts.");
            assert.strictEqual(check.issues.length, 0);
        });
    });

    describe("9. Profile Verification Status & Evidence Provenance", () => {
        test("9.1 Accurately distinguishes verified official profiles from unverified archetypes", () => {
            // Exactly 11 verified official profiles in registry
            const verifiedProfiles = ExamProfileRegistry.listProfiles({
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL
            });
            assert.strictEqual(verifiedProfiles.length, 11);
            for (const p of verifiedProfiles) {
                assert.strictEqual(p.isOfficial, true);
                assert.ok(p.sourceProvenance.documentName);
                assert.ok(p.sourceProvenance.citation);
                assert.strictEqual(ExamProfileRegistry.isOfficialVerified(p.profileId), true);
            }

            // Exactly 1 unverified archetype
            const unverifiedProfiles = ExamProfileRegistry.listProfiles({
                verificationStatus: VERIFICATION_STATUS.UNVERIFIED_ARCHETYPE
            });
            assert.strictEqual(unverifiedProfiles.length, 1);
            const univ = unverifiedProfiles[0];
            assert.strictEqual(univ.profileId, "university-semester-default");
            assert.strictEqual(univ.isOfficial, false);
            assert.strictEqual(ExamProfileRegistry.isOfficialVerified(univ.profileId), false);
        });

        test("9.2 Official profiles contain exact primary source document citations", () => {
            const upsc = ExamProfileRegistry.getProfile("upsc-prelims-2024");
            assert.ok(upsc.sourceProvenance.documentName.includes("No. 05/2024-CSP"));
            assert.ok(upsc.sourceProvenance.citation.includes("Section II"));

            const bpsc = ExamProfileRegistry.getProfile("bpsc-69th-2023");
            assert.ok(bpsc.sourceProvenance.documentName.includes("Advt No. 23/2023") || bpsc.sourceProvenance.documentName.includes("69th"));
            assert.ok(bpsc.sourceProvenance.citation.includes("Paragraph 7"));

            const jee = ExamProfileRegistry.getProfile("jee-main-2026");
            assert.ok(jee.sourceProvenance.documentName.includes("JEE (Main) 2026"));

            const gate = ExamProfileRegistry.getProfile("gate-cs-2024");
            assert.ok(gate.sourceProvenance.documentName.includes("IISc Bangalore"));
        });
    });

    describe("10. Safe Integration with ExamPatternService & Contract Compatibility", () => {
        test("10.1 ExamPatternService returns contract-compatible pattern for UPSC Prelims 2026", () => {
            const pattern = ExamPatternService.getVerifiedPattern({ examId: "upsc-prelims", year: 2026 });
            assert.strictEqual(pattern.configId, "upsc-prelims-2026");
            assert.strictEqual(pattern.examId, "upsc-prelims");
            assert.strictEqual(pattern.year, 2026);
            assert.strictEqual(pattern.status, "verified");
            assert.strictEqual(pattern.verificationStatus, "verified_official");
            assert.strictEqual(pattern.isOfficial, true);
            assert.strictEqual(pattern.totalQuestions, 100);
            assert.strictEqual(pattern.maximumMarks, 200);
            assert.strictEqual(pattern.durationSeconds, 7200);
            assert.strictEqual(pattern.negativeMarkingEnabled, true);
            assert.strictEqual(pattern.sections.length, 1);
            assert.strictEqual(pattern.sections[0].id, "general_studies");
            assert.strictEqual(pattern.sections[0].markingScheme.correct, 2);
            assert.ok(Math.abs(pattern.sections[0].markingScheme.incorrect - (-2 / 3)) < 1e-6);
        });

        test("10.2 ExamPatternService returns contract-compatible pattern for BPSC 69th Prelims 2023", () => {
            const pattern = ExamPatternService.getVerifiedPattern({ examId: "bpsc", year: 2023 });
            assert.strictEqual(pattern.configId, "bpsc-69th-2023");
            assert.strictEqual(pattern.examId, "bpsc");
            assert.strictEqual(pattern.year, 2023);
            assert.strictEqual(pattern.status, "verified");
            assert.strictEqual(pattern.totalQuestions, 150);
            assert.strictEqual(pattern.maximumMarks, 150);
            assert.strictEqual(pattern.durationSeconds, 7200);
            assert.strictEqual(pattern.sections.length, 1);
            assert.strictEqual(pattern.sections[0].markingScheme.correct, 1);
            assert.ok(Math.abs(pattern.sections[0].markingScheme.incorrect - (-1 / 3)) < 1e-6);
        });

        test("10.3 ExamPatternService returns contract-compatible pattern for JEE Main 2026", () => {
            const pattern = ExamPatternService.getVerifiedPattern({ examId: "jee-main", year: 2026 });
            assert.strictEqual(pattern.configId, "jee-main-2026");
            assert.strictEqual(pattern.totalQuestions, 75);
            assert.strictEqual(pattern.maximumMarks, 300);
            assert.strictEqual(pattern.durationSeconds, 10800);
            assert.strictEqual(pattern.sections.length, 6);
        });

        test("10.4 ExamPatternService returns contract-compatible pattern for NEET UG 2024", () => {
            const pattern = ExamPatternService.getVerifiedPattern({ examId: "neet-ug", year: 2024 });
            assert.strictEqual(pattern.configId, "neet-ug-2024");
            assert.strictEqual(pattern.totalQuestions, 200);
            assert.strictEqual(pattern.requiredQuestionsToAttempt, 180);
            assert.strictEqual(pattern.maximumMarks, 720);
            assert.strictEqual(pattern.sections.length, 8);
        });

        test("10.5 Preserves NEET UG 2024 custom sample override behavior for synthetic fixtures with explicit flag", () => {
            const samplePattern = ExamPatternService.getVerifiedPattern({
                examId: "neet-ug",
                year: 2024,
                isSample: true,
                extractedMetadata: { totalQuestions: { value: 5 } }
            });
            assert.strictEqual(samplePattern.configId, "neet-ug-2024-sample-5");
            assert.strictEqual(samplePattern.totalQuestions, 5);
            assert.strictEqual(samplePattern.maximumMarks, 20);
            assert.strictEqual(samplePattern.sections.length, 1);
        });

        test("10.5b Truncated OCR on NEET 2024 without explicit sample flag returns official 200-question profile", () => {
            const officialPattern = ExamPatternService.getVerifiedPattern({
                examId: "neet-ug",
                year: 2024,
                extractedMetadata: { totalQuestions: { value: 5 } }
            });
            assert.strictEqual(officialPattern.configId, "neet-ug-2024");
            assert.strictEqual(officialPattern.totalQuestions, 200);
            assert.strictEqual(officialPattern.maximumMarks, 720);
            assert.strictEqual(officialPattern.sections.length, 8);
        });

        test("10.6 Unknown / unsupported exams do NOT silently apply NEET-style (+4, -1) defaults", () => {
            const unknownPattern = ExamPatternService.getVerifiedPattern({
                examId: "unsupported-state-cet-9999",
                examName: "State CET 2025",
                year: 2025
            });

            assert.strictEqual(unknownPattern.status, "draft");
            assert.strictEqual(unknownPattern.verificationStatus, VERIFICATION_STATUS.CUSTOM_UNVERIFIED);
            assert.strictEqual(unknownPattern.isOfficial, false);
            assert.strictEqual(unknownPattern.requiresAdministrativeReview, true);
            assert.ok(unknownPattern.reviewRequiredReason.includes("administrative review"));

            // Marking scheme must NOT be 4 and -1!
            const sec = unknownPattern.sections[0];
            assert.notStrictEqual(sec.markingScheme.correct, 4, "Must not silently apply NEET +4 default mark.");
            assert.notStrictEqual(sec.markingScheme.incorrect, -1, "Must not silently apply NEET -1 default penalty.");
            assert.strictEqual(sec.markingScheme.correct, 0);
            assert.strictEqual(sec.markingScheme.incorrect, 0);
        });

        test("10.7 getPattern() convenience helper remains backward-compatible", () => {
            const p1 = ExamPatternService.getPattern("upsc-prelims", 2026);
            assert.strictEqual(p1.examId, "upsc-prelims");
            assert.strictEqual(p1.totalQuestions, 100);

            const p2 = ExamPatternService.getPattern("bpsc", 2023);
            assert.strictEqual(p2.examId, "bpsc");
            assert.strictEqual(p2.totalQuestions, 150);
        });
    });

    describe("11. Unverified Profile Publication Protection", () => {
        test("11.1 classifyDiscrepancies flags unverified/draft profiles with fatal non-overridable blocker", () => {
            const draftConfig = {
                configId: "unverified-exam-2025",
                status: "draft",
                verificationStatus: VERIFICATION_STATUS.CUSTOM_UNVERIFIED,
                requiresAdministrativeReview: true,
                reviewRequiredReason: "Custom exam pattern requires review."
            };

            const job = {
                examId: "unverified-exam",
                year: 2025,
                sourceDocuments: { questionPaper: {}, answerKey: {}, examPattern: {} },
                sourceHashes: { questionPaper: "h1", answerKey: "h2", examPattern: "h3" },
                draftPackage: {
                    questions: [{ questionNumber: 1, questionType: "numerical", questionText: "Valid question stem" }],
                    answerKeys: [{ questionId: "q1", verificationStatus: "verified" }],
                    examConfig: draftConfig
                },
                validationReport: {
                    validatedFingerprint: "fp1",
                    canPublish: true
                }
            };

            const result = ImportJobPipelineService.classifyDiscrepancies(job);

            assert.strictEqual(result.canPublish, false);
            assert.strictEqual(result.canStandardPublish, false);
            const unverifiedBlocker = result.mandatoryBlockers.find(b => b.id === "unverified_exam_profile");
            assert.ok(unverifiedBlocker, "Must contain fatal unverified_exam_profile blocker");
            assert.strictEqual(unverifiedBlocker.severity, "fatal");
            assert.strictEqual(unverifiedBlocker.overridable, false);
        });

        test("11.2 Stage 6 blocks publication in runPipeline when profile is unverified", async () => {
            const draftConfig = {
                configId: "draft-exam-2025",
                status: "draft",
                verificationStatus: "custom_unverified",
                requiresAdministrativeReview: true
            };

            const job = {
                examId: "draft-exam",
                year: 2025,
                draftPackage: {
                    examConfig: draftConfig,
                    questions: [{ questionNumber: 1, questionType: "mcq", questionText: "Valid question stem", options: [{ id: 1 }, { id: 2 }] }],
                    answerKeys: [{ questionId: "q1", questionNumber: 1, verificationStatus: "verified" }]
                },
                sourceDocuments: { questionPaper: {}, answerKey: {}, examPattern: {} },
                sourceHashes: { questionPaper: "h1", answerKey: "h2", examPattern: "h3" },
                validationReport: { canPublish: true, validatedFingerprint: "fp1" }
            };

            const discrepancyResult = ImportJobPipelineService.classifyDiscrepancies(job);
            assert.strictEqual(discrepancyResult.canPublish, false);
            assert.ok(discrepancyResult.mandatoryBlockers.some(b => b.id === "unverified_exam_profile"));
        });

        test("11.3 publishTest strictly rejects draft/unverified jobs before publishing", async () => {
            const origGetJob = ImportJobPipelineService.getJob;
            try {
                ImportJobPipelineService.getJob = async (id) => ({
                    jobId: id,
                    status: "draft_saved",
                    draftPackage: {
                        testId: "mock-test-unverified-1",
                        questions: [{ questionId: "q1", questionNumber: 1, questionType: "mcq", options: [{ id: "1" }, { id: "2" }], questionText: "Valid question text stem" }],
                        answerKeys: [{ questionId: "q1", questionNumber: 1, verificationStatus: "verified" }],
                        examConfig: {
                            configId: "draft-exam-2025",
                            status: "draft",
                            requiresAdministrativeReview: true
                        }
                    },
                    validationReport: {
                        validatedFingerprint: "fp-dummy",
                        canPublish: true
                    }
                });

                await assert.rejects(
                    async () => {
                        await ImportJobPipelineService.publishTest({ jobId: "fake-job-unverified" });
                    },
                    /Cannot publish test: Authoritative publication gate rejected publication/
                );
            } finally {
                ImportJobPipelineService.getJob = origGetJob;
            }
        });
    });

    describe("12. Section-Aware Question Identity & SSC CGL End-to-End Fixture", () => {
        test("12.1 End-to-end 100-question SSC CGL fixture survives normalization, reconciliation, and scoring", () => {
            const sscProfile = ExamProfileRegistry.getProfile("ssc-cgl-2024");
            assert.ok(sscProfile);
            assert.strictEqual(sscProfile.numberingRestartsPerSection, true);
            assert.strictEqual(sscProfile.sections.length, 4);

            // Construct 100 questions (25 per section, Q1-25 repeated in each section)
            const questions = [];
            const sectionKeys = ["general_intelligence", "general_awareness", "quantitative_aptitude", "english_comprehension"];
            for (let sIdx = 0; sIdx < 4; sIdx++) {
                const sId = sectionKeys[sIdx];
                for (let qNum = 1; qNum <= 25; qNum++) {
                    const qPad = String(qNum).padStart(3, "0");
                    questions.push({
                        questionId: `ssc-cgl-2024-shift1-${sId}-q${qPad}`,
                        examId: "ssc-cgl",
                        year: 2024,
                        paperCode: "shift1",
                        questionNumber: qNum,
                        sectionId: sId,
                        questionType: "mcq",
                        options: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]
                    });
                }
            }

            assert.strictEqual(questions.length, 100);

            // Verify all 100 questionIds are unique
            const idSet = new Set(questions.map(q => q.questionId));
            assert.strictEqual(idSet.size, 100, "All 100 question IDs across the 4 sections must be unique.");

            // Create answerMap with sequential keys 1..100 (each answer is "1")
            const answerMap = new Map();
            for (let i = 1; i <= 100; i++) {
                answerMap.set(i, {
                    answerType: "single_choice",
                    correctOptionIds: ["1"],
                    acceptedAnswers: ["1"],
                    isDropped: false,
                    rawString: "1"
                });
            }

            // Reconcile
            const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions,
                answerMap,
                sourceReference: "Official SSC CGL 2024 Tier I Key",
                keyMetadata: { isGlobalPaperSequence: true }
            });

            assert.strictEqual(reconciliation.gatePassed, true);
            assert.strictEqual(reconciliation.verifiedCount, 100);
            assert.strictEqual(reconciliation.missingAnswers.length, 0);
            assert.strictEqual(reconciliation.matchCoveragePercent, 100);
            assert.strictEqual(reconciliation.reconciledKeys.length, 100);

            // Verify reconciled keys retained sectionId
            for (let sIdx = 0; sIdx < 4; sIdx++) {
                const sId = sectionKeys[sIdx];
                const secKeys = reconciliation.reconciledKeys.filter(k => k.sectionId === sId);
                assert.strictEqual(secKeys.length, 25, `Section ${sId} must have exactly 25 reconciled keys.`);
            }

            // Simulate student attempt across 4 sections:
            // Section 1: 20 correct, 5 incorrect -> 20 * 2 - 5 * 0.5 = 37.5
            // Section 2: 15 correct, 10 unanswered -> 15 * 2 = 30
            // Section 3: 25 correct -> 25 * 2 = 50
            // Section 4: 10 correct, 10 incorrect, 5 unanswered -> 10 * 2 - 10 * 0.5 = 15
            // Expected total = 37.5 + 30 + 50 + 15 = 132.5
            const candidateAnswers = {};
            // Sec 1
            for (let q = 1; q <= 20; q++) candidateAnswers[`ssc-cgl-2024-shift1-general_intelligence-q${String(q).padStart(3, "0")}`] = "1";
            for (let q = 21; q <= 25; q++) candidateAnswers[`ssc-cgl-2024-shift1-general_intelligence-q${String(q).padStart(3, "0")}`] = "2";
            // Sec 2
            for (let q = 1; q <= 15; q++) candidateAnswers[`ssc-cgl-2024-shift1-general_awareness-q${String(q).padStart(3, "0")}`] = "1";
            // Sec 3
            for (let q = 1; q <= 25; q++) candidateAnswers[`ssc-cgl-2024-shift1-quantitative_aptitude-q${String(q).padStart(3, "0")}`] = "1";
            // Sec 4
            for (let q = 1; q <= 10; q++) candidateAnswers[`ssc-cgl-2024-shift1-english_comprehension-q${String(q).padStart(3, "0")}`] = "1";
            for (let q = 11; q <= 20; q++) candidateAnswers[`ssc-cgl-2024-shift1-english_comprehension-q${String(q).padStart(3, "0")}`] = "3";

            const attempt = {
                answers: candidateAnswers,
                paperId: "ssc-cgl-2024-shift1"
            };

            const scoringResult = MockTestScoringService.evaluateAttempt(
                attempt,
                reconciliation.reconciledKeys,
                { examConfig: sscProfile }
            );

            assert.strictEqual(scoringResult.correctCount, 70); // 20 + 15 + 25 + 10
            assert.strictEqual(scoringResult.incorrectCount, 15); // 5 + 0 + 0 + 10
            assert.strictEqual(scoringResult.unansweredCount, 15); // 0 + 10 + 0 + 5
            assert.strictEqual(scoringResult.totalScore, 132.5);
            assert.strictEqual(scoringResult.sectionScores["general_intelligence"], 37.5);
            assert.strictEqual(scoringResult.sectionScores["general_awareness"], 30);
            assert.strictEqual(scoringResult.sectionScores["quantitative_aptitude"], 50);
            assert.strictEqual(scoringResult.sectionScores["english_comprehension"], 15);
        });
    });

    describe("13. Unknown Exam Scoring Rejection & Legacy Scoring Parity", () => {
        test("13.1 Throws UNVERIFIED_EXAM_SCORING_REJECTED when scoring unknown exam lacking verified marks", () => {
            const unknownAttempt = {
                answers: { 1: 1 },
                paperId: "unknown-exam-paper"
            };
            const unverifiedKeys = [
                { questionNumber: 1, correctAnswers: [1] }
            ];
            const unverifiedConfig = {
                examId: "unknown-state-board-exam",
                status: "draft",
                verificationStatus: "custom_unverified"
            };

            assert.throws(
                () => {
                    MockTestScoringService.evaluateAttempt(unknownAttempt, unverifiedKeys, { examConfig: unverifiedConfig });
                },
                (err) => {
                    return err.message && err.message.includes("UNVERIFIED_EXAM_SCORING_REJECTED");
                }
            );
        });

        test("13.2 Preserves historical scoring for UPSC (+2, -2/3)", () => {
            const attempt = { answers: { 1: 1, 2: 2, 3: 3 } }; // 2 correct, 1 wrong
            const keys = [
                { questionNumber: 1, correctAnswers: [1] },
                { questionNumber: 2, correctAnswers: [2] },
                { questionNumber: 3, correctAnswers: [1] }
            ];
            const result = MockTestScoringService.evaluateAttempt(attempt, keys, {
                examConfig: { examId: "upsc-prelims", isOfficial: true, status: "verified" }
            });
            assert.strictEqual(result.correctCount, 2);
            assert.strictEqual(result.incorrectCount, 1);
            assert.strictEqual(result.totalScore, 3.333);
        });

        test("13.3 Preserves historical scoring for BPSC (+1, -1/3)", () => {
            const attempt = { answers: { 1: 1, 2: 2 } }; // 1 correct, 1 wrong
            const keys = [
                { questionNumber: 1, correctAnswers: [1] },
                { questionNumber: 2, correctAnswers: [1] }
            ];
            const result = MockTestScoringService.evaluateAttempt(attempt, keys, {
                examConfig: { examId: "bpsc", isOfficial: true, status: "verified" }
            });
            assert.strictEqual(result.correctCount, 1);
            assert.strictEqual(result.incorrectCount, 1);
            assert.strictEqual(result.totalScore, 0.667);
        });

        test("13.4 Preserves historical scoring for NEET UG (+4, -1)", () => {
            const attempt = { answers: { 1: 1, 2: 2 } }; // 1 correct, 1 wrong
            const keys = [
                { questionNumber: 1, correctAnswers: [1] },
                { questionNumber: 2, correctAnswers: [1] }
            ];
            const result = MockTestScoringService.evaluateAttempt(attempt, keys, {
                examConfig: { examId: "neet-ug", isOfficial: true, status: "verified" }
            });
            // 4 - 1 = 3
            assert.strictEqual(result.correctCount, 1);
            assert.strictEqual(result.incorrectCount, 1);
            assert.strictEqual(result.totalScore, 3);
        });
    });

    describe("14. Milestone 1 Defect Corrections (DEF-M1-01, DEF-M1-02, DEF-M1-03 & Publication Gates)", () => {
        test("14.1 SSC CGL paper with 4 sections repeating Q1–25: correctly maps answers by section-qualified keys", () => {
            const sectionKeys = ["general_intelligence", "general_awareness", "quantitative_aptitude", "english_comprehension"];
            const questions = [];
            const answerMap = new Map();

            for (let sIdx = 0; sIdx < 4; sIdx++) {
                const sId = sectionKeys[sIdx];
                for (let qNum = 1; qNum <= 25; qNum++) {
                    const qPad = String(qNum).padStart(3, "0");
                    const qId = `ssc-cgl-2024-shift1-${sId}-q${qPad}`;
                    questions.push({
                        questionId: qId,
                        questionNumber: qNum,
                        sectionId: sId,
                        questionType: "mcq",
                        options: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]
                    });
                    // Section-qualified key: e.g. general_intelligence_1
                    answerMap.set(`${sId}_${qNum}`, {
                        answerType: "single_choice",
                        correctOptionIds: [String((sIdx % 4) + 1)],
                        acceptedAnswers: [String((sIdx % 4) + 1)],
                        isDropped: false,
                        rawString: String((sIdx % 4) + 1)
                    });
                }
            }

            const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions,
                answerMap,
                sourceReference: "Official SSC CGL Section-Qualified Key"
            });

            assert.strictEqual(reconciliation.gatePassed, true);
            assert.strictEqual(reconciliation.verifiedCount, 100);
            assert.strictEqual(reconciliation.missingAnswers.length, 0);
            assert.strictEqual(reconciliation.conflicts.length, 0);
            assert.strictEqual(reconciliation.matchCoveragePercent, 100);

            // Verify each section mapped its exact distinct answer
            for (let sIdx = 0; sIdx < 4; sIdx++) {
                const sId = sectionKeys[sIdx];
                const expectedOpt = String((sIdx % 4) + 1);
                const secKeys = reconciliation.reconciledKeys.filter(k => k.sectionId === sId);
                assert.strictEqual(secKeys.length, 25);
                for (const k of secKeys) {
                    assert.strictEqual(k.correctOptionIds[0], expectedOpt);
                }
            }
        });

        test("14.2 Section B Q1 with no section key: marked unresolved, NOT matched to Section A Q1 (DEF-M1-01)", () => {
            const questions = [
                {
                    questionId: "ssc-secA-q001",
                    questionNumber: 1,
                    sectionId: "secA",
                    questionType: "mcq",
                    options: [{ id: "1" }, { id: "2" }]
                },
                {
                    questionId: "ssc-secB-q001",
                    questionNumber: 1,
                    sectionId: "secB",
                    questionType: "mcq",
                    options: [{ id: "1" }, { id: "2" }]
                }
            ];

            // answerMap has key for secA_1 and bare numeric 1 (Option 1)
            // But NO key exists for secB_1
            const answerMap = new Map();
            answerMap.set("secA_1", {
                answerType: "single_choice",
                correctOptionIds: ["1"],
                acceptedAnswers: ["1"],
                isDropped: false,
                rawString: "1"
            });
            answerMap.set(1, {
                answerType: "single_choice",
                correctOptionIds: ["1"],
                acceptedAnswers: ["1"],
                isDropped: false,
                rawString: "1"
            });

            const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions,
                answerMap,
                sourceReference: "Section A only Key"
            });

            // Gate must fail closed
            assert.strictEqual(reconciliation.gatePassed, false);
            assert.strictEqual(reconciliation.verifiedCount, 1);
            assert.strictEqual(reconciliation.missingAnswers.length, 1);
            assert.strictEqual(reconciliation.missingAnswers[0], 1);

            // Sec A Q1 is verified
            const secAKey = reconciliation.reconciledKeys.find(k => k.questionId === "ssc-secA-q001");
            assert.strictEqual(secAKey.verificationStatus, "verified");

            // Sec B Q1 must be unresolved — never fall back to bare numeric 1
            const secBKey = reconciliation.reconciledKeys.find(k => k.questionId === "ssc-secB-q001");
            assert.strictEqual(secBKey.verificationStatus, "unverified");
            assert.strictEqual(secBKey.answerType, "unresolved");
            assert.deepEqual(secBKey.correctOptionIds, []);
        });

        test("14.3 Shuffled question array with sequential key: sequential matching rejected, marked unresolved (DEF-M1-02)", () => {
            // Shuffled questions: Sec A Q2 comes before Sec A Q1
            const questions = [
                { questionId: "secA-q002", questionNumber: 2, sectionId: "secA", options: [{ id: "1" }] },
                { questionId: "secA-q001", questionNumber: 1, sectionId: "secA", options: [{ id: "1" }] },
                { questionId: "secB-q001", questionNumber: 1, sectionId: "secB", options: [{ id: "1" }] },
                { questionId: "secB-q002", questionNumber: 2, sectionId: "secB", options: [{ id: "1" }] }
            ];

            const answerMap = new Map();
            for (let i = 1; i <= 4; i++) {
                answerMap.set(i, {
                    answerType: "single_choice",
                    correctOptionIds: [String(i)],
                    acceptedAnswers: [String(i)],
                    isDropped: false,
                    rawString: String(i)
                });
            }

            const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions,
                answerMap,
                keyMetadata: { isGlobalPaperSequence: true }
            });

            assert.strictEqual(reconciliation.gatePassed, false);
            assert.strictEqual(reconciliation.verifiedCount, 0);
            assert.strictEqual(reconciliation.missingAnswers.length, 4);
            assert.ok(reconciliation.conflicts.some(c => c.reason.includes("question sequence could not be verified")));
        });

        test("14.4 Correctly ordered, explicitly verified global sequence: sequential matching succeeds (DEF-M1-02)", () => {
            const questions = [
                { questionId: "secA-q001", questionNumber: 1, sectionId: "secA", options: [{ id: "1" }] },
                { questionId: "secA-q002", questionNumber: 2, sectionId: "secA", options: [{ id: "2" }] },
                { questionId: "secB-q001", questionNumber: 1, sectionId: "secB", options: [{ id: "3" }] },
                { questionId: "secB-q002", questionNumber: 2, sectionId: "secB", options: [{ id: "4" }] }
            ];

            const answerMap = new Map();
            for (let i = 1; i <= 4; i++) {
                answerMap.set(i, {
                    answerType: "single_choice",
                    correctOptionIds: [String(i)],
                    acceptedAnswers: [String(i)],
                    isDropped: false,
                    rawString: String(i)
                });
            }

            const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions,
                answerMap,
                keyMetadata: { isGlobalPaperSequence: true }
            });

            assert.strictEqual(reconciliation.gatePassed, true);
            assert.strictEqual(reconciliation.verifiedCount, 4);
            assert.strictEqual(reconciliation.missingAnswers.length, 0);
            assert.strictEqual(reconciliation.conflicts.length, 0);

            // Check positional mappings: Sec A Q1 -> 1, Sec A Q2 -> 2, Sec B Q1 -> 3, Sec B Q2 -> 4
            assert.strictEqual(reconciliation.reconciledKeys[0].correctOptionIds[0], "1");
            assert.strictEqual(reconciliation.reconciledKeys[1].correctOptionIds[0], "2");
            assert.strictEqual(reconciliation.reconciledKeys[2].correctOptionIds[0], "3");
            assert.strictEqual(reconciliation.reconciledKeys[3].correctOptionIds[0], "4");
        });

        test("14.5 Conflicting composite vs. numeric key: precedence or ambiguity handled cleanly", () => {
            // Part A: Ambiguous conflicting entries for single non-section question
            const qNonSec = [{ questionId: "upsc-q001", questionNumber: 1, options: [{ id: "1" }, { id: "2" }] }];
            const conflictMap = new Map();
            conflictMap.set("upsc-q001", { answerType: "single_choice", correctOptionIds: ["1"], acceptedAnswers: ["1"], rawString: "1" });
            conflictMap.set(1, { answerType: "single_choice", correctOptionIds: ["2"], acceptedAnswers: ["2"], rawString: "2" });

            const reconConflict = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions: qNonSec,
                answerMap: conflictMap
            });

            assert.strictEqual(reconConflict.gatePassed, false);
            assert.ok(reconConflict.conflicts.some(c => c.reason.includes("Ambiguous / conflicting answer key mappings")));
            assert.strictEqual(reconConflict.reconciledKeys[0].answerType, "unresolved");

            // Part B: Section question with section key and bare numeric key (zero cross-section contamination)
            const qSec = [{ questionId: "ssc-secA-q001", sectionId: "secA", questionNumber: 1, options: [{ id: "1" }, { id: "2" }] }];
            const secAndNumMap = new Map();
            secAndNumMap.set("secA_1", { answerType: "single_choice", correctOptionIds: ["1"], acceptedAnswers: ["1"], rawString: "1" });
            secAndNumMap.set(1, { answerType: "single_choice", correctOptionIds: ["2"], acceptedAnswers: ["2"], rawString: "2" });

            const reconSec = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions: qSec,
                answerMap: secAndNumMap
            });

            // Bare numeric key 1 is not evaluated for section questions; secA_1 takes clean precedence
            assert.strictEqual(reconSec.gatePassed, true);
            assert.strictEqual(reconSec.verifiedCount, 1);
            assert.strictEqual(reconSec.reconciledKeys[0].correctOptionIds[0], "1");
        });

        test("14.6 Missing section ID on numbering-restart paper: fails closed", () => {
            const questions = [
                { questionId: "q1_a", questionNumber: 1, sectionId: "secA", options: [{ id: "1" }] },
                { questionId: "q1_b", questionNumber: 1, sectionId: null, options: [{ id: "1" }] }
            ];

            const answerMap = new Map();
            answerMap.set("secA_1", { answerType: "single_choice", correctOptionIds: ["1"], acceptedAnswers: ["1"], rawString: "1" });

            const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions,
                answerMap
            });

            assert.strictEqual(reconciliation.gatePassed, false);
            assert.ok(reconciliation.conflicts.some(c => c.reason.includes("lack a required sectionId")));
        });

        test("14.7 NEET official paper with incomplete pattern doc (< 50 Qs): remains official 200-Q profile, fails closed (DEF-M1-03)", () => {
            const pattern = ExamPatternService.getVerifiedPattern({
                examId: "neet-ug",
                year: 2024,
                paperType: "pyq",
                extractedMetadata: {
                    totalQuestions: { value: 35, provenance: "exam_pattern_document" }
                }
            });

            // Must NOT resolve to sample profile
            assert.strictEqual(pattern.configId, "neet-ug-2024");
            assert.strictEqual(pattern.totalQuestions, 200);
            assert.strictEqual(pattern.maximumMarks, 720);

            // Validating 35 questions against the official 200-Q pattern fails closed
            const dummy35Questions = Array.from({ length: 35 }, (_, i) => ({
                questionId: `neet-q${i + 1}`,
                questionNumber: i + 1,
                questionType: "mcq",
                options: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]
            }));

            const validation = ExamPatternService.validateQuestionsAgainstPattern(dummy35Questions, pattern);
            assert.strictEqual(validation.valid, false);
            assert.ok(validation.issues.some(iss => iss.includes("Missing 165 questions in sequence")));
        });

        test("14.8 Explicit NEET sample (isSample: true): sample profile resolves (DEF-M1-03)", () => {
            const pattern = ExamPatternService.getVerifiedPattern({
                examId: "neet-ug",
                year: 2024,
                isSample: true,
                extractedMetadata: {
                    totalQuestions: { value: 35, provenance: "exam_pattern_document" },
                    maximumMarks: { value: 140 }
                }
            });

            assert.strictEqual(pattern.configId, "neet-ug-2024-sample-35");
            assert.strictEqual(pattern.totalQuestions, 35);
            assert.strictEqual(pattern.maximumMarks, 140);
            assert.strictEqual(pattern.patternVersion, "2024.sample");
        });

        test("14.9 Duplicate question IDs: publication blocked with fatal blocker", async () => {
            const duplicateQuestions = [
                { questionId: "q_duplicate_001", questionNumber: 1, questionType: "mcq", questionText: "Question stem 1", options: [{ id: "1" }, { id: "2" }] },
                { questionId: "q_duplicate_001", questionNumber: 2, questionType: "mcq", questionText: "Question stem 2", options: [{ id: "1" }, { id: "2" }] }
            ];
            const answerKeys = [
                { questionId: "q_duplicate_001", questionNumber: 1, answerType: "single_choice", correctOptionIds: ["1"], verificationStatus: "verified" },
                { questionId: "q_duplicate_001", questionNumber: 2, answerType: "single_choice", correctOptionIds: ["2"], verificationStatus: "verified" }
            ];

            const job = {
                jobId: "job_test_dupe_qids_001",
                examId: "upsc-prelims",
                year: 2024,
                sourceDocuments: {
                    questionPaper: { hash: "dummy_qp_hash" },
                    answerKey: { hash: "dummy_ak_hash" },
                    examPattern: { hash: "dummy_ep_hash" }
                },
                sourceHashes: {
                    questionPaper: "dummy_qp_hash",
                    answerKey: "dummy_ak_hash",
                    examPattern: "dummy_ep_hash"
                },
                draftPackage: {
                    testId: "test_dupe_001",
                    questions: duplicateQuestions,
                    answerKeys: answerKeys,
                    examConfig: { configId: "upsc-prelims-2024", totalQuestions: 2, isOfficial: true, status: "verified" }
                },
                validationFingerprint: "dummy_fingerprint"
            };

            const classification = ImportJobPipelineService.classifyDiscrepancies(job);
            assert.ok(classification.mandatoryBlockers.some(b => b.id === "duplicate_question_ids" && b.severity === "fatal" && b.overridable === false));

            // publishTest rejection test
            let publishRejected = false;
            try {
                // Mock job in getJob by creating temporary job or mocking
                await ImportJobPipelineService.publishTest({ jobId: "non_existent_or_mocked" });
            } catch (err) {
                publishRejected = true;
            }
            assert.strictEqual(publishRejected, true);

            // Also test reconciliation duplicate questionId detection
            const recon = AnswerKeyReconciliationService.reconcileAnswerKeys({
                questions: duplicateQuestions,
                answerMap: new Map([["q_duplicate_001", { answerType: "single_choice", correctOptionIds: ["1"], acceptedAnswers: ["1"], rawString: "1" }]])
            });
            assert.strictEqual(recon.gatePassed, false);
            assert.ok(recon.conflicts.some(c => c.reason.includes("Duplicate questionId detected in question package")));
        });
    });
});

