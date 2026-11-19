import { Rational } from "../scoring/rational.js";

/**
 * Universal Intermediate Representation (UIR v3.0) — Canonical Schema
 * 
 * Version: 3.0.0
 * Specification: VidyarthiAstra Universal Examination Architecture v3.0
 * 
 * Governing Principles:
 * 1. Document-Driven & Exam-Agnostic: Downstream systems (rendering, mock tests, scoring, analytics)
 *    never inspect original PDF files or branch on exam names.
 * 2. Immutable Extraction Provenance: Every single field retains its full source document coordinates,
 *    page references, extraction method, and confidence score.
 * 3. Exact Rational Scoring: All marks are stored with exact fractional representations (Rational),
 *    eliminating IEEE-754 floating point drift during score accumulation.
 * 4. Separation of Concerns: Clear boundary between raw extraction, canonical normalization,
 *    and human correction history.
 */

export const UIR_SCHEMA_VERSION = "3.0.0";

/**
 * Universal Question Types supported by UIR v3.0
 */
export const UIR_QUESTION_TYPES = Object.freeze({
    SINGLE_CHOICE_MCQ: "single_choice_mcq",
    MULTIPLE_CHOICE_MSQ: "multiple_choice_msq",
    NUMERICAL_NAT: "numerical_nat",
    FILL_IN_THE_BLANKS: "fill_in_the_blanks",
    MATCH_FOLLOWING: "match_following",
    ASSERTION_REASON: "assertion_reason",
    PASSAGE_COMPREHENSION: "passage_comprehension",
    MATRIX_MATCH: "matrix_match",
    DESCRIPTIVE_MANUAL: "descriptive_manual"
});

/**
 * Universal Answer Types supported by UIR v3.0
 */
export const UIR_ANSWER_TYPES = Object.freeze({
    SINGLE_CHOICE: "single_choice",
    MULTIPLE_CHOICE: "multiple_choice",
    NUMERICAL_VALUE: "numerical_value",
    NUMERICAL_RANGE: "numerical_range",
    DESCRIPTIVE: "descriptive"
});

/**
 * Optional Question Selection Policies
 */
export const UIR_OPTIONAL_POLICIES = Object.freeze({
    NONE: "none",
    CHOOSE_N_OF_M: "choose_n_of_m",
    FIRST_K_ATTEMPTED: "first_k_attempted",
    CANDIDATE_SELECTED: "candidate_selected"
});

/**
 * Dropped / Cancelled Question Policies
 */
export const UIR_DROPPED_POLICIES = Object.freeze({
    FULL_MARKS: "full_marks",
    PRO_RATA: "pro_rata",
    ATTEMPTED_ONLY: "attempted_only",
    ZERO_MARKS: "zero_marks"
});

/**
 * Examination Publication / Approval Status
 */
export const UIR_APPROVAL_STATUS = Object.freeze({
    APPROVED: "approved",
    UNAPPROVED: "unapproved",
    PROVISIONAL: "provisional"
});

/**
 * Factory for Field Provenance metadata
 */
export function createUIRProvenance({
    documentId = "question_paper",
    pageNumber = 1,
    evidenceText = "",
    extractionMethod = "layout_spatial",
    confidence = 1.0,
    status = "EXPLICIT",
    bbox = null,
    ocrEngine = null,
    ocrVersion = null,
    ocrPageNumber = null,
    originalOcrText = null,
    normalizedText = null,
    visionModel = null,
    visionConfidence = null,
    crossModelAgreement = null,
    reconciledBy = null
} = {}) {
    return {
        documentId: String(documentId || "question_paper"),
        pageNumber: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1,
        evidenceText: String(evidenceText || "").trim(),
        extractionMethod: String(extractionMethod || "layout_spatial"),
        confidence: Math.min(1.0, Math.max(0.0, Number.isFinite(confidence) ? confidence : 1.0)),
        status: String(status || "EXPLICIT"),
        bbox: Array.isArray(bbox) ? bbox : null,
        ocrEngine: ocrEngine ? String(ocrEngine) : null,
        ocrVersion: ocrVersion ? String(ocrVersion) : null,
        ocrPageNumber: Number.isInteger(ocrPageNumber) ? ocrPageNumber : null,
        originalOcrText: originalOcrText ? String(originalOcrText) : null,
        normalizedText: normalizedText ? String(normalizedText) : null,
        visionModel: visionModel ? String(visionModel) : null,
        visionConfidence: Number.isFinite(visionConfidence) ? visionConfidence : null,
        crossModelAgreement: crossModelAgreement !== null && crossModelAgreement !== undefined ? Boolean(crossModelAgreement) : null,
        reconciledBy: reconciledBy ? String(reconciledBy) : null
    };
}

