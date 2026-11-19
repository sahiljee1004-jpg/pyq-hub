import {
    UIR_SCHEMA_VERSION,
    UIR_QUESTION_TYPES,
    UIR_ANSWER_TYPES,
    UIR_OPTIONAL_POLICIES,
    UIR_DROPPED_POLICIES,
    UIR_APPROVAL_STATUS,
    createUIRDocument,
    createUIRSection,
    createUIRQuestion,
    createUIRScoringRule,
    createUIRProvenance,
    createUIRHumanCorrection
} from "./uirSchema.js";
import { UIRValidator } from "./uirValidator.js";
import { UniversalDocumentIngestionService } from "../ingestion/universalDocumentIngestionService.js";
import { UniversalQuestionType } from "../ingestion/extractionSchema.js";

/**
 * Universal Intermediate Representation (UIR v3.0) — Transformation & Reconciliation Service
 * 
 * Reconciles the multi-document extraction manifest produced by the Ingestion Engine
 * into a single, standardized, canonical UIR v3.0 Examination Model.
 */
export class UIRTransformationService {

    /**
     * Ingests three source documents and transforms directly into UIR v3.0
     * 
     * @param {object} inputs
     * @param {Buffer|string} inputs.questionPaper
     * @param {Buffer|string} inputs.answerKey
     * @param {Buffer|string} inputs.paperFormat
     * @param {object} [options]
     * @returns {Promise<{ uirDocument: object, validation: object, ingestionManifest: object }>}
     */
    static async transformDocuments({ questionPaper, answerKey, paperFormat }, options = {}) {
        const ingestionManifest = await UniversalDocumentIngestionService.ingestDocuments(
            { questionPaper, answerKey, paperFormat },
            options
        );

        const transformationResult = this.transformIngestionManifest(ingestionManifest, options);

        return {
            ...transformationResult,
            ingestionManifest
        };
    }

    /**
     * Transforms an existing Ingestion Manifest into UIR v3.0
     * 
     * @param {object} manifest 
     * @param {object} [options]
     * @returns {{ uirDocument: object, validation: object }}
     */
    static transformIngestionManifest(manifest, options = {}) {
        if (!manifest || !manifest.extractions) {
            throw new Error("[UIRTransformationService] Invalid manifest: missing extractions.");
        }

        const qp = manifest.extractions.questionPaper || { questions: [], sections: [] };
        const ak = manifest.extractions.answerKey || { answers: [] };
        const pf = manifest.extractions.paperFormat || {};
        const prov = manifest.documentProvenance || {};
        const pubVal = manifest.publicationValidation || { isApproved: false, publicationBlockers: [] };

        // 1. Reconcile Exam Identity & Metadata
        const rawExamId = options.examId
            || pf.header?.paperCode?.value
            || (qp.header?.examTitle?.value ? qp.header.examTitle.value.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null)
            || "universal-mock-test";
        const examId = String(rawExamId).trim();

        const examTitle = options.examTitle
            || pf.examTitle?.value
            || qp.header?.examTitle?.value
            || examId.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());

        let year = options.year || pf.header?.year?.value;
        if (!year) {
            const yrMatch = examTitle.match(/\b(19\d\d|20\d\d)\b/) || examId.match(/\b(19\d\d|20\d\d)\b/);
            year = yrMatch ? parseInt(yrMatch[1], 10) : new Date().getFullYear();
        }

        const paperCode = options.paperCode || ak.header?.paperCode?.value || pf.header?.paperCode?.value || pf.paperCode?.value || null;
        const shift = options.shift || ak.header?.paperSeries?.value || null;

        const durationSeconds = options.durationSeconds
            || pf.durationSeconds?.value
            || qp.header?.durationSeconds?.value
            || 7200;

        const totalQuestions = (qp.questions && qp.questions.length > 0)
            ? qp.questions.length
            : (pf.totalQuestions?.value || 0);

        const maximumMarks = options.maximumMarks
            || pf.maximumMarks?.value
            || qp.header?.maximumMarks?.value
            || (totalQuestions * 4);

        // Language discovery
        const languages = new Set(["English"]);
        for (const q of (qp.questions || [])) {
            if (q.bilingual) {
                languages.add("Hindi");
            }
        }
        if (options.languages && Array.isArray(options.languages)) {
            for (const lang of options.languages) languages.add(lang);
        }

