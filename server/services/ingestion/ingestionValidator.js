import { ExtractionStatus, UniversalQuestionType } from "./extractionSchema.js";

/**
 * Validates raw multi-document extractions prior to downstream reconciliation
 */
export class IngestionValidator {

    /**
     * Run syntactic and structural integrity checks on the raw ingestion output
     * @param {object} param0
     * @returns {{ isValid: boolean, blockers: string[], warnings: string[] }}
     */
    static validate({ questionPaperExtraction, answerKeyExtraction, paperFormatExtraction }) {
        const blockers = [];
        const warnings = [];

        // 1. Question Paper Ingestion Checks
        if (!questionPaperExtraction) {
            blockers.push("Question Paper extraction is missing.");
        } else {
            if (questionPaperExtraction.isScanned && !questionPaperExtraction.ocrManifest) {
                const totalP = questionPaperExtraction.scanDetection?.totalPages || "multiple";
                const avgChars = questionPaperExtraction.scanDetection?.averageCharsPerPage !== undefined
                    ? questionPaperExtraction.scanDetection.averageCharsPerPage
                    : 0;
                blockers.push(`Question paper is a scanned bitmap (scanned or image-only) without an extractable digital text layer (average ${avgChars} chars/page across ${totalP} pages). An OCR pipeline is required.`);
            } else if (!Array.isArray(questionPaperExtraction.questions) || questionPaperExtraction.questions.length === 0) {
                blockers.push("Question paper contains zero parsed questions.");
            }

            if (questionPaperExtraction.warnings && questionPaperExtraction.warnings.length > 0) {
                warnings.push(...questionPaperExtraction.warnings);
            }
        }

        // 2. Answer Key Ingestion Checks
        if (!answerKeyExtraction) {
            blockers.push("Answer Key extraction is missing.");
        } else {
            if (!Array.isArray(answerKeyExtraction.answers) || answerKeyExtraction.answers.length === 0) {
                blockers.push("Answer key contains zero parsed answers.");
            }

            if (answerKeyExtraction.duplicates && answerKeyExtraction.duplicates.length > 0) {
                warnings.push(`Answer key contains ${answerKeyExtraction.duplicates.length} duplicate question entries.`);
            }

            if (answerKeyExtraction.warnings && answerKeyExtraction.warnings.length > 0) {
                warnings.push(...answerKeyExtraction.warnings);
            }
        }

        // 3. Paper Format Ingestion Checks
        if (!paperFormatExtraction) {
            blockers.push("Paper Format extraction is missing.");
        } else {
            // Check for internal contradictions
            if (paperFormatExtraction.totalQuestions?.status === ExtractionStatus.CONTRADICTORY) {
                blockers.push(`Paper format contains contradictory total question counts: ${paperFormatExtraction.totalQuestions.evidenceText}`);
            }

            // Check for non-finite marking values (NaN, Infinity)
            if (paperFormatExtraction.markingRules) {
                for (const [key, field] of Object.entries(paperFormatExtraction.markingRules)) {
                    if (field && field.value !== null && field.value !== undefined) {
                        if (typeof field.value === "number" && !Number.isFinite(field.value)) {
                            blockers.push(`Non-finite numeric value detected in marking rule '${key}': ${field.value}`);
                        }
                    }
                }
            }

            // Flag missing rules as warnings for the ingestion phase (reconciliation in Phase 4 elevates to blockers if needed)
            if (paperFormatExtraction.markingRules?.negativeMarks?.status === ExtractionStatus.UNKNOWN) {
                warnings.push("Paper format does not declare negative marking rules (marked UNKNOWN).");
            }
            if (paperFormatExtraction.durationSeconds?.status === ExtractionStatus.UNKNOWN) {
                warnings.push("Paper format does not declare examination duration (marked UNKNOWN).");
            }
        }

        // 4. Cross-Document Reconciliation Checks
        const qpCount = Array.isArray(questionPaperExtraction?.questions) ? questionPaperExtraction.questions.length : 0;
        const akCount = Array.isArray(answerKeyExtraction?.answers) ? answerKeyExtraction.answers.length : 0;
        const formatTotal = (paperFormatExtraction?.totalQuestions?.value && Number.isInteger(paperFormatExtraction.totalQuestions.value))
            ? paperFormatExtraction.totalQuestions.value
            : null;

        // 4.1 Answer Key coverage check
        if (qpCount > 0) {
            if (akCount === 0) {
                if (!blockers.some(b => b.includes("zero parsed answers"))) {
                    blockers.push("Answer key contains zero parsed answers (0% coverage of Question Paper).");
                }
            } else {
                const coverage = akCount / qpCount;
                if (coverage < 0.50) {
                    blockers.push(`Answer key coverage is critical: parsed ${akCount} answers for ${qpCount} questions (${Math.round(coverage * 100)}% coverage, minimum required is 50%).`);
                }
            }
        }

        // 4.2 Cross-Document Question Count Comparison
        // QP vs AK
        if (qpCount > 0 && akCount > 0) {
            const diff = Math.abs(qpCount - akCount);
            const maxVal = Math.max(qpCount, akCount);
            const discrepancyRatio = diff / maxVal;

            if (discrepancyRatio > 0.10) {
                blockers.push(`Fatal cross-document count mismatch (>10% discrepancy): Question Paper has ${qpCount} questions, but Answer Key has ${akCount} answers (${Math.round(discrepancyRatio * 100)}% discrepancy).`);
            } else if (diff > 0) {
                warnings.push(`Mild question count discrepancy (<=10%): Question Paper has ${qpCount} questions vs Answer Key has ${akCount} answers.`);
            }
        }

        // QP vs Format Total
        if (qpCount > 0 && formatTotal !== null && formatTotal > 0) {
            const diff = Math.abs(qpCount - formatTotal);
            const maxVal = Math.max(qpCount, formatTotal);
            const discrepancyRatio = diff / maxVal;

            if (discrepancyRatio > 0.10) {
                blockers.push(`Fatal cross-document count mismatch (>10% discrepancy): Question Paper has ${qpCount} questions, but Paper Format specifies ${formatTotal} questions (${Math.round(discrepancyRatio * 100)}% discrepancy).`);
            } else if (diff > 0) {
                warnings.push(`Mild question count discrepancy (<=10%): Question Paper has ${qpCount} questions vs Paper Format specifies ${formatTotal} questions.`);
            }
        }

        // AK vs Format Total
        if (akCount > 0 && formatTotal !== null && formatTotal > 0) {
            const diff = Math.abs(akCount - formatTotal);
            const maxVal = Math.max(akCount, formatTotal);
            const discrepancyRatio = diff / maxVal;

            if (discrepancyRatio > 0.10) {
                blockers.push(`Fatal cross-document count mismatch (>10% discrepancy): Answer Key has ${akCount} answers, but Paper Format specifies ${formatTotal} questions (${Math.round(discrepancyRatio * 100)}% discrepancy).`);
            }
        }

        return {
            isValid: blockers.length === 0,
            blockers,
            warnings
        };
    }