/**
 * Factory for Human Correction Audit Record
 */
export function createUIRHumanCorrection({
    modifiedBy,
    modifiedAt = new Date().toISOString(),
    field,
    previousValue,
    newValue,
    reason
}) {
    if (!modifiedBy || typeof modifiedBy !== "string" || !modifiedBy.trim()) {
        throw new Error("[UIR] Human correction record requires a valid 'modifiedBy' identifier.");
    }
    if (!field || typeof field !== "string" || !field.trim()) {
        throw new Error("[UIR] Human correction record requires a target 'field' name.");
    }
    return {
        modifiedBy: modifiedBy.trim(),
        modifiedAt,
        field: field.trim(),
        previousValue: previousValue !== undefined ? previousValue : null,
        newValue: newValue !== undefined ? newValue : null,
        reason: String(reason || "Manual verification and correction").trim(),
        isManualCorrection: true
    };
}

/**
 * Factory for Rational-backed Scoring Rules
 */
export function createUIRScoringRule({
    positiveMarks = 1,
    negativeMarks = 0,
    unansweredMarks = 0,
    positiveMarksRational = null,
    negativeMarksRational = null,
    unansweredMarksRational = null,
    isOverride = false,
    partialMarking = null
} = {}) {
    const posRat = positiveMarksRational ? Rational.from(positiveMarksRational) : Rational.from(positiveMarks);
    const negRat = negativeMarksRational ? Rational.from(negativeMarksRational) : Rational.from(negativeMarks);
    const unansRat = unansweredMarksRational ? Rational.from(unansweredMarksRational) : Rational.from(unansweredMarks);

    return {
        positiveMarks: Number(posRat.num) / Number(posRat.den),
        negativeMarks: Number(negRat.num) / Number(negRat.den),
        unansweredMarks: Number(unansRat.num) / Number(unansRat.den),
        positiveMarksRational: { num: posRat.num.toString(), den: posRat.den.toString() },
        negativeMarksRational: { num: negRat.num.toString(), den: negRat.den.toString() },
        unansweredMarksRational: { num: unansRat.num.toString(), den: unansRat.den.toString() },
        isOverride: Boolean(isOverride),
        partialMarking: partialMarking || null
    };
}

/**
 * Factory for UIR Section Model
 */
