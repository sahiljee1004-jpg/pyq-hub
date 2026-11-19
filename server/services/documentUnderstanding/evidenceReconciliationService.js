import { GroqReasoningProvider } from "./groqReasoningProvider.js";

/**
 * Universal Evidence Reconciliation Service
 * 
 * Reconciles evidence across the Question Paper, Answer Key, and Exam Pattern.
 * Leverages Groq GPT-OSS 120B (`openai/gpt-oss-120b`) for deep semantic synthesis,
 * with robust deterministic rule-based evaluation.
 */
export class EvidenceReconciliationService {

    /**
     * Macro-level cross-document verification across Question Paper, Answer Key, and Paper Format
     * 
     * @param {object} params
     * @param {object} params.questionPaperExtraction
     * @param {object} params.answerKeyExtraction
     * @param {object} params.paperFormatExtraction
     * @param {object} [options]
     * @returns {Promise<object>} Verification report
     */
    static async crossVerifyThreeDocuments({
        questionPaperExtraction,
        answerKeyExtraction,
        paperFormatExtraction,
        options = {}
    }) {
        const qp = questionPaperExtraction || { questions: [], sections: [] };
        const ak = answerKeyExtraction || { answers: [] };
        const pf = paperFormatExtraction || {};

        const qpCount = (qp.questions || []).length;
        const akCount = (ak.answers || []).length;
        const pfCount = pf.totalQuestions?.value ?? null;

        const qpSections = (qp.sections || []).map(s => s.sectionName || s.sectionId);
        const pfSections = (pf.sections || []).map(s => s.name || s.sectionName || s.id);

        const akBookletCode = ak.header?.paperCode?.value || ak.paperCode || null;
        const pfBookletCode = pf.header?.paperCode?.value || pf.paperCode?.value || null;
        const qpBookletCode = qp.header?.paperCode?.value || qp.detectedBookletCode || null;

        // 1. Deterministic evaluations
        const discrepancies = [];

        // Question count matching
        const questionCountMatched = (qpCount > 0 && akCount > 0) ? (qpCount === akCount) : false;
        if (!questionCountMatched) {
            discrepancies.push(`Question count mismatch: Question Paper has ${qpCount}, Answer Key has ${akCount}, Pattern declares ${pfCount || "unspecified"}.`);
        }

        // Section distribution check
        let sectionDistributionMatched = true;
        if (pfSections.length > 0 && qpSections.length > 0) {
            const pfNames = new Set(pfSections.map(s => s.toLowerCase().trim()));
            const matchCount = qpSections.filter(s => pfNames.has(s.toLowerCase().trim())).length;
            sectionDistributionMatched = matchCount >= Math.floor(pfSections.length * 0.7);
            if (!sectionDistributionMatched) {
                discrepancies.push(`Section mismatch: QP detected ${qpSections.length} sections, Pattern declared ${pfSections.length}.`);
            }
        }

        // Booklet code matching
        let bookletCodeConfirmed = true;
        let agreedBookletCode = akBookletCode || pfBookletCode || qpBookletCode;
        if (akBookletCode && pfBookletCode && akBookletCode.toLowerCase() !== pfBookletCode.toLowerCase()) {
            bookletCodeConfirmed = false;
            discrepancies.push(`Booklet code conflict: Answer Key specifies '${akBookletCode}', Pattern specifies '${pfBookletCode}'.`);
        }

        // Marking rules
        const posMarks = pf.markingRules?.positiveMarks?.value ?? 1;
        const negMarks = pf.markingRules?.negativeMarks?.value ?? 0;
        const unansMarks = pf.markingRules?.unansweredMarks?.value ?? 0;
        const markingRulesMatched = Number.isFinite(posMarks) && Number.isFinite(negMarks);

        // Deterministic baseline result
        const baselineResult = {
            isConsistent: discrepancies.length === 0,
            questionCountMatched,
            sectionDistributionMatched,
            markingRulesMatched,
            bookletCodeConfirmed,
            bookletCode: agreedBookletCode,
            discrepancies,
            counts: {
                questionPaper: qpCount,
                answerKey: akCount,
                paperFormat: pfCount
            },
            markingRules: {
                positiveMarks: posMarks,
                negativeMarks: negMarks,
                unansweredMarks: unansMarks
            },
            reconciliationRationale: discrepancies.length === 0
                ? "All three documents are fully consistent across question count, sections, and marking rules."
                : `Discrepancies identified: ${discrepancies.join("; ")}`
        };

        // If Groq Reasoning is available and requested, enrich with AI reasoning
        if (options.useAiReasoning !== false && GroqReasoningProvider.isAvailable()) {
            try {
                const aiResult = await GroqReasoningProvider.crossVerifyThreeDocuments({
                    qpSummary: {
                        totalQuestions: qpCount,
                        sections: qpSections,
                        isScanned: Boolean(qp.isScanned),
                        detectedBookletCode: qpBookletCode
                    },
                    akSummary: {
                        totalAnswers: akCount,
                        paperCode: akBookletCode,
                        droppedQuestions: (ak.answers || []).filter(a => a.isDropped || a.isBonus).map(a => a.questionNumber),
                        multiOptionQuestions: (ak.answers || []).filter(a => Array.isArray(a.acceptedAnswers) && a.acceptedAnswers.length > 1).map(a => a.questionNumber)
                    },
                    epSummary: {
                        totalQuestions: pfCount,
                        durationSeconds: pf.durationSeconds?.value || 7200,
                        maximumMarks: pf.maximumMarks?.value || (qpCount * posMarks),
                        markingRules: pf.markingRules,
                        sections: pfSections,
                        paperCode: pfBookletCode
                    },
                    useCache: options.useCache !== false
                });

                if (aiResult && aiResult.result) {
                    return {
                        ...baselineResult,
                        aiVerified: true,
                        aiModel: GroqReasoningProvider.getModel(),
                        aiDiscrepancies: aiResult.result.discrepancies || [],
                        reconciliationRationale: aiResult.result.reconciliationRationale || baselineResult.reconciliationRationale
                    };
                }
            } catch (err) {
                console.warn("[EvidenceReconciliationService] AI cross-verification fallback to deterministic:", err.message);
            }
        }

        return baselineResult;
    }