    /**
     * Strict publication readiness validation gate (Phase 2.3)
     * Evaluates whether ingested multi-document data meets 100% publication integrity standards.
     * 
     * @param {object} param0
     * @param {object} param0.questionPaperExtraction
     * @param {object} param0.answerKeyExtraction
     * @param {object} param0.paperFormatExtraction
     * @param {object} [param0.options]
     * @returns {{ isApproved: boolean, publicationBlockers: string[], publicationWarnings: string[], overridesApplied: object[] }}
     */
    static validatePublication({ questionPaperExtraction, answerKeyExtraction, paperFormatExtraction, options = {} }) {
        const rawBlockers = [];
        const publicationWarnings = [];
        const overridesApplied = [];

        // 1. Completeness of Required Extractions
        if (!questionPaperExtraction) {
            rawBlockers.push("[Strict Publication Gate] Question Paper extraction is completely missing.");
        }
        if (!answerKeyExtraction) {
            rawBlockers.push("[Strict Publication Gate] Answer Key extraction is completely missing.");
        }
        if (!paperFormatExtraction) {
            rawBlockers.push("[Strict Publication Gate] Paper Format extraction is completely missing.");
        }

        if (rawBlockers.length > 0) {
            return {
                isApproved: false,
                publicationBlockers: rawBlockers,
                publicationWarnings,
                overridesApplied
            };
        }

        const questions = Array.isArray(questionPaperExtraction.questions) ? questionPaperExtraction.questions : [];
        const answers = Array.isArray(answerKeyExtraction.answers) ? answerKeyExtraction.answers : [];
        const formatTotal = (paperFormatExtraction.totalQuestions?.value && Number.isInteger(paperFormatExtraction.totalQuestions.value))
            ? paperFormatExtraction.totalQuestions.value
            : null;

        const qpCount = questions.length;
        const akCount = answers.length;

        // 2. Exact Question Count Reconciliation (0 tolerance)
        if (questionPaperExtraction.isScanned && !questionPaperExtraction.ocrManifest) {
            const totalP = questionPaperExtraction.scanDetection?.totalPages || "multiple";
            const avgChars = questionPaperExtraction.scanDetection?.averageCharsPerPage !== undefined
                ? questionPaperExtraction.scanDetection.averageCharsPerPage
                : 0;
            rawBlockers.push(`[Strict Publication Gate] Question paper is a scanned bitmap without an extractable digital text layer (average ${avgChars} chars/page across ${totalP} pages). OCR pipeline required.`);
        } else if (qpCount === 0) {
            rawBlockers.push("[Strict Publication Gate] Question Paper contains zero parsed questions.");
        }
        if (akCount === 0) {
            rawBlockers.push("[Strict Publication Gate] Answer Key contains zero parsed answers.");
        }

        // 2.1 OCR Quality Gate (Phase 4.4)
        if (questionPaperExtraction.isScanned && questionPaperExtraction.ocrManifest) {
            const manifest = questionPaperExtraction.ocrManifest;
            if (manifest.averageConfidence < 65) {
                rawBlockers.push(`[Strict Publication Gate] Scanned document OCR average confidence (${manifest.averageConfidence}%) is below minimum quality threshold (65%).`);
            }
            if (manifest.requiresAdminReview && !options.manualVerification) {
                rawBlockers.push("[Strict Publication Gate] Scanned examination documents require completed administrative review and verification prior to publication.");
            }
        }

        if (qpCount > 0 && akCount > 0 && qpCount !== akCount) {
            rawBlockers.push(`[Strict Publication Gate] Question Paper question count (${qpCount}) does not match Answer Key count (${akCount}) exactly (0 tolerance).`);
        }

        if (formatTotal !== null && formatTotal > 0) {
            if (qpCount > 0 && qpCount !== formatTotal) {
                rawBlockers.push(`[Strict Publication Gate] Question Paper question count (${qpCount}) does not match Paper Format declared total (${formatTotal}) exactly (0 tolerance).`);
            }
            if (akCount > 0 && akCount !== formatTotal) {
                rawBlockers.push(`[Strict Publication Gate] Answer Key count (${akCount}) does not match Paper Format declared total (${formatTotal}) exactly (0 tolerance).`);
            }
        }

        // 3. 100% Answer Mapping
        const answerMap = new Map();
        for (const ans of answers) {
            answerMap.set(ans.questionNumber, ans);
        }

        for (const q of questions) {
            if (!answerMap.has(q.questionNumber)) {
                rawBlockers.push(`[Strict Publication Gate] Question ${q.questionNumber} has no corresponding answer in Answer Key.`);
            }
        }

        // 4. Explicit Drop/Bonus Classification
        for (const ans of answers) {
            const isDropped = ans.isDropped || ans.correctOption === "X" || /dropped/i.test(ans.rationale || "");
            const isBonus = ans.isBonus || ans.correctOption === "BONUS" || /bonus/i.test(ans.rationale || "");

            if (isDropped || isBonus) {
                if (!ans.rationale) {
                    publicationWarnings.push(`[Publication Warning] Question ${ans.questionNumber} is marked as ${isDropped ? "DROPPED" : "BONUS"} without an explicit published rationale.`);
                }
            } else {
                const hasAnswer = (Array.isArray(ans.acceptedAnswers) && ans.acceptedAnswers.length > 0)
                    || ans.numericValue !== null
                    || (ans.provenance && ans.provenance.value !== null && ans.provenance.value !== undefined)
                    || (typeof ans.correctOption === "string" && ans.correctOption.trim().length > 0);

                if (!hasAnswer) {
                    rawBlockers.push(`[Strict Publication Gate] Answer for question ${ans.questionNumber} in Answer Key has an empty or unresolved correctOption without explicit DROPPED or BONUS classification.`);
                }
            }
        }

        // 5. Scoring Rules Completeness & Validity
        const durationSec = paperFormatExtraction.durationSeconds?.value;
        if (paperFormatExtraction.durationSeconds?.status === ExtractionStatus.UNKNOWN || durationSec === null || durationSec === undefined) {
            rawBlockers.push("[Strict Publication Gate] Examination duration is unresolved (marked UNKNOWN).");
        } else if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0) {
            rawBlockers.push(`[Strict Publication Gate] Examination duration must be a positive finite number, got: ${durationSec}`);
        }