export function createUIRSection({
    sectionId,
    sectionName,
    orderIndex = 0,
    instructions = null,
    questionCount = 0,
    questionIds = [],
    scoringRules = null,
    optionalPolicy = null,
    restrictions = null,
    provenance = null,
    startQuestion = null,
    endQuestion = null,
    maximumMarks = null,
    questionRanges = [],
    subject = null
}) {
    if (!sectionId || typeof sectionId !== "string" || !sectionId.trim()) {
        throw new Error("[UIR] Section requires a valid non-empty 'sectionId'.");
    }
    if (!sectionName || typeof sectionName !== "string" || !sectionName.trim()) {
        throw new Error("[UIR] Section requires a valid non-empty 'sectionName'.");
    }

    return {
        sectionId: sectionId.trim(),
        sectionName: sectionName.trim(),
        subject: subject ? String(subject).trim() : null,
        orderIndex: Number.isInteger(orderIndex) ? orderIndex : 0,
        instructions: instructions ? String(instructions).trim() : null,
        questionCount: Number.isInteger(questionCount) ? questionCount : (Array.isArray(questionIds) ? questionIds.length : 0),
        questionIds: Array.isArray(questionIds) ? [...questionIds] : [],
        startQuestion: Number.isInteger(startQuestion) ? startQuestion : null,
        endQuestion: Number.isInteger(endQuestion) ? endQuestion : null,
        maximumMarks: Number.isFinite(maximumMarks) ? maximumMarks : null,
        questionRanges: Array.isArray(questionRanges) ? [...questionRanges] : [],
        scoringRules: scoringRules ? createUIRScoringRule(scoringRules) : createUIRScoringRule(),
        optionalPolicy: optionalPolicy || {
            policyType: UIR_OPTIONAL_POLICIES.NONE,
            requiredCount: null,
            maxSelectable: null
        },
        restrictions: restrictions || {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        provenance: provenance ? createUIRProvenance(provenance) : null
    };
}

/**
 * Factory for UIR Question Model
 */
export function createUIRQuestion({
    questionId,
    questionNumber,
    originalNumbering = null,
    orderIndex = null,
    sectionId = "sec_1",
    sectionName = "Section 1",
    questionType = UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ,
    stem = {},
    options = [],
    correctAnswer = null,
    scoring = null,
    languageVariants = {},
    diagrams = [],
    tables = [],
    formulas = [],
    sourceReference = {},
    provenance = null,
    humanCorrectionHistory = [],
    qualityFlags = {}
}) {
    if (!questionId || typeof questionId !== "string" || !questionId.trim()) {
        throw new Error("[UIR] Question requires a valid non-empty 'questionId'.");
    }
    if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
        throw new Error(`[UIR] Invalid questionNumber: ${questionNumber}. Must be a positive integer.`);
    }

    const cleanStem = {
        text: String(stem?.text || "").trim(),
        format: stem?.format || "markdown_latex",
        diagrams: Array.isArray(stem?.diagrams) ? [...stem.diagrams] : (Array.isArray(diagrams) ? [...diagrams] : []),
        tables: Array.isArray(stem?.tables) ? [...stem.tables] : (Array.isArray(tables) ? [...tables] : []),
        formulas: Array.isArray(stem?.formulas) ? [...stem.formulas] : (Array.isArray(formulas) ? [...formulas] : [])
    };

    const cleanOptions = (options || []).map((opt, idx) => {
        const id = String(opt.id || opt.label || String.fromCharCode(65 + idx)).trim().toUpperCase();
        return {
            id,
            label: opt.label ? String(opt.label).trim() : `(${id})`,
            text: String(opt.text || "").trim(),
            diagramUrl: opt.diagramUrl || null,
            diagramId: opt.diagramId || null,
            formulas: Array.isArray(opt.formulas) ? [...opt.formulas] : []
        };
    });

    const cleanCorrectAnswer = correctAnswer ? {
        answerType: correctAnswer.answerType || (cleanOptions.length > 0 ? UIR_ANSWER_TYPES.SINGLE_CHOICE : UIR_ANSWER_TYPES.NUMERICAL_VALUE),
        acceptedAnswers: Array.isArray(correctAnswer.acceptedAnswers) ? [...correctAnswer.acceptedAnswers] : [],
        numericValue: Number.isFinite(correctAnswer.numericValue) ? correctAnswer.numericValue : null,
        numericRange: (correctAnswer.numericRange && Number.isFinite(correctAnswer.numericRange.min) && Number.isFinite(correctAnswer.numericRange.max))
            ? { min: correctAnswer.numericRange.min, max: correctAnswer.numericRange.max }
            : null,
        tolerance: Number.isFinite(correctAnswer.tolerance) ? correctAnswer.tolerance : null,
        isDropped: Boolean(correctAnswer.isDropped),
        isBonus: Boolean(correctAnswer.isBonus),
        rationale: correctAnswer.rationale ? String(correctAnswer.rationale).trim() : null,
        revisedAnswer: correctAnswer.revisedAnswer || null
    } : null;

    return {
        questionId: questionId.trim(),
        questionNumber,
        originalNumbering: originalNumbering ? String(originalNumbering).trim() : String(questionNumber),
        orderIndex: Number.isInteger(orderIndex) ? orderIndex : (questionNumber - 1),
        sectionId: sectionId ? String(sectionId).trim() : "sec_1",
        sectionName: sectionName ? String(sectionName).trim() : null,
        questionType: String(questionType || UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ).toLowerCase(),
        stem: cleanStem,
        options: cleanOptions,
        correctAnswer: cleanCorrectAnswer,
        scoring: scoring ? createUIRScoringRule(scoring) : createUIRScoringRule(),
        languageVariants: languageVariants && typeof languageVariants === "object" ? { ...languageVariants } : {},
        diagrams: Array.isArray(diagrams) ? [...diagrams] : [...cleanStem.diagrams],
        tables: Array.isArray(tables) ? [...tables] : [...cleanStem.tables],
        formulas: Array.isArray(formulas) ? [...formulas] : [...cleanStem.formulas],
        sourceReference: {
            documentId: sourceReference?.documentId || "question_paper",
            pageNumber: Number.isInteger(sourceReference?.pageNumber) && sourceReference.pageNumber > 0 ? sourceReference.pageNumber : 1,
            lineIndex: sourceReference?.lineIndex ?? null,
            boundingBox: sourceReference?.boundingBox ?? null
        },
        provenance: provenance ? createUIRProvenance(provenance) : null,
        humanCorrectionHistory: Array.isArray(humanCorrectionHistory) ? humanCorrectionHistory.map(createUIRHumanCorrection) : [],
        qualityFlags: {
            isUnreadable: Boolean(qualityFlags?.isUnreadable),
            unreadableReason: qualityFlags?.unreadableReason || null,
            hasDuplicateOptions: Boolean(qualityFlags?.hasDuplicateOptions),
            missingDiagram: Boolean(qualityFlags?.missingDiagram),
            contentCorruptionDetected: Boolean(qualityFlags?.contentCorruptionDetected),
            corruptionReason: qualityFlags?.corruptionReason || null,
            manualVerificationCompleted: Boolean(qualityFlags?.manualVerificationCompleted)
        }
    };
}