    /**
     * Reconcile an individual question between OCR, Vision, and Answer Key
     * 
     * @param {object} params
     * @param {number} params.questionNumber
     * @param {object} params.ocrQuestion
     * @param {object} params.visionQuestion
     * @param {object} params.answerKeyEntry
     * @param {object} [params.examPatternRules]
     * @param {object} [options]
     * @returns {Promise<object>} Reconciled question verification result
     */
    static async reconcileQuestion({
        questionNumber,
        ocrQuestion,
        visionQuestion,
        answerKeyEntry,
        examPatternRules,
        options = {}
    }) {
        const ocrOpts = ocrQuestion?.options || [];
        const visOpts = visionQuestion?.options || [];
        const acceptedAnswers = answerKeyEntry?.acceptedAnswers || [];
        const isDropped = Boolean(answerKeyEntry?.isDropped || answerKeyEntry?.isBonus);

        // Option evaluation
        const bestOptions = (visOpts.length === 4) ? visOpts : (ocrOpts.length === 4 ? ocrOpts : (visOpts.length > ocrOpts.length ? visOpts : ocrOpts));
        const hasFourCleanOptions = bestOptions.length === 4;

        // Stem evaluation: choose cleaner, longer stem without solution contamination
        let bestStem = (visionQuestion?.questionText || ocrQuestion?.questionText || "").trim();
        if (visionQuestion?.questionText && ocrQuestion?.questionText) {
            // Prefer vision stem if it contains LaTeX formulas
            if (/\$|\\frac|\\sqrt/.test(visionQuestion.questionText)) {
                bestStem = visionQuestion.questionText;
            }
        }

        // Answer Key correspondence (supports both letter A-D and numeric 1-4 canonical mappings)
        let answerKeyMatched = false;
        if (isDropped) {
            answerKeyMatched = true;
        } else if (acceptedAnswers.length > 0) {
            const availableOptionIds = new Set();
            for (const o of bestOptions) {
                if (o && o.id) {
                    availableOptionIds.add(String(o.id).trim().toUpperCase());
                    if (/^[1-4]$/.test(o.id)) {
                        availableOptionIds.add(String.fromCharCode(64 + parseInt(o.id, 10)));
                    } else if (/^[A-D]$/i.test(o.id)) {
                        availableOptionIds.add(String(o.id.toUpperCase().charCodeAt(0) - 64));
                    }
                }
            }
            answerKeyMatched = acceptedAnswers.some(ans => {
                const normAns = String(ans).trim().toUpperCase();
                if (availableOptionIds.has(normAns)) return true;
                if (/^[1-4]$/.test(normAns) && availableOptionIds.has(String.fromCharCode(64 + parseInt(normAns, 10)))) return true;
                if (/^[A-D]$/i.test(normAns) && availableOptionIds.has(String(normAns.charCodeAt(0) - 64))) return true;
                return false;
            });
        }

        // Evidence-based Verification Evaluation (Phase 4.5.2)
        // A question can be automatically verified when:
        // 1. Stem is non-empty, readable (>= 15 chars), without solution contamination
        // 2. Options are reconstructed accurately with 4 distinct choices (or dropped/bonus)
        // 3. Mathematical notation is preserved (balanced LaTeX delimiters)
        // 4. Question type and section are assigned
        // 5. Answer key correspondence is valid
        // 6. Any associated diagram or table is preserved (not UNRESOLVED_DIAGRAM)
        // 7. No unresolved cross-document conflicts exist
        const stemReadable = bestStem.length >= 15;
        const stemSupported = stemReadable && !bestStem.includes("Ans.") && !bestStem.includes("Sol.");

        // Preserve case-sensitive scientific/mathematical notation (e.g. M vs m, V vs v)
        const uniqueOptionTexts = new Set(bestOptions.map(o => (o.text || "").trim()));
        const optionsAccurate = (hasFourCleanOptions && uniqueOptionTexts.size === 4) || isDropped;

        const mathDelimitersCount = (bestStem.match(/(?<!\\)\$/g) || []).length;
        const mathPreserved = mathDelimitersCount % 2 === 0;

        const resolvedQuestionType = visionQuestion?.questionType || ocrQuestion?.questionType || "single_choice_mcq";
        const resolvedSectionId = visionQuestion?.sectionId || ocrQuestion?.sectionId || "sec_default";
        const sectionAndTypeValid = Boolean(resolvedQuestionType && resolvedSectionId);

        const answerKeyValid = answerKeyMatched;

        // Diagram preservation check
        let diagramPreserved = true;
        const linkedDiagram = visionQuestion?.diagram || ocrQuestion?.diagram;
        if (linkedDiagram) {
            if (linkedDiagram.diagramStatus === "UNRESOLVED_DIAGRAM" || linkedDiagram.isVerified === false) {
                diagramPreserved = false;
            }
        }

        const noConflicts = !options.hasContradiction;

        const reviewReasons = [];
        if (!stemSupported) {
            reviewReasons.push(stemReadable ? "Question stem contains residual solution derivation text" : "Question stem is truncated or unreadable (< 15 characters)");
        }
        if (!optionsAccurate && !isDropped) {
            reviewReasons.push(hasFourCleanOptions ? "Duplicate option choices detected" : `Expected 4 options, found ${bestOptions.length}`);
        }
        if (!mathPreserved) {
            reviewReasons.push("Unbalanced mathematical delimiters in question stem");
        }
        if (!answerKeyValid && !isDropped) {
            reviewReasons.push(`Accepted answer ${JSON.stringify(acceptedAnswers)} not present in reconstructed options`);
        }
        if (!diagramPreserved) {
            reviewReasons.push(`Associated diagram requires manual review: ${linkedDiagram?.reason || "Unresolved spatial boundaries"}`);
        }

        const allEvidenceVerified = stemSupported && optionsAccurate && mathPreserved && sectionAndTypeValid && answerKeyValid && diagramPreserved && noConflicts;

        let verificationStatus = "NEEDS_REVIEW";
        if (allEvidenceVerified) {
            verificationStatus = "VERIFIED";
        } else if (!stemReadable && bestOptions.length === 0) {
            verificationStatus = "FAILED";
        }

        const confidence = visionQuestion?.confidenceBreakdown?.overallConfidence 
            || ocrQuestion?.provenance?.confidence 
            || (hasFourCleanOptions && stemReadable ? 0.95 : 0.70);

        return {
            questionNumber,
            verificationStatus,
            autoVerified: verificationStatus === "VERIFIED",
            confidence,
            evidenceChecklist: {
                stemSupported,
                optionsAccurate,
                mathPreserved,
                sectionAndTypeValid,
                answerKeyValid,
                diagramPreserved,
                noConflicts
            },
            reviewReasons,
            reconciledStem: bestStem,
            options: bestOptions,
            acceptedAnswers,
            isDropped,
            hasDiagram: Boolean(linkedDiagram),
            diagram: linkedDiagram
        };
    }