        const sourceDocuments = [
            {
                type: "question_paper",
                sha256: prov.questionPaper?.sha256 || null,
                sizeBytes: prov.questionPaper?.sizeBytes || 0,
                questionCount: prov.questionPaper?.questionCount || 0
            },
            {
                type: "answer_key",
                sha256: prov.answerKey?.sha256 || null,
                sizeBytes: prov.answerKey?.sizeBytes || 0,
                answerCount: prov.answerKey?.answerCount || 0
            },
            {
                type: "paper_format",
                sha256: prov.paperFormat?.sha256 || null,
                sizeBytes: prov.paperFormat?.sizeBytes || 0
            }
        ];

        // 2. Determine Approval Status
        let approvalStatus = UIR_APPROVAL_STATUS.UNAPPROVED;
        let publishedWithOverrides = false;

        if (options.approvalStatus) {
            approvalStatus = options.approvalStatus;
        } else if (pubVal.isApproved === true) {
            approvalStatus = UIR_APPROVAL_STATUS.APPROVED;
        } else if (pubVal.overridesApplied && pubVal.overridesApplied.length > 0 && pubVal.publicationBlockers.length === 0) {
            approvalStatus = UIR_APPROVAL_STATUS.APPROVED;
            publishedWithOverrides = true;
        }

        // 3. Reconcile Global Scoring Rules
        const defaultPositiveMarks = pf.markingRules?.positiveMarks?.value !== null && pf.markingRules?.positiveMarks?.value !== undefined
            ? pf.markingRules.positiveMarks.value
            : 1;

        const defaultNegativeMarks = pf.markingRules?.negativeMarks?.value !== null && pf.markingRules?.negativeMarks?.value !== undefined
            ? pf.markingRules.negativeMarks.value
            : 0;

        const defaultUnansweredMarks = pf.markingRules?.unansweredMarks?.value !== null && pf.markingRules?.unansweredMarks?.value !== undefined
            ? pf.markingRules.unansweredMarks.value
            : 0;

        const scoringConfig = {
            defaultPositiveMarks,
            defaultNegativeMarks,
            defaultUnansweredMarks,
            optionalQuestionPolicy: pf.optionalPolicy?.policyType || UIR_OPTIONAL_POLICIES.NONE,
            droppedQuestionPolicy: pf.droppedPolicy?.policyType || UIR_DROPPED_POLICIES.FULL_MARKS,
            partialMarkingPolicy: null
        };

        // 4. Reconcile Sections
        const sections = [];
        const rawSections = (Array.isArray(qp.sections) && qp.sections.length > 1)
            ? qp.sections
            : (Array.isArray(pf.sections) && pf.sections.length > 1
                ? pf.sections
                : ((Array.isArray(qp.sections) && qp.sections.length > 0) ? qp.sections : (Array.isArray(pf.sections) && pf.sections.length > 0 ? pf.sections : [])));

