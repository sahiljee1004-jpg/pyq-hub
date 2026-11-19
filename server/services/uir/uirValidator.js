import {
    UIR_SCHEMA_VERSION,
    UIR_QUESTION_TYPES,
    UIR_ANSWER_TYPES,
    UIR_APPROVAL_STATUS
} from "./uirSchema.js";

/**
 * Universal Intermediate Representation (UIR v3.0) — Strict Schema Validator
 * 
 * Enforces zero-tolerance structural, relational, and mathematical integrity.
 * Never silently repairs invalid data using arbitrary defaults.
 */
export class UIRValidator {

    /**
     * Validate a UIR v3.0 Document
     * @param {object} uirDocument 
     * @param {object} options 
     * @returns {{ isValid: boolean, errors: string[], warnings: string[] }}
     */
    static validate(uirDocument, options = {}) {
        const errors = [];
        const warnings = [];

        if (!uirDocument || typeof uirDocument !== "object") {
            return {
                isValid: false,
                errors: ["[UIR Validation Error] Invalid document: Document must be a non-null object."],
                warnings
            };
        }

        // 1. Schema Version Check
        if (!uirDocument.schemaVersion || typeof uirDocument.schemaVersion !== "string") {
            errors.push("[UIR Validation Error] Missing or invalid 'schemaVersion'. Must be a semver string (e.g. '3.0.0').");
        } else if (!/^3\.\d+\.\d+$/.test(uirDocument.schemaVersion)) {
            errors.push(`[UIR Validation Error] Unsupported schemaVersion '${uirDocument.schemaVersion}'. Expected '3.x.x'.`);
        }

        // 2. Exam Metadata Validation
        const meta = uirDocument.examMetadata;
        if (!meta || typeof meta !== "object") {
            errors.push("[UIR Validation Error] Missing 'examMetadata' object.");
        } else {
            if (!meta.examId || typeof meta.examId !== "string" || !meta.examId.trim()) {
                errors.push("[UIR Validation Error] 'examMetadata.examId' must be a non-empty string.");
            }
            if (!meta.examTitle || typeof meta.examTitle !== "string" || !meta.examTitle.trim()) {
                errors.push("[UIR Validation Error] 'examMetadata.examTitle' must be a non-empty string.");
            }
            if (!Number.isInteger(meta.year) || meta.year < 1900 || meta.year > 2100) {
                errors.push(`[UIR Validation Error] 'examMetadata.year' must be an integer between 1900 and 2100 (got: ${meta.year}).`);
            }
            if (typeof meta.durationSeconds !== "number" || !Number.isFinite(meta.durationSeconds) || meta.durationSeconds <= 0) {
                errors.push(`[UIR Validation Error] 'examMetadata.durationSeconds' must be a positive finite number (got: ${meta.durationSeconds}).`);
            }
            if (typeof meta.maximumMarks !== "number" || !Number.isFinite(meta.maximumMarks) || meta.maximumMarks <= 0) {
                errors.push(`[UIR Validation Error] 'examMetadata.maximumMarks' must be a positive finite number (got: ${meta.maximumMarks}).`);
            }
            if (!Number.isInteger(meta.totalQuestions) || meta.totalQuestions <= 0) {
                errors.push(`[UIR Validation Error] 'examMetadata.totalQuestions' must be a positive integer (got: ${meta.totalQuestions}).`);
            }
            if (!Array.isArray(meta.languages) || meta.languages.length === 0) {
                errors.push("[UIR Validation Error] 'examMetadata.languages' must be a non-empty array of language names.");
            }
            if (!Object.values(UIR_APPROVAL_STATUS).includes(meta.approvalStatus)) {
                errors.push(`[UIR Validation Error] Invalid 'examMetadata.approvalStatus': '${meta.approvalStatus}'.`);
            }
        }

        // 3. Section Integrity Validation
        const sections = uirDocument.sections;
        const validSectionIds = new Set();
        if (!Array.isArray(sections) || sections.length === 0) {
            errors.push("[UIR Validation Error] 'sections' must be a non-empty array.");
        } else {
            const seenSectionIds = new Set();
            for (let i = 0; i < sections.length; i++) {
                const sec = sections[i];
                if (!sec || typeof sec !== "object") {
                    errors.push(`[UIR Validation Error] Section at index ${i} is not a valid object.`);
                    continue;
                }
                if (!sec.sectionId || typeof sec.sectionId !== "string" || !sec.sectionId.trim()) {
                    errors.push(`[UIR Validation Error] Section at index ${i} has empty or missing 'sectionId'.`);
                    continue;
                }
                if (seenSectionIds.has(sec.sectionId)) {
                    errors.push(`[UIR Validation Error] Duplicate sectionId '${sec.sectionId}' detected at section index ${i}.`);
                }
                seenSectionIds.add(sec.sectionId);
                validSectionIds.add(sec.sectionId);

                if (!sec.sectionName || typeof sec.sectionName !== "string" || !sec.sectionName.trim()) {
                    errors.push(`[UIR Validation Error] Section '${sec.sectionId}' has empty or missing 'sectionName'.`);
                }

                // Check scoring rules in section
                if (sec.scoringRules) {
                    if (typeof sec.scoringRules.positiveMarks !== "number" || !Number.isFinite(sec.scoringRules.positiveMarks)) {
                        errors.push(`[UIR Validation Error] Section '${sec.sectionId}' has non-finite positiveMarks.`);
                    }
                    if (typeof sec.scoringRules.negativeMarks !== "number" || !Number.isFinite(sec.scoringRules.negativeMarks)) {
                        errors.push(`[UIR Validation Error] Section '${sec.sectionId}' has non-finite negativeMarks.`);
                    }
                }
            }
        }

        // 4. Question Integrity Validation
        const questions = uirDocument.questions;
        if (!Array.isArray(questions) || questions.length === 0) {
            errors.push("[UIR Validation Error] 'questions' must be a non-empty array.");
        } else {
            if (meta && Number.isInteger(meta.totalQuestions) && questions.length !== meta.totalQuestions) {
                errors.push(`[UIR Validation Error] Question count mismatch: 'examMetadata.totalQuestions' declares ${meta.totalQuestions}, but 'questions' array contains ${questions.length} questions.`);
            }

            const seenQuestionIds = new Set();
            const seenQuestionNumbers = new Set();

            for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                if (!q || typeof q !== "object") {
                    errors.push(`[UIR Validation Error] Question at index ${i} is not a valid object.`);
                    continue;
                }

                // Question ID checks
                if (!q.questionId || typeof q.questionId !== "string" || !q.questionId.trim()) {
                    errors.push(`[UIR Validation Error] Question at index ${i} is missing a valid 'questionId'.`);
                } else if (seenQuestionIds.has(q.questionId)) {
                    errors.push(`[UIR Validation Error] Duplicate questionId '${q.questionId}' detected at question index ${i}.`);
                } else {
                    seenQuestionIds.add(q.questionId);
                }

                // Question Number checks
                if (!Number.isInteger(q.questionNumber) || q.questionNumber <= 0) {
                    errors.push(`[UIR Validation Error] Question '${q.questionId || i}' has invalid 'questionNumber': ${q.questionNumber}. Must be a positive integer.`);
                } else if (seenQuestionNumbers.has(q.questionNumber)) {
                    errors.push(`[UIR Validation Error] Duplicate questionNumber '${q.questionNumber}' detected at question '${q.questionId}'.`);
                } else {
                    seenQuestionNumbers.add(q.questionNumber);
                }

                // Section reference check
                if (q.sectionId && !validSectionIds.has(q.sectionId)) {
                    errors.push(`[UIR Validation Error] Question '${q.questionId}' references nonexistent sectionId '${q.sectionId}'.`);
                }

                // Stem text check
                if (!q.stem || typeof q.stem !== "object" || typeof q.stem.text !== "string" || !q.stem.text.trim()) {
                    errors.push(`[UIR Validation Error] Question '${q.questionId}' is missing mandatory stem text.`);
                }

                // Question Type check
                const validTypes = Object.values(UIR_QUESTION_TYPES);
                if (!q.questionType || typeof q.questionType !== "string" || !validTypes.includes(q.questionType.toLowerCase())) {
                    errors.push(`[UIR Validation Error] Question '${q.questionId}' has unsupported questionType: '${q.questionType}'. Supported types are: ${validTypes.join(", ")}.`);
                }

                // Source Reference check
                if (!q.sourceReference || typeof q.sourceReference !== "object") {
                    errors.push(`[UIR Validation Error] Question '${q.questionId}' is missing mandatory 'sourceReference'.`);
                } else {
                    if (!q.sourceReference.documentId || typeof q.sourceReference.documentId !== "string") {
                        errors.push(`[UIR Validation Error] Question '${q.questionId}' has invalid sourceReference.documentId.`);
                    }
                    if (!Number.isInteger(q.sourceReference.pageNumber) || q.sourceReference.pageNumber <= 0) {
                        errors.push(`[UIR Validation Error] Question '${q.questionId}' has invalid sourceReference.pageNumber.`);
                    }
                }

                // Scoring values finite check
                if (!q.scoring || typeof q.scoring !== "object") {
                    errors.push(`[UIR Validation Error] Question '${q.questionId}' is missing 'scoring' rules object.`);
                } else {
                    if (typeof q.scoring.positiveMarks !== "number" || !Number.isFinite(q.scoring.positiveMarks) || q.scoring.positiveMarks <= 0) {
                        errors.push(`[UIR Validation Error] Question '${q.questionId}' has invalid or non-positive scoring.positiveMarks (${q.scoring.positiveMarks}).`);
                    }
                    if (typeof q.scoring.negativeMarks !== "number" || !Number.isFinite(q.scoring.negativeMarks)) {
                        errors.push(`[UIR Validation Error] Question '${q.questionId}' has non-finite scoring.negativeMarks (${q.scoring.negativeMarks}).`);
                    }
                    if (typeof q.scoring.unansweredMarks !== "number" || !Number.isFinite(q.scoring.unansweredMarks)) {
                        errors.push(`[UIR Validation Error] Question '${q.questionId}' has non-finite scoring.unansweredMarks (${q.scoring.unansweredMarks}).`);
                    }
                }

                // Options and Correct Answer Mapping Checks
                const qType = (q.questionType || "").toLowerCase();
                const isChoiceType = qType === UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ || qType === UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ;
                const isNatType = qType === UIR_QUESTION_TYPES.NUMERICAL_NAT;

                const optionsList = Array.isArray(q.options) ? q.options : [];
                const declaredOptionIds = new Set(optionsList.map(o => o.id));

                if (isChoiceType) {
                    if (qType === UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ && optionsList.length < 2) {
                        errors.push(`[UIR Validation Error] Single-choice MCQ question '${q.questionId}' has fewer than 2 options (${optionsList.length} provided).`);
                    }

                    // Duplicate option text check
                    const seenTexts = new Set();
                    for (const opt of optionsList) {
                        const trimmed = (opt.text || "").trim();
                        if (trimmed && seenTexts.has(trimmed)) {
                            warnings.push(`[UIR Quality Warning] Question '${q.questionId}' has duplicate option text: "${trimmed}".`);
                        }
                        if (trimmed) seenTexts.add(trimmed);
                    }
                }

                // Publication approval gate: Reject unverified content corruption
                if (meta?.approvalStatus === UIR_APPROVAL_STATUS.APPROVED) {
                    if (q.qualityFlags?.contentCorruptionDetected && !q.qualityFlags?.manualVerificationCompleted) {
                        errors.push(`[UIR Publication Blocker] Question '${q.questionId}' contains font corruption / duplicate option text and requires manual verification before approval.`);
                    }
                }

                // Correct Answer Mapping check
                if (!q.correctAnswer || typeof q.correctAnswer !== "object") {
                    errors.push(`[UIR Validation Error] Question '${q.questionId}' is missing 'correctAnswer' specification.`);
                } else {
                    const ans = q.correctAnswer;
                    const isDroppedOrBonus = ans.isDropped || ans.isBonus;

                    if (!isDroppedOrBonus) {
                        if (isChoiceType) {
                            if (!Array.isArray(ans.acceptedAnswers) || ans.acceptedAnswers.length === 0) {
                                errors.push(`[UIR Validation Error] Question '${q.questionId}' has empty 'acceptedAnswers'.`);
                            } else {
                                for (const optToken of ans.acceptedAnswers) {
                                    const cleanToken = String(optToken).trim().toUpperCase();
                                    if (!declaredOptionIds.has(cleanToken)) {
                                        errors.push(`[UIR Validation Error] Question '${q.questionId}' accepted answer '${cleanToken}' does not exist in declared options [${[...declaredOptionIds].join(", ")}].`);
                                    }
                                }
                            }
                        } else if (isNatType) {
                            const hasVal = Number.isFinite(ans.numericValue);
                            const hasRange = ans.numericRange && Number.isFinite(ans.numericRange.min) && Number.isFinite(ans.numericRange.max);
                            if (!hasVal && !hasRange) {
                                errors.push(`[UIR Validation Error] Numerical NAT question '${q.questionId}' must provide either a finite numericValue or numericRange.`);
                            }
                            if (hasRange && ans.numericRange.min > ans.numericRange.max) {
                                errors.push(`[UIR Validation Error] Question '${q.questionId}' has invalid numericRange (min: ${ans.numericRange.min} > max: ${ans.numericRange.max}).`);
                            }
                        }
                    }
                }

                // Diagram Completeness Check
                if (q.qualityFlags?.missingDiagram && meta?.approvalStatus === UIR_APPROVAL_STATUS.APPROVED) {
                    errors.push(`[UIR Publication Blocker] Question '${q.questionId}' references a diagram in its stem that has not been resolved or overridden.`);
                }
            }
        }