/**
 * Factory for complete UIR v3.0 Document
 */
export function createUIRDocument({
    schemaVersion = UIR_SCHEMA_VERSION,
    examMetadata,
    sections = [],
    questions = [],
    scoringConfig = null,
    auditTrail = null
}) {
    if (!examMetadata || typeof examMetadata !== "object") {
        throw new Error("[UIR] createUIRDocument requires valid 'examMetadata' object.");
    }
    if (!examMetadata.examId || typeof examMetadata.examId !== "string" || !examMetadata.examId.trim()) {
        throw new Error("[UIR] 'examMetadata.examId' must be a non-empty string.");
    }

    const cleanMetadata = {
        examId: examMetadata.examId.trim(),
        examTitle: String(examMetadata.examTitle || examMetadata.examId).trim(),
        year: Number.isInteger(examMetadata.year) ? examMetadata.year : new Date().getFullYear(),
        paperCode: examMetadata.paperCode ? String(examMetadata.paperCode).trim() : null,
        shift: examMetadata.shift ? String(examMetadata.shift).trim() : null,
        durationSeconds: Number.isFinite(examMetadata.durationSeconds) && examMetadata.durationSeconds > 0 ? examMetadata.durationSeconds : 7200,
        maximumMarks: Number.isFinite(examMetadata.maximumMarks) && examMetadata.maximumMarks > 0 ? examMetadata.maximumMarks : (questions.length * 4),
        totalQuestions: Number.isInteger(examMetadata.totalQuestions) && examMetadata.totalQuestions > 0 ? examMetadata.totalQuestions : questions.length,
        languages: Array.isArray(examMetadata.languages) && examMetadata.languages.length > 0 ? [...examMetadata.languages] : ["English"],
        sourceDocuments: Array.isArray(examMetadata.sourceDocuments) ? [...examMetadata.sourceDocuments] : [],
        schemaVersion: String(schemaVersion || UIR_SCHEMA_VERSION),
        approvalStatus: String(examMetadata.approvalStatus || UIR_APPROVAL_STATUS.UNAPPROVED),
        provenance: examMetadata.provenance ? createUIRProvenance(examMetadata.provenance) : null
    };

    const cleanSections = (sections || []).map((sec, idx) => createUIRSection({ ...sec, orderIndex: sec.orderIndex ?? idx }));
    const cleanQuestions = (questions || []).map((q, idx) => createUIRQuestion({ ...q, orderIndex: q.orderIndex ?? idx }));

    const cleanScoringConfig = {
        defaultPositiveMarks: Number.isFinite(scoringConfig?.defaultPositiveMarks) ? scoringConfig.defaultPositiveMarks : 1,
        defaultNegativeMarks: Number.isFinite(scoringConfig?.defaultNegativeMarks) ? scoringConfig.defaultNegativeMarks : 0,
        defaultUnansweredMarks: Number.isFinite(scoringConfig?.defaultUnansweredMarks) ? scoringConfig.defaultUnansweredMarks : 0,
        optionalQuestionPolicy: scoringConfig?.optionalQuestionPolicy || UIR_OPTIONAL_POLICIES.NONE,
        droppedQuestionPolicy: scoringConfig?.droppedQuestionPolicy || UIR_DROPPED_POLICIES.FULL_MARKS,
        partialMarkingPolicy: scoringConfig?.partialMarkingPolicy || null
    };

    const cleanAuditTrail = {
        ingestionJobId: auditTrail?.ingestionJobId || `job_${Date.now()}`,
        createdAt: auditTrail?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        publishedWithOverrides: Boolean(auditTrail?.publishedWithOverrides),
        overrides: Array.isArray(auditTrail?.overrides) ? [...auditTrail.overrides] : [],
        validation: auditTrail?.validation || { isValid: true, blockers: [], warnings: [] },
        manualVerification: auditTrail?.manualVerification || null
    };

    return {
        schemaVersion: String(schemaVersion || UIR_SCHEMA_VERSION),
        examMetadata: cleanMetadata,
        sections: cleanSections,
        questions: cleanQuestions,
        scoringConfig: cleanScoringConfig,
        auditTrail: cleanAuditTrail
    };
}