        if (rawSections.length > 0) {
            for (let i = 0; i < rawSections.length; i++) {
                const s = rawSections[i];
                const secId = s.sectionId || `sec_${i + 1}`;
                const secName = s.sectionName || `Section ${i + 1}`;

                // Associate questions belonging to this section
                const memberQuestions = (qp.questions || []).filter(q =>
                    q.sectionId === secId ||
                    q.sectionName === secName ||
                    (s.startQuestion && s.endQuestion && q.questionNumber >= s.startQuestion && q.questionNumber <= s.endQuestion)
                );
                const questionIds = memberQuestions.map(mq => `${examId}_q_${mq.questionNumber}`);

                // Check if format document declared specific section rules
                let secScoring = {
                    positiveMarks: defaultPositiveMarks,
                    negativeMarks: defaultNegativeMarks,
                    unansweredMarks: defaultUnansweredMarks
                };

                if (Array.isArray(pf.sections)) {
                    const matchedPfSec = pf.sections.find((ps, psIdx) => 
                        ps.sectionId === secId || 
                        ps.sectionName?.toLowerCase() === secName.toLowerCase() ||
                        secName.toLowerCase().includes(ps.sectionName?.toLowerCase()) ||
                        (ps.sectionName && secName.toLowerCase().includes(ps.sectionName.toLowerCase())) ||
                        (ps.orderIndex !== undefined ? ps.orderIndex === i : psIdx === i)
                    );
                    if (matchedPfSec && matchedPfSec.markingRules) {
                        if (matchedPfSec.markingRules.positiveMarks?.value !== null && matchedPfSec.markingRules.positiveMarks?.value !== undefined) {
                            secScoring.positiveMarks = matchedPfSec.markingRules.positiveMarks.value;
                        }
                        if (matchedPfSec.markingRules.negativeMarks?.value !== null && matchedPfSec.markingRules.negativeMarks?.value !== undefined) {
                            secScoring.negativeMarks = matchedPfSec.markingRules.negativeMarks.value;
                        }
                    }
                }

                sections.push(createUIRSection({
                    sectionId: secId,
                    sectionName: secName,
                    subject: s.subject || secName,
                    orderIndex: i,
                    questionCount: memberQuestions.length || s.questionCount || 0,
                    questionIds,
                    startQuestion: s.startQuestion || (memberQuestions[0]?.questionNumber || null),
                    endQuestion: s.endQuestion || (memberQuestions[memberQuestions.length - 1]?.questionNumber || null),
                    maximumMarks: s.maximumMarks || null,
                    questionRanges: s.questionRanges || [],
                    scoringRules: secScoring,
                    optionalPolicy: pf.optionalPolicy || { policyType: UIR_OPTIONAL_POLICIES.NONE }
                }));
            }
        } else {
            // Default single section when question paper does not define section headers
            const allQIds = (qp.questions || []).map(q => `${examId}_q_${q.questionNumber}`);
            sections.push(createUIRSection({
                sectionId: "sec_1",
                sectionName: "General",
                orderIndex: 0,
                questionCount: allQIds.length,
                questionIds: allQIds,
                scoringRules: {
                    positiveMarks: defaultPositiveMarks,
                    negativeMarks: defaultNegativeMarks,
                    unansweredMarks: defaultUnansweredMarks
                },
                optionalPolicy: pf.optionalPolicy || { policyType: UIR_OPTIONAL_POLICIES.NONE }
            }));
        }

        // Section map for rapid lookup during question normalization
        const sectionMap = new Map(sections.map(s => [s.sectionId, s]));

        // 5. Reconcile Questions & Answer Keys
        const answersMap = new Map();
        for (const ans of (ak.answers || [])) {
            answersMap.set(ans.questionNumber, ans);
        }

