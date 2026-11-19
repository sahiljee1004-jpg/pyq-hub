/**
 * Universal Ingestion Engine — Extraction Schema & Provenance Data Model
 * 
 * Governing Principle:
 * The documents and approved configuration are the source of exam-specific data.
 * The application code is the universal engine.
 * 
 * Every extracted parameter retains full provenance:
 * - Source document type (question_paper, answer_key, paper_format)
 * - Source page number
 * - Raw evidence text snippet
 * - Extraction method
 * - Confidence score (0.0 to 1.0)
 * - Status: EXPLICIT, INFERRED, UNKNOWN, CONTRADICTORY
 * 
 * The system NEVER invents or defaults missing rules. Missing values are flagged UNKNOWN.
 */

export const ExtractionStatus = Object.freeze({
    EXPLICIT: "EXPLICIT",           // Directly stated in the source text
    INFERRED: "INFERRED",           // Derived from structural analysis (e.g. counting parsed items)
    UNKNOWN: "UNKNOWN",             // Missing in source documents; cannot be proven
    CONTRADICTORY: "CONTRADICTORY"  // Contradictory statements within the documents
});

export const DocumentType = Object.freeze({
    QUESTION_PAPER: "question_paper",
    ANSWER_KEY: "answer_key",
    PAPER_FORMAT: "paper_format"
});

export const ExtractionMethod = Object.freeze({
    LAYOUT_SPATIAL: "layout_spatial",
    TOKEN_PATTERN: "token_pattern",
    OCR: "ocr",
    OCR_LAYOUT_RECONSTRUCTION: "ocr_layout_reconstruction",
    TABLE_STRUCTURE: "table_structure",
    RULE_INFERENCE: "rule_inference"
});