        const maxMarks = paperFormatExtraction.maximumMarks?.value;
        if (paperFormatExtraction.maximumMarks?.status === ExtractionStatus.UNKNOWN || maxMarks === null || maxMarks === undefined) {
            rawBlockers.push("[Strict Publication Gate] Maximum marks are unresolved (marked UNKNOWN).");
        } else if (typeof maxMarks !== "number" || !Number.isFinite(maxMarks) || maxMarks <= 0) {
            rawBlockers.push(`[Strict Publication Gate] Maximum marks must be a positive finite number, got: ${maxMarks}`);
        }

        const posMarks = paperFormatExtraction.markingRules?.positiveMarks?.value;
        if (paperFormatExtraction.markingRules?.positiveMarks?.status === ExtractionStatus.UNKNOWN || posMarks === null || posMarks === undefined) {
            rawBlockers.push("[Strict Publication Gate] Positive marks per question are unresolved (marked UNKNOWN).");
        } else if (typeof posMarks !== "number" || !Number.isFinite(posMarks) || posMarks <= 0) {
            rawBlockers.push(`[Strict Publication Gate] Positive marks must be a positive finite number, got: ${posMarks}`);
        }

        const negMarks = paperFormatExtraction.markingRules?.negativeMarks?.value;
        if (paperFormatExtraction.markingRules?.negativeMarks?.status === ExtractionStatus.UNKNOWN || negMarks === null || negMarks === undefined) {
            rawBlockers.push("[Strict Publication Gate] Negative marking rule is unresolved (marked UNKNOWN).");
        } else if (typeof negMarks !== "number" || !Number.isFinite(negMarks)) {
            rawBlockers.push(`[Strict Publication Gate] Negative marks penalty must be a finite number, got: ${negMarks}`);
        }