        const questions = [];
        const seenQIds = new Set();
        for (let i = 0; i < (qp.questions || []).length; i++) {
            const rawQ = qp.questions[i];
            const qNum = rawQ.questionNumber;
            let targetSecId = null;
            const matchedSecByRange = sections.find(s =>
                (s.startQuestion && s.endQuestion && qNum >= s.startQuestion && qNum <= s.endQuestion) ||
                (s.questionIds && s.questionIds.includes(`${examId}_q_${qNum}`))
            );
            if (matchedSecByRange) {
                targetSecId = matchedSecByRange.sectionId;
            } else if (rawQ.sectionId && sectionMap.has(rawQ.sectionId)) {
                targetSecId = rawQ.sectionId;
            } else {
                targetSecId = sections[0].sectionId;
            }

            // Guarantee universal unique questionId across all sections and numbering restarts
            let qId = `${examId}_q_${qNum}`;
            if (seenQIds.has(qId)) {
                qId = targetSecId ? `${examId}_${targetSecId}_q_${qNum}` : `${examId}_q_${qNum}_${i + 1}`;
                if (seenQIds.has(qId)) {
                    qId = `${examId}_q_${qNum}_idx${i + 1}`;
                }
            }
            seenQIds.add(qId);
            const parentSec = sectionMap.get(targetSecId);

            // Answer mapping lookup
            const matchedAns = answersMap.get(qNum);

            // Reconcile question type
            let uirQType = UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ;
            const incomingType = String(rawQ.questionType || "").toLowerCase();
            if (incomingType === UniversalQuestionType.NUMERICAL_NAT || incomingType === "numerical" || incomingType === "nat") {
                uirQType = UIR_QUESTION_TYPES.NUMERICAL_NAT;
            } else if (incomingType === UniversalQuestionType.MULTIPLE_CHOICE_MSQ || incomingType === "msq") {
                uirQType = UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ;
            } else if (matchedAns && Array.isArray(matchedAns.acceptedAnswers) && matchedAns.acceptedAnswers.length > 1 && rawQ.options && rawQ.options.length > 0) {
                const isSingleChoiceOnly = (pf.defaultQuestionType === "single_choice_mcq") ||
                    (Array.isArray(pf.rawTextSnippets) && pf.rawTextSnippets.some(s => /single\s*(?:correct|choice)/i.test(s.snippet))) ||
                    (/single\s*(?:correct|choice)/i.test(pf.examTitle || ""));
                uirQType = isSingleChoiceOnly ? UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ : UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ;
            } else if (incomingType === UniversalQuestionType.MATCH_FOLLOWING || incomingType === "matching") {
                uirQType = UIR_QUESTION_TYPES.MATCHING;
            } else if (incomingType === UniversalQuestionType.ASSERTION_REASON || incomingType === "assertion_reason" || (/assertion/i.test(rawQ.stemText) && /reason/i.test(rawQ.stemText))) {
                uirQType = UIR_QUESTION_TYPES.ASSERTION_REASON;
            } else if (incomingType === UniversalQuestionType.FILL_IN_THE_BLANKS || incomingType === "fill_in_blanks") {
                uirQType = UIR_QUESTION_TYPES.FILL_IN_BLANKS;
            } else if (incomingType === UniversalQuestionType.DESCRIPTIVE_MANUAL || incomingType === "descriptive_manual" || incomingType === "descriptive" || (/describe|derive/i.test(rawQ.stemText) && (!rawQ.options || rawQ.options.length === 0))) {
                uirQType = UIR_QUESTION_TYPES.DESCRIPTIVE_MANUAL;
            } else if (rawQ.options && rawQ.options.length === 0) {
                uirQType = UIR_QUESTION_TYPES.NUMERICAL_NAT;
            }

            // Reconcile options
            const options = (rawQ.options || []).map(o => ({
                id: o.id,
                label: o.label || `(${o.id})`,
                text: o.text || "",
                diagramUrl: o.diagramUrl || null,
                diagramId: o.diagramId || null,
                formulas: o.formulas || []
            }));

            // Check for duplicate option text (content corruption signal)
            let hasDuplicateOptions = false;
            let contentCorruptionDetected = false;
            let corruptionReason = null;
            if (options.length > 0) {
                const seenOptTexts = new Set();
                for (const opt of options) {
                    const t = (opt.text || "").trim();
                    if (t.length > 0 && seenOptTexts.has(t)) {
                        hasDuplicateOptions = true;
                        contentCorruptionDetected = true;
                        corruptionReason = `Duplicate option text "${t}" detected. Indicates possible PDF font glyph encoding loss.`;
                        break;
                    }
                    if (t.length > 0) seenOptTexts.add(t);
                }
            }

            // Check for missing referenced diagrams
            const stemText = rawQ.stem?.text || "";
            const referencesDiagram = /(?:(?:refer\s+to\s+)?\b(?:Figure|Fig\b\.?|Diagram|Graph)\b\s*([0-9A-Z]+)?|in\s+the\s+diagram\s+below|shown\s+in\s+the\s+(?:figure|graph)|graph\s+is\s+(?:plotted|pletted)\s+as\s+shown)/i.test(stemText);
            const qDiagrams = rawQ.stem?.diagrams || rawQ.diagrams || [];
            const missingDiagram = referencesDiagram && (!rawQ.hasDiagram || qDiagrams.length === 0);

            // Reconcile correct answer
            let correctAnswer = null;
            if (matchedAns) {
                let ansType = UIR_ANSWER_TYPES.SINGLE_CHOICE;
                let numVal = matchedAns.numericValue;

                if (uirQType === UIR_QUESTION_TYPES.NUMERICAL_NAT) {
                    ansType = matchedAns.numericRange ? UIR_ANSWER_TYPES.NUMERICAL_RANGE : UIR_ANSWER_TYPES.NUMERICAL_VALUE;
                    if (numVal === null || numVal === undefined) {
                        const rawTok = matchedAns.acceptedAnswers?.[0];
                        if (rawTok) {
                            const parsed = parseFloat(rawTok);
                            if (Number.isFinite(parsed)) {
                                numVal = parsed;
                            } else if (/^[A-E]$/i.test(rawTok)) {
                                numVal = rawTok.toUpperCase().charCodeAt(0) - 64;
                            }
                        }
                    }
                } else if (uirQType === UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ || (matchedAns.acceptedAnswers && matchedAns.acceptedAnswers.length > 1)) {
                    ansType = UIR_ANSWER_TYPES.MULTIPLE_CHOICE;
                }

                correctAnswer = {
                    answerType: ansType,
                    acceptedAnswers: matchedAns.acceptedAnswers || [],
                    numericValue: numVal,
                    numericRange: matchedAns.numericRange,
                    tolerance: matchedAns.tolerance || null,
                    isDropped: Boolean(matchedAns.isDropped),
                    isBonus: Boolean(matchedAns.isBonus),
                    rationale: matchedAns.rationale || null,
                    revisedAnswer: matchedAns.revisedAnswer || null
                };
            }

            // Reconcile scoring for question following strict 4-level precedence:
            // 1. Question-level -> 2. Section-level -> 3. Examination-level -> 4. Default / Fail-closed
            let positiveMarks = defaultPositiveMarks;
            let negativeMarks = defaultNegativeMarks;

            // Positive marks resolution
            if (Number.isFinite(rawQ.marksAwarded)) {
                positiveMarks = rawQ.marksAwarded;
            } else if (matchedAns && Number.isFinite(matchedAns.marksAwarded)) {
                positiveMarks = matchedAns.marksAwarded;
            } else if (parentSec?.questionRanges && Array.isArray(parentSec.questionRanges)) {
                const matchedRange = parentSec.questionRanges.find(r => qNum >= r.startQ && qNum <= r.endQ);
                if (matchedRange && Number.isFinite(matchedRange.positiveMarks)) {
                    positiveMarks = matchedRange.positiveMarks;
                }
            } else if (parentSec?.scoringRules?.positiveMarks !== undefined && Number.isFinite(parentSec.scoringRules.positiveMarks)) {
                positiveMarks = parentSec.scoringRules.positiveMarks;
            }

            // Negative marks resolution (strict precedence: Question -> Section -> Examination)
            if (Number.isFinite(rawQ.marksDeducted)) {
                // Level 1: Explicit question-level deduction
                negativeMarks = -Math.abs(rawQ.marksDeducted);
            } else if (matchedAns && Number.isFinite(matchedAns.marksDeducted)) {
                // Level 1: Explicit answer-key question-level deduction
                negativeMarks = -Math.abs(matchedAns.marksDeducted);
            } else if (parentSec?.questionTypeRules?.[uirQType]?.negativeMarks !== undefined) {
                // Level 2: Section-level question-type rule
                negativeMarks = -Math.abs(parentSec.questionTypeRules[uirQType].negativeMarks);
            } else if (parentSec?.questionRanges && Array.isArray(parentSec.questionRanges)) {
                const matchedRange = parentSec.questionRanges.find(r => qNum >= r.startQ && qNum <= r.endQ);
                if (matchedRange && Number.isFinite(matchedRange.negativeMarks)) {
                    negativeMarks = -Math.abs(matchedRange.negativeMarks);
                } else if (parentSec?.scoringRules?.negativeMarks !== undefined && parentSec.scoringRules.negativeMarks !== null) {
                    negativeMarks = parentSec.scoringRules.negativeMarks;
                }
            } else if (parentSec?.scoringRules?.negativeMarks !== undefined && parentSec.scoringRules.negativeMarks !== null) {
                // Level 2: Section-level scoring rules
                negativeMarks = parentSec.scoringRules.negativeMarks;
            } else if (uirQType === UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ || uirQType === UIR_QUESTION_TYPES.NUMERICAL_NAT) {
                // Level 3: Examination rule - MSQ and NAT do not carry negative marking unless explicitly defined above
                negativeMarks = 0;
            } else if (positiveMarks === 2 && (defaultNegativeMarks === -0.3333 || defaultNegativeMarks === -1 / 3)) {
                // Level 3: Examination proportional scaling for 2-mark MCQs
                negativeMarks = -2 / 3;
            }

            const qScoring = createUIRScoringRule({
                positiveMarks,
                negativeMarks,
                unansweredMarks: defaultUnansweredMarks,
                isOverride: (positiveMarks !== defaultPositiveMarks || negativeMarks !== defaultNegativeMarks)
            });

            // Reconcile language variants (bilingual parallel text)
            const languageVariants = {};
            if (rawQ.bilingual) {
                languageVariants["hi"] = {
                    stemText: rawQ.bilingual.parallelStem || "",
                    options: (rawQ.bilingual.parallelOptions || []).map(po => ({
                        id: po.id,
                        label: po.label,
                        text: po.text
                    })),
                    originalNumbering: rawQ.bilingual.parallelNumbering || String(qNum)
                };
            }

            // Check manual verification status and evidence-based corrections for questions with detected anomalies
            let manualVerificationCompleted = false;
            if (options.manualCorrections && Array.isArray(options.manualCorrections)) {
                const corrections = options.manualCorrections.filter(c => c.questionNumber === qNum || c.questionId === qId);
                if (corrections.length > 0) {
                    manualVerificationCompleted = true;
                    for (const corr of corrections) {
                        if (corr.field && corr.field.startsWith("options.") && corr.newValue !== undefined) {
                            const optIndex = parseInt(corr.field.split(".")[1], 10);
                            if (options[optIndex]) {
                                options[optIndex].originalText = options[optIndex].text;
                                options[optIndex].text = corr.newValue;
                            }
                        }
                        if (corr.overrideDuplicateOptions === true) {
                            hasDuplicateOptions = false;
                            contentCorruptionDetected = false;
                        }
                    }
                }
            }

            questions.push(createUIRQuestion({
                questionId: qId,
                questionNumber: qNum,
                originalNumbering: rawQ.originalNumbering || String(qNum),
                orderIndex: i,
                sectionId: targetSecId,
                sectionName: parentSec ? parentSec.sectionName : null,
                questionType: uirQType,
                stem: {
                    text: rawQ.stem?.text || "",
                    format: rawQ.stem?.format || "markdown_latex",
                    diagrams: qDiagrams,
                    tables: rawQ.stem?.tables || rawQ.tables || [],
                    formulas: rawQ.stem?.formulas || rawQ.formulas || []
                },
                options,
                correctAnswer,
                scoring: qScoring,
                languageVariants,
                diagrams: qDiagrams,
                tables: rawQ.stem?.tables || rawQ.tables || [],
                formulas: rawQ.stem?.formulas || rawQ.formulas || [],
                sourceReference: rawQ.sourceReference || { documentId: "question_paper", pageNumber: rawQ.provenance?.originalPdfPage || 1 },
                provenance: rawQ.provenance ? createUIRProvenance({
                    documentId: rawQ.provenance.sourceDocId || rawQ.provenance.documentId || "question_paper",
                    pageNumber: rawQ.provenance.originalPdfPage || rawQ.provenance.pageNumber || 1,
                    evidenceText: rawQ.provenance.evidenceText || rawQ.stem?.text || "",
                    extractionMethod: rawQ.provenance.extractionMethod || "layout_spatial",
                    confidence: rawQ.provenance.confidence ?? 1.0,
                    status: rawQ.provenance.status || "EXPLICIT",
                    bbox: rawQ.provenance.bbox || null,
                    ocrEngine: rawQ.provenance.ocrEngine || null,
                    ocrVersion: rawQ.provenance.ocrVersion || null,
                    ocrPageNumber: rawQ.provenance.ocrPageNumber || null,
                    originalOcrText: rawQ.provenance.originalOcrText || null,
                    normalizedText: rawQ.provenance.normalizedText || null,
                    visionModel: rawQ.provenance.visionModel || null,
                    visionConfidence: rawQ.provenance.visionConfidence ?? null,
                    crossModelAgreement: rawQ.provenance.crossModelAgreement ?? null,
                    reconciledBy: rawQ.provenance.reconciledBy || null
                }) : null,
                humanCorrectionHistory: options.manualCorrections ? options.manualCorrections.filter(c => c.questionNumber === qNum) : [],
                qualityFlags: {
                    isUnreadable: Boolean(rawQ.isUnreadable),
                    unreadableReason: rawQ.unreadableReason,
                    hasDuplicateOptions,
                    missingDiagram,
                    contentCorruptionDetected,
                    corruptionReason,
                    manualVerificationCompleted
                }
            }));
        }