export const UniversalQuestionType = Object.freeze({
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

export const OptionalPolicyType = Object.freeze({
    NONE: "none",
    CHOOSE_N_OF_M: "choose_n_of_m",
    FIRST_K_ATTEMPTED: "first_k_attempted"
});

/**
 * Creates a normalized provenance-backed extraction field.
 * If value is null, undefined, or missing, marks status as UNKNOWN with confidence 0
 * unless explicitly flagged with a specific status such as CONTRADICTORY.
 */
export function createExtractionField(value, options = {}) {
    const isMissing = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
    let status = options.status || (isMissing ? ExtractionStatus.UNKNOWN : ExtractionStatus.EXPLICIT);
    if (options.status === ExtractionStatus.CONTRADICTORY) {
        status = ExtractionStatus.CONTRADICTORY;
    } else if (isMissing && !options.status) {
        status = ExtractionStatus.UNKNOWN;
    }

    const confidence = (status === ExtractionStatus.UNKNOWN || status === ExtractionStatus.CONTRADICTORY)
        ? 0.0
        : Math.min(1.0, Math.max(0.0, Number.isFinite(options.confidence) ? options.confidence : 1.0));

    return {
        value: isMissing ? null : value,
        documentId: options.documentId || DocumentType.QUESTION_PAPER,
        pageNumber: Number.isInteger(options.pageNumber) && options.pageNumber > 0 ? options.pageNumber : 1,
        evidenceText: String(options.evidenceText || "").trim(),
        extractionMethod: options.extractionMethod || ExtractionMethod.TOKEN_PATTERN,
        confidence,
        status
    };
}

/**
 * Canonical model for a Question extracted from Question Paper
 */
export function createQuestionExtraction({
    questionId,
    questionNumber,
    originalNumbering = null,
    sectionId = null,
    sectionName = null,
    questionType = UniversalQuestionType.SINGLE_CHOICE_MCQ,
    stem = {},
    options = [],
    hasDiagram = false,
    diagrams = [],
    tables = [],
    formulas = [],
    sourceReference = {},
    isUnreadable = false,
    unreadableReason = null,
    confidence = 0.95,
    marksAwarded = null,
    marksDeducted = null
}) {
    if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
        throw new Error(`Invalid questionNumber: ${questionNumber}. Must be a positive integer.`);
    }

    const qId = questionId || `q_${questionNumber}`;

    return {
        questionId: qId,
        questionNumber,
        originalNumbering: originalNumbering || String(questionNumber),
        sectionId: sectionId || null,
        sectionName: sectionName || null,
        questionType: questionType || UniversalQuestionType.SINGLE_CHOICE_MCQ,
        marksAwarded: Number.isFinite(marksAwarded) ? marksAwarded : null,
        marksDeducted: Number.isFinite(marksDeducted) ? marksDeducted : null,
        stem: {
            text: String(stem.text || "").trim(),
            format: stem.format || "markdown_latex",
            diagrams: Array.isArray(stem.diagrams) ? stem.diagrams : (diagrams || []),
            tables: Array.isArray(stem.tables) ? stem.tables : (tables || []),
            formulas: Array.isArray(stem.formulas) ? stem.formulas : (formulas || [])
        },
        options: (Array.isArray(options) ? options : []).map((opt, idx) => ({
            id: String(opt.id || String.fromCharCode(65 + idx)).trim().toUpperCase(),
            label: String(opt.label || `(${opt.id || String.fromCharCode(65 + idx)})`).trim(),
            text: String(opt.text || "").trim(),
            formulas: Array.isArray(opt.formulas) ? opt.formulas : [],
            diagramUrl: opt.diagramUrl || null
        })),
        hasDiagram: Boolean(hasDiagram || (diagrams && diagrams.length > 0)),
        sourceReference: {
            documentId: sourceReference.documentId || DocumentType.QUESTION_PAPER,
            pageNumber: sourceReference.pageNumber || 1,
            lineIndex: Number.isInteger(sourceReference.lineIndex) ? sourceReference.lineIndex : null,
            boundingBox: sourceReference.boundingBox || null
        },
        isUnreadable: Boolean(isUnreadable),
        unreadableReason: unreadableReason || null,
        confidence: Number.isFinite(confidence) ? confidence : 0.95
    };
}

/**
 * Canonical model for a Section extracted from Question Paper or Format Document
 */
export function createSectionExtraction({
    sectionId,
    sectionName,
    subject = null,
    startQuestion = null,
    endQuestion = null,
    questionCount = 0,
    requiredAttemptCount = null,
    optionalPolicy = OptionalPolicyType.NONE,
    instructions = null,
    defaultMarking = null,
    provenance = null
}) {
    const sId = sectionId || (sectionName ? `sec_${sectionName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : "sec_default");

    return {
        sectionId: sId,
        sectionName: String(sectionName || "Default Section").trim(),
        subject: subject ? String(subject).trim() : null,
        startQuestion: Number.isInteger(startQuestion) ? startQuestion : null,
        endQuestion: Number.isInteger(endQuestion) ? endQuestion : null,
        questionCount: Number.isInteger(questionCount) ? questionCount : 0,
        requiredAttemptCount: Number.isInteger(requiredAttemptCount) ? requiredAttemptCount : (questionCount || null),
        optionalPolicy: optionalPolicy || OptionalPolicyType.NONE,
        instructions: instructions ? String(instructions).trim() : null,
        defaultMarking: defaultMarking || null,
        provenance: provenance || createExtractionField(sectionName, { extractionMethod: ExtractionMethod.LAYOUT_SPATIAL })
    };
}

/**
 * Canonical model for an Answer Key entry
 */
export function createAnswerKeyExtraction({
    questionNumber,
    questionId = null,
    answerType = "single_choice",
    acceptedAnswers = [],
    numericValue = null,
    numericRange = null,
    isDropped = false,
    isBonus = false,
    paperSeries = null,
    paperCode = null,
    evidenceText = "",
    pageNumber = 1,
    confidence = 0.95
}) {
    if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
        throw new Error(`Invalid answer key questionNumber: ${questionNumber}. Must be a positive integer.`);
    }

    const cleanAccepted = (Array.isArray(acceptedAnswers) ? acceptedAnswers : [])
        .map(a => String(a).trim().toUpperCase())
        .filter(Boolean);

    return {
        questionNumber,
        questionId: questionId || `q_${questionNumber}`,
        answerType,
        acceptedAnswers: cleanAccepted,
        numericValue: Number.isFinite(numericValue) ? numericValue : null,
        numericRange: numericRange && Number.isFinite(numericRange.min) && Number.isFinite(numericRange.max)
            ? { min: numericRange.min, max: numericRange.max }
            : null,
        isDropped: Boolean(isDropped),
        isBonus: Boolean(isBonus),
        paperSeries: paperSeries ? String(paperSeries).trim() : null,
        paperCode: paperCode ? String(paperCode).trim() : null,
        provenance: createExtractionField(cleanAccepted.join(", ") || (isDropped ? "DROPPED" : null), {
            documentId: DocumentType.ANSWER_KEY,
            pageNumber,
            evidenceText,
            extractionMethod: ExtractionMethod.TOKEN_PATTERN,
            confidence: (isDropped || isBonus || cleanAccepted.length > 0 || numericValue !== null || numericRange !== null)
                ? confidence
                : 0.0,
            status: (isDropped || isBonus || cleanAccepted.length > 0 || numericValue !== null || numericRange !== null)
                ? ExtractionStatus.EXPLICIT
                : ExtractionStatus.UNKNOWN
        })
    };
}

/**
 * Canonical model for Paper Format / Examination Rules
 */
export function createPaperFormatExtraction({
    examTitle = null,
    paperCode = null,
    durationSeconds = null,
    totalQuestions = null,
    maximumMarks = null,
    sections = [],
    positiveMarks = null,
    negativeMarks = null,
    unansweredMarks = null,
    optionalQuestionRules = [],
    droppedQuestionPolicy = null,
    rawTextSnippets = []
}) {
    const toField = (input, defaultConfidence = 0.9) => {
        if (input && typeof input === "object" && ("status" in input || "value" in input)) {
            return createExtractionField(input.value, {
                documentId: DocumentType.PAPER_FORMAT,
                evidenceText: input.evidenceText || "",
                pageNumber: input.pageNumber || 1,
                extractionMethod: input.extractionMethod || ExtractionMethod.TOKEN_PATTERN,
                confidence: input.confidence ?? defaultConfidence,
                status: input.status
            });
        }
        return createExtractionField(input, {
            documentId: DocumentType.PAPER_FORMAT,
            confidence: defaultConfidence
        });
    };

    return {
        examTitle: toField(examTitle),
        paperCode: toField(paperCode),
        durationSeconds: toField(durationSeconds),
        totalQuestions: toField(totalQuestions),
        maximumMarks: toField(maximumMarks),
        sections: Array.isArray(sections) ? sections : [],
        markingRules: {
            positiveMarks: toField(positiveMarks),
            negativeMarks: toField(negativeMarks),
            unansweredMarks: toField(unansweredMarks)
        },
        optionalQuestionRules: Array.isArray(optionalQuestionRules) ? optionalQuestionRules : [],
        droppedQuestionPolicy: toField(droppedQuestionPolicy),
        rawTextSnippets: Array.isArray(rawTextSnippets) ? rawTextSnippets : []
    };
}