    /**
     * Batch reconcile a full set of questions
     */
    static async reconcileAllQuestions({
        questions = [],
        answerKey = {},
        examPattern = {},
        options = {}
    }) {
        const akMap = new Map();
        for (const ans of (answerKey.answers || [])) {
            if (ans.questionNumber) {
                akMap.set(ans.questionNumber, ans);
            }
        }

        const reconciled = [];
        let verifiedCount = 0;
        let needsReviewCount = 0;

        for (const q of questions) {
            const akEntry = akMap.get(q.questionNumber);
            const rec = await this.reconcileQuestion({
                questionNumber: q.questionNumber,
                ocrQuestion: q.provenance?.extractionMethod?.includes("ocr") ? q : null,
                visionQuestion: q,
                answerKeyEntry: akEntry,
                examPatternRules: examPattern.markingRules,
                options
            });

            if (rec.autoVerified) {
                verifiedCount++;
            } else {
                needsReviewCount++;
            }

            reconciled.push({
                ...q,
                verificationStatus: rec.verificationStatus,
                autoVerified: rec.autoVerified,
                reviewReasons: rec.reviewReasons
            });
        }

        const verificationRate = questions.length > 0 ? (verifiedCount / questions.length) : 0;

        return {
            totalQuestions: questions.length,
            verifiedCount,
            needsReviewCount,
            verificationRate: Math.round(verificationRate * 100) / 100,
            reconciledQuestions: reconciled
        };
    }
}