        // Build audit trail
        const auditTrail = {
            ingestionJobId: manifest.ingestionJobId || `job_${Date.now()}`,
            createdAt: manifest.startedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            publishedWithOverrides,
            overrides: pubVal.overridesApplied || [],
            validation: {
                isValid: manifest.validation?.isValid ?? true,
                blockers: manifest.validation?.blockers || [],
                publicationBlockers: pubVal.publicationBlockers || []
            },
            manualVerification: options.manualVerification || null
        };

        // Construct final canonical document
        const uirDocument = createUIRDocument({
            schemaVersion: UIR_SCHEMA_VERSION,
            examMetadata: {
                examId,
                examTitle,
                year,
                paperCode,
                shift,
                durationSeconds,
                maximumMarks,
                totalQuestions: questions.length > 0 ? questions.length : totalQuestions,
                languages: Array.from(languages),
                sourceDocuments,
                approvalStatus,
                provenance: createUIRProvenance({
                    documentId: "paper_format",
                    pageNumber: 1,
                    evidenceText: examTitle,
                    extractionMethod: "layout_spatial"
                })
            },
            sections,
            questions,
            scoringConfig,
            auditTrail
        });

        // Run strict validation on output
        const validation = UIRValidator.validate(uirDocument);

        return {
            uirDocument,
            validation
        };
    }

    /**
     * Applies an audited human verification/correction to a UIR question
     * 
     * @param {object} uirDocument
     * @param {object} params
     * @param {number|string} params.questionNumber
     * @param {string} [params.questionId]
     * @param {string} [params.modifiedBy]
     * @param {string} [params.field]
     * @param {any} [params.newValue]
     * @param {string} [params.reason]
     * @param {object[]} [params.correctedOptions]
     * @param {string} [params.correctedStem]
     * @returns {object} Updated uirDocument
     */
    static applyHumanCorrection(uirDocument, {
        questionNumber,
        questionId,
        modifiedBy = "admin_auditor",
        field = "options",
        newValue = null,
        reason = "Manual verification and font corruption remediation",
        correctedOptions = null,
        correctedStem = null
    }) {
        if (!uirDocument || !Array.isArray(uirDocument.questions)) {
            throw new Error("[UIRTransformationService] Invalid UIR document.");
        }

        const question = uirDocument.questions.find(q => 
            (questionNumber !== undefined && q.questionNumber === Number(questionNumber)) ||
            (questionId && q.questionId === questionId)
        );

        if (!question) {
            throw new Error(`[UIRTransformationService] Question ${questionNumber || questionId} not found in UIR document.`);
        }

        const prevValue = correctedOptions ? question.options : (correctedStem ? question.stem.text : question[field]);
        const correctionRecord = createUIRHumanCorrection({
            modifiedBy: modifiedBy || "admin_auditor",
            field: correctedOptions ? "options" : (correctedStem ? "stem.text" : field),
            previousValue: prevValue,
            newValue: newValue || (correctedOptions ? correctedOptions : correctedStem),
            reason
        });

        if (!Array.isArray(question.humanCorrectionHistory)) {
            question.humanCorrectionHistory = [];
        }
        question.humanCorrectionHistory.push(correctionRecord);

        if (correctedOptions && Array.isArray(correctedOptions)) {
            question.options = correctedOptions.map((o, idx) => ({
                id: o.id || String.fromCharCode(65 + idx),
                label: o.label || `(${o.id || String.fromCharCode(65 + idx)})`,
                text: o.text || "",
                diagramUrl: o.diagramUrl || null,
                diagramId: o.diagramId || null,
                formulas: o.formulas || []
            }));
        }

        if (correctedStem) {
            question.stem.text = correctedStem;
        } else if (field === "stem.text" || field === "questionText" || field === "stem") {
            question.stem.text = String(newValue || "");
        }

        // Mark manual verification as completed and resolve content corruption
        question.qualityFlags.manualVerificationCompleted = true;
        question.qualityFlags.contentCorruptionDetected = false;

        uirDocument.auditTrail.updatedAt = new Date().toISOString();
        if (!uirDocument.auditTrail.manualVerification) {
            uirDocument.auditTrail.manualVerification = {
                verifiedAt: new Date().toISOString(),
                verifiedBy: modifiedBy || "admin_auditor",
                correctionsCount: 0
            };
        }
        uirDocument.auditTrail.manualVerification.correctionsCount++;

        return uirDocument;
    }
}