        // 6. Option Integrity & Question Resolution
        for (const q of questions) {
            if (q.isUnreadable) {
                rawBlockers.push(`[Strict Publication Gate] Question ${q.questionNumber} is flagged unreadable: ${q.unreadableReason}`);
            }

            if (q.questionType === UniversalQuestionType.SINGLE_CHOICE_MCQ) {
                if (!Array.isArray(q.options) || q.options.length < 2) {
                    rawBlockers.push(`[Strict Publication Gate] Single-choice MCQ question ${q.questionNumber} has insufficient options (${q.options?.length || 0} options; minimum required is 2).`);
                } else {
                    const seenTexts = new Set();
                    for (const opt of q.options) {
                        const trimmed = (opt.text || "").trim();
                        if (trimmed.length > 0 && seenTexts.has(trimmed)) {
                            rawBlockers.push(`[Strict Publication Gate] Question ${q.questionNumber} has duplicate option content: "${trimmed}".`);
                        }
                        if (trimmed.length > 0) seenTexts.add(trimmed);
                    }
                }
            }

            // 7. Missing Diagram Gate
            const stemText = q.stem?.text || "";
            const referencesDiagram = /(?:(?:refer\s+to\s+)?\b(?:Figure|Fig\b\.?|Diagram|Graph)\b\s*([0-9A-Z]+)?|in\s+the\s+diagram\s+below|shown\s+in\s+the\s+(?:figure|graph)|graph\s+is\s+(?:plotted|pletted)\s+as\s+shown)/i.test(stemText);
            if (referencesDiagram) {
                const qDiagrams = q.stem?.diagrams || q.diagrams;
                if (!q.hasDiagram || !Array.isArray(qDiagrams) || qDiagrams.length === 0) {
                    rawBlockers.push(`[Strict Publication Gate] Question ${q.questionNumber} references an external figure/diagram in its stem, but no diagram was resolved or extracted.`);
                }
            }
        }

        // 8. Administrative Overrides Audit Trail
        let publicationBlockers = [...rawBlockers];
        const overrides = Array.isArray(options.administrativeOverrides)
            ? options.administrativeOverrides
            : (options.administrativeOverrides ? [options.administrativeOverrides] : []);

        for (const override of overrides) {
            const { approvedBy, approvedAt, rationale, overrideExceptions } = override;
            if (approvedBy && approvedAt && Array.isArray(overrideExceptions) && overrideExceptions.length > 0) {
                publicationBlockers = publicationBlockers.filter(b => {
                    const isOverridden = overrideExceptions.some(exc => b.toLowerCase().includes(exc.toLowerCase()));
                    if (isOverridden) {
                        overridesApplied.push({
                            blocker: b,
                            approvedBy,
                            approvedAt,
                            rationale: rationale || "Administrative override granted."
                        });
                        return false;
                    }
                    return true;
                });
            }
        }

        // Publication Status Decision (Phase 4.5.2)
        // BLOCKED: Fatal structural discrepancies exist (missing questions, count mismatch, unmapped keys)
        // READY_FOR_APPROVAL: Fully verified package, but awaiting administrative sign-off on scanned paper
        // APPROVED: Formally authorized for student publication
        let publicationStatus = "BLOCKED";
        if (publicationBlockers.length === 0) {
            publicationStatus = "APPROVED";
        } else if (publicationBlockers.every(b => b.includes("administrative review and verification") || b.includes("manual inspection") || b.includes("preview"))) {
            publicationStatus = "READY_FOR_APPROVAL";
        } else {
            publicationStatus = "BLOCKED";
        }

        return {
            publicationStatus,
            isApproved: publicationStatus === "APPROVED",
            canPublish: publicationStatus === "APPROVED",
            publicationBlockers,
            publicationWarnings,
            overridesApplied
        };
    }
}