        // 5. Global Scoring Config Check
        const scoring = uirDocument.scoringConfig;
        if (!scoring || typeof scoring !== "object") {
            errors.push("[UIR Validation Error] Missing 'scoringConfig' object.");
        } else {
            if (typeof scoring.defaultPositiveMarks !== "number" || !Number.isFinite(scoring.defaultPositiveMarks) || scoring.defaultPositiveMarks <= 0) {
                errors.push("[UIR Validation Error] 'scoringConfig.defaultPositiveMarks' must be a positive finite number.");
            }
            if (typeof scoring.defaultNegativeMarks !== "number" || !Number.isFinite(scoring.defaultNegativeMarks)) {
                errors.push("[UIR Validation Error] 'scoringConfig.defaultNegativeMarks' must be a finite number.");
            }
        }

        const isValid = errors.length === 0;

        if (!isValid && options.throwOnError) {
            const err = new Error(`UIR Validation Failed with ${errors.length} error(s):\n${errors.join("\n")}`);
            err.code = "UIR_VALIDATION_FAILED";
            err.errors = errors;
            err.warnings = warnings;
            throw err;
        }

        return {
            isValid,
            errors,
            warnings
        };
    }

    /**
     * Validate and throw if invalid
     */
    static validateOrThrow(uirDocument, options = {}) {
        return this.validate(uirDocument, { ...options, throwOnError: true });
    }
}
