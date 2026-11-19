import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

/**
 * Answer Key Reconciliation Service
 * 
 * Extracts and reconciles official answer keys with extracted questions.
 * Handles tabular grids, numerical answers, multi-column tables, dropped questions,
 * and enforces the Mandatory Scored-Test Gate.
 */
export class AnswerKeyReconciliationService {

    /**
     * Parse official answer key text/PDF into a structured map: QuestionNumber -> AnswerData
     */
    static async parseAnswerKeyDocument(pdfBuffer, options = {}) {
        if (!Buffer.isBuffer(pdfBuffer)) {
            throw new Error("Invalid Answer Key PDF buffer provided");
        }

        let fullText = "";
        try {
            let timer;
            const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Answer key PDF parsing timed out (exceeded 25s)")), 25000);
            });
            const cleanBuffer = new Uint8Array(pdfBuffer);
            const parseOptions = {
                version: "v2.0.550",
                pagerender: (pageData) => {
                    return pageData.getTextContent().then((tc) => {
                        // Group items into horizontal lines with spatial spacing
                        const lines = [];
                        const sorted = [...tc.items].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
                        let curLine = [];
                        let curY = null;
                        for (const it of sorted) {
                            if (curY === null || Math.abs(curY - it.transform[5]) <= 3) {
                                curLine.push(it);
                                if (curY === null) curY = it.transform[5];
                            } else {
                                curLine.sort((a, b) => a.transform[4] - b.transform[4]);
                                lines.push(curLine);
                                curLine = [it];
                                curY = it.transform[5];
                            }
                        }
                        if (curLine.length) {
                            curLine.sort((a, b) => a.transform[4] - b.transform[4]);
                            lines.push(curLine);
                        }
                        return lines.map(line => {
                            let lineStr = "";
                            let lastX = null;
                            for (const it of line) {
                                if (!it.str) continue;
                                if (lastX !== null && (it.transform[4] - lastX) > 2.5 && !lineStr.endsWith(" ") && !it.str.startsWith(" ")) {
                                    lineStr += " ";
                                }
                                lineStr += it.str;
                                lastX = it.transform[4] + (it.width || 0);
                            }
                            return lineStr;
                        }).join("\n");
                    });
                }
            };

            const parsed = await Promise.race([pdfParse(cleanBuffer, parseOptions), timeoutPromise]).finally(() => clearTimeout(timer));
            if (parsed.numpages > 100) {
                throw new Error(`Answer key PDF exceeds maximum supported limit of 100 pages (detected ${parsed.numpages})`);
            }
            fullText = parsed.text || "";
        } catch (err) {
            console.warn("[AnswerKeyReconciliationService] PDF parse error:", err.message);
            if (err.message.includes("exceeds maximum supported limit") || err.message.includes("timed out")) {
                throw err;
            }
        }

        const answerMap = new Map();
        const lines = fullText.split(/\r?\n/);

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("*") || /^Q\s*Ans/i.test(trimmed) || /Answer Key|COMPLETE SHIFT|PYQ/i.test(trimmed)) {
                continue;
            }
            if (/Scoring Key Instructions|Civil Services|Test Booklet|Maximum Marks/i.test(trimmed)) {
                continue;
            }

            // Strategy 1: Multi-column token list: "1  C  2  C  3  B..." or "1 (d) 11 (d)..." or "21  1  22  2  23  225..."
            const tokens = trimmed.split(/\s+/);
            const isMultiColumnTable = tokens.length >= 4 &&
                !isNaN(parseInt(tokens[0], 10)) &&
                !isNaN(parseInt(tokens[2], 10)) &&
                !/\b(?:or|and|dropped|bonus)\b/i.test(trimmed) &&
                !trimmed.includes(",");

            if (isMultiColumnTable) {
                let i = 0;
                while (i < tokens.length - 1) {
                    const qNum = parseInt(tokens[i], 10);
                    if (!isNaN(qNum) && qNum > 0 && qNum <= 300) {
                        let rawToken = tokens[i + 1].replace(/\*+$/, "").trim();
                        // Strip enclosing parentheses: e.g. (d) -> d, [B] -> B
                        const parenMatch = /^[\(\[]?([a-dA-D1-4])[\)\]]?$/.exec(rawToken);
                        if (parenMatch) {
                            rawToken = parenMatch[1];
                        }
                        // Validate that rawToken looks like an answer (letter, number, drop/bonus)
                        if (rawToken && (!isNaN(parseInt(rawToken, 10)) || /^[A-D]$/i.test(rawToken) || /Drop|Bonus/i.test(rawToken))) {
                            const parsedAns = this.normalizeRawAnswer(rawToken);
                            answerMap.set(qNum, parsedAns);
                            i += 2;
                            continue;
                        }
                    }
                    i++;
                }
            }

            // Strategy 1B: Dense or parenthesized multi-column pairs: e.g. "1(d)11(d)21(b)31(a)41(c)" or "1 (d) 11 (d)"
            const parenPairs = [...trimmed.matchAll(/(?:^|\b|\s)(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[\(\[]([a-dA-D1-4])[\)\]]/gi)];
            if (parenPairs.length >= 2) {
                for (const pp of parenPairs) {
                    const qNum = parseInt(pp[1], 10);
                    if (qNum > 0 && qNum <= 300 && !answerMap.has(qNum)) {
                        const parsedAns = this.normalizeRawAnswer(pp[2]);
                        answerMap.set(qNum, parsedAns);
                    }
                }
            }

            // Strategy 2: Standard single/tabular row: "14  3" or "Q.14  A" or "14 (d)" or "14. Drop"
            const rowMatch = trimmed.match(/(?:^|\b)(?:Q(?:uestion)?\.?\s*)?(\d{1,3})[\s:\.\-\t]+(?:Option\s*)?[\(\[]?([1-4A-D](?:\s*(?:or|,|\/)\s*[1-4A-D])?|Drop(?:ped)?|Bonus|\d+(?:\.\d+)?)[\)\]]?\*?(?=\s|$)/i);
            if (rowMatch) {
                const qNum = parseInt(rowMatch[1], 10);
                if (qNum > 0 && qNum <= 300 && !answerMap.has(qNum)) {
                    const rawAns = rowMatch[2].trim();
                    const parsedAns = this.normalizeRawAnswer(rawAns);
                    answerMap.set(qNum, parsedAns);
                }
            }

            // Strategy 3: Dense unspaced row: "1C2C3B4A5D"
            if (!tokens.some(t => !isNaN(parseInt(t, 10)))) {
                const denseRegex = /(\d{1,3})([A-D]|Drop(?:ped)?|Bonus)\*?/gi;
                let denseMatch;
                while ((denseMatch = denseRegex.exec(trimmed)) !== null) {
                    const qNum = parseInt(denseMatch[1], 10);
                    if (qNum > 0 && qNum <= 300 && !answerMap.has(qNum)) {
                        const parsedAns = this.normalizeRawAnswer(denseMatch[2]);
                        answerMap.set(qNum, parsedAns);
                    }
                }
            }
        }

        const isUnofficial = /not the official|prepared by solving|unofficial/i.test(fullText);
        const lowConfidenceQuestions = [];
        const asteriskMatch = fullText.match(/Lower confidence:\s*(?:Q\.?\s*)?([0-9,\sQ]+)/i);
        if (asteriskMatch) {
            const qMatches = asteriskMatch[1].match(/\d+/g);
            if (qMatches) {
                lowConfidenceQuestions.push(...qMatches.map(n => parseInt(n, 10)));
            }
        }

        const bookletSeriesMatch = fullText.match(/(?:Test\s+Booklet\s+Series|Booklet\s+Series|Series)\s*[:\-]?\s*(?:SET\s*)?([A-Za-z0-9]+)/i);
        const bookletCodeMatch = fullText.match(/(?:Test\s+Booklet\s+Code|Booklet\s+Code)\s*[:\-]?\s*([A-Za-z0-9\-]+)/i);
        const bookletSeries = bookletSeriesMatch ? bookletSeriesMatch[1].trim().toUpperCase() : null;
        const bookletCode = bookletCodeMatch ? bookletCodeMatch[1].trim().toUpperCase() : null;

        let isContiguousNumeric = answerMap.size > 0;
        for (let k = 1; k <= answerMap.size; k++) {
            if (!answerMap.has(k) && !answerMap.has(String(k))) {
                isContiguousNumeric = false;
                break;
            }
        }

        const keyMetadata = {
            isOfficialKey: !isUnofficial,
            provenanceNotice: isUnofficial
                ? "Unofficial Solved Key (Prepared by solving questions; verify against official NTA final key before relying on it)"
                : "Official Final Answer Key",
            disclaimer: isUnofficial ? "This key was prepared by solving questions; it is not the official NTA final key." : null,
            lowConfidenceQuestions: Array.from(new Set(lowConfidenceQuestions)),
            bookletSeries,
            bookletCode,
            isGlobalPaperSequence: Boolean(options.isGlobalPaperSequence || isContiguousNumeric)
        };

        return {
            totalParsed: answerMap.size,
            answers: answerMap,
            rawTextLength: fullText.length,
            keyMetadata
        };
    }

    /**
     * Normalize raw answer string into structured answer descriptor
     */
    static normalizeRawAnswer(rawAns) {
        let clean = String(rawAns).trim();
        clean = clean.replace(/^[\(\[]\s*|\s*[\)\]]$/g, "");
        const upper = clean.toUpperCase();

        // Dropped / Bonus
        if (upper.includes("DROP") || upper.includes("BONUS")) {
            return {
                answerType: "dropped",
                correctOptionIds: ["dropped"],
                acceptedAnswers: ["dropped"],
                isDropped: true,
                rawString: clean
            };
        }

        // Multiple accepted options (e.g. "2 or 4", "2, 4", "B or D")
        if (upper.includes("OR") || upper.includes(",") || upper.includes("/")) {
            const parts = upper.split(/\s*(?:OR|,|\/)\s*/i);
            const normalized = parts.map(p => this.letterToNumber(p.trim())).filter(Boolean);
            return {
                answerType: "multiple_choice",
                correctOptionIds: normalized,
                acceptedAnswers: normalized,
                isDropped: false,
                rawString: clean
            };
        }

        // Single letter option: "A", "B", "C", "D" or digit option "1", "2", "3", "4"
        if (/^[A-D1-4]$/i.test(upper)) {
            const single = this.letterToNumber(upper);
            return {
                answerType: "single_choice",
                correctOptionIds: [single],
                acceptedAnswers: [single],
                isDropped: false,
                rawString: clean
            };
        }

        // Numerical answer value (e.g. "225", "1333", "1080", "17", "8")
        return {
            answerType: "numerical",
            correctOptionIds: [],
            acceptedAnswers: [clean],
            isDropped: false,
            rawString: clean
        };
    }

    static letterToNumber(val) {
        if (val === "A") return "1";
        if (val === "B") return "2";
        if (val === "C") return "3";
        if (val === "D") return "4";
        return val;
    }

    /**
     * Check if two candidate answer key entries agree on accepted/correct answers
     */
    static entriesAgree(a, b) {
        if (!a || !b) return true;
        if (a === b) return true;
        if (a.rawString && b.rawString && a.rawString.trim().toUpperCase() === b.rawString.trim().toUpperCase()) {
            return true;
        }
        const aAccepted = (a.acceptedAnswers || []).map(x => String(x).trim().toUpperCase()).sort().join(",");
        const bAccepted = (b.acceptedAnswers || []).map(x => String(x).trim().toUpperCase()).sort().join(",");
        if (aAccepted.length > 0 && aAccepted === bAccepted) {
            return true;
        }
        const aOptions = (a.correctOptionIds || []).map(x => String(x).trim().toUpperCase()).sort().join(",");
        const bOptions = (b.correctOptionIds || []).map(x => String(x).trim().toUpperCase()).sort().join(",");
        return aOptions.length > 0 && aOptions === bOptions;
    }

    /**
     * Reconcile normalized questions against the parsed answer key.
     * Enforces the Mandatory Scored-Test Gate!
     */
    static reconcileAnswerKeys({ questions = [], answerMap, sourceReference = "Official Final Answer Key", keyMetadata = {} }) {
        const reconciledKeys = [];
        const missingAnswers = [];
        const conflicts = [];
        let verifiedCount = 0;

        const effectiveSource = keyMetadata.provenanceNotice || sourceReference;

        // 1. Fail-Closed Check: Deterministic uniqueness of questionId across question package
        const seenQuestionIds = new Set();
        const duplicateQuestionIds = [];
        for (const q of questions) {
            const qId = q.questionId;
            if (qId !== undefined && qId !== null && qId !== "") {
                if (seenQuestionIds.has(qId)) {
                    duplicateQuestionIds.push(qId);
                }
                seenQuestionIds.add(qId);
            }
        }
        if (duplicateQuestionIds.length > 0) {
            const uniqueDupes = [...new Set(duplicateQuestionIds)];
            conflicts.push({
                questionNumber: null,
                reason: `Duplicate questionId detected in question package: [${uniqueDupes.join(", ")}]. All question IDs must be deterministic and unique.`
            });
        }

        // 2. Fail-Closed Check: Missing section ID on numbering-restart papers & intra-section numbering collisions
        const qNumToQuestions = new Map();
        for (const q of questions) {
            const num = q.questionNumber;
            if (num !== undefined && num !== null) {
                if (!qNumToQuestions.has(num)) {
                    qNumToQuestions.set(num, []);
                }
                qNumToQuestions.get(num).push(q);
            }
        }

        for (const [num, qList] of qNumToQuestions.entries()) {
            if (qList.length > 1) {
                const hasMissingSection = qList.some(q => !q.sectionId || String(q.sectionId).trim() === "");
                if (hasMissingSection) {
                    conflicts.push({
                        questionNumber: num,
                        reason: `Question number ${num} is repeated ${qList.length} times across the paper, but one or more instances lack a required sectionId. Numbering-restart papers must provide unique section qualification for every repeated question.`
                    });
                } else {
                    const sectionIdsInNum = new Set();
                    for (const q of qList) {
                        const sId = String(q.sectionId).trim();
                        if (sectionIdsInNum.has(sId)) {
                            conflicts.push({
                                questionNumber: num,
                                reason: `Question number ${num} is duplicated within section '${sId}'. Repeated question numbers within the same section are invalid.`
                            });
                        }
                        sectionIdsInNum.add(sId);
                    }
                }
            }
        }

        // 3. DEF-M1-02: Safe sequential answer-key verification
        const isGlobalPaperSequenceDeclared = Boolean(
            keyMetadata && (
                keyMetadata.isGlobalPaperSequence === true ||
                keyMetadata.sequenceMappingMode === "global_sequential"
            )
        );

        let allowSequentialMatching = false;
        if (isGlobalPaperSequenceDeclared) {
            const totalQ = questions.length;
            let sequenceVerified = totalQ > 0;

            // Total question count and contiguous 1..totalQ keys check in answerMap
            for (let k = 1; k <= totalQ; k++) {
                if (!answerMap.has(k) && !answerMap.has(String(k))) {
                    sequenceVerified = false;
                    break;
                }
            }

            if (sequenceVerified) {
                // Check ordering:
                // Case 1: Pure global sequential ordering 1..totalQ (e.g. JEE Main, UPSC, NEET)
                let isGlobalStrictSequence = true;
                for (let idx = 0; idx < totalQ; idx++) {
                    if (Number(questions[idx].questionNumber) !== idx + 1) {
                        isGlobalStrictSequence = false;
                        break;
                    }
                }

                if (isGlobalStrictSequence) {
                    sequenceVerified = true;
                } else {
                    // Case 2: Section-based restarted numbering (e.g. SSC CGL with 1..M in grouped section blocks)
                    const hasSections = questions.every(q => q.sectionId && String(q.sectionId).trim() !== "");
                    if (hasSections) {
                        const completedSections = new Set();
                        let currentSection = null;
                        let expectedInSec = 1;
                        let isSectionRestartSequence = true;

                        for (let idx = 0; idx < totalQ; idx++) {
                            const q = questions[idx];
                            const sec = String(q.sectionId).trim();
                            const qNum = Number(q.questionNumber);

                            if (currentSection !== sec) {
                                if (completedSections.has(sec)) {
                                    isSectionRestartSequence = false;
                                    break;
                                }
                                if (currentSection !== null) {
                                    completedSections.add(currentSection);
                                }
                                currentSection = sec;
                                expectedInSec = 1;
                            }

                            if (qNum !== expectedInSec) {
                                isSectionRestartSequence = false;
                                break;
                            }
                            expectedInSec++;
                        }
                        sequenceVerified = isSectionRestartSequence;
                    } else {
                        sequenceVerified = false;
                    }
                }
            }

            if (sequenceVerified) {
                allowSequentialMatching = true;
            } else {
                conflicts.push({
                    questionNumber: null,
                    reason: "Global paper sequential matching was declared in keyMetadata, but the question sequence could not be verified (questions are shuffled, non-contiguous, unordered, or question count does not match answer key count). Sequential matching is refused."
                });
            }
        }

        for (let i = 0; i < questions.length; i++) {
            const question = questions[i];
            const qNum = question.questionNumber;
            const keyRecordId = `ak-${question.questionId}`;
            
            // DEF-M1-01 & DEF-M1-02: Multi-candidate resolution with zero cross-section fallback
            const candidateEntries = [];

            // Candidate 1: Exact questionId match
            if (question.questionId && answerMap.has(question.questionId)) {
                candidateEntries.push({ source: "questionId", entry: answerMap.get(question.questionId) });
            }

            // Candidate 2: Section-qualified match (ONLY if sectionId is present)
            if (question.sectionId) {
                const sId = String(question.sectionId).trim();
                const sIdLower = sId.toLowerCase();
                const secKeys = [
                    `${sId}_${qNum}`,
                    `${sId}_q${qNum}`,
                    `${sIdLower}_${qNum}`,
                    `${sIdLower}_q${qNum}`
                ];
                for (const sk of secKeys) {
                    if (answerMap.has(sk)) {
                        candidateEntries.push({ source: "section_qualified", entry: answerMap.get(sk) });
                        break;
                    }
                }
            }

            // Candidate 3: Sequential match (ONLY if explicitly declared and ordering verified)
            if (allowSequentialMatching) {
                const seqKey = i + 1;
                if (answerMap.has(seqKey) || answerMap.has(String(seqKey))) {
                    candidateEntries.push({
                        source: "global_sequence",
                        entry: answerMap.get(seqKey) || answerMap.get(String(seqKey))
                    });
                }
            }

            // Candidate 4: Bare numeric questionNumber match (STRICTLY FORBIDDEN when question has sectionId!)
            if (!question.sectionId) {
                if (answerMap.has(qNum) || answerMap.has(String(qNum))) {
                    candidateEntries.push({
                        source: "questionNumber",
                        entry: answerMap.get(qNum) || answerMap.get(String(qNum))
                    });
                }
            }

            let answerEntry = null;
            if (candidateEntries.length === 1) {
                answerEntry = candidateEntries[0].entry;
            } else if (candidateEntries.length > 1) {
                const firstEntry = candidateEntries[0].entry;
                const hasConflict = candidateEntries.some(c => !AnswerKeyReconciliationService.entriesAgree(c.entry, firstEntry));
                if (hasConflict) {
                    const desc = candidateEntries.map(c => `${c.source}: '${c.entry.rawString || c.entry.answerType}'`).join(" vs ");
                    conflicts.push({
                        questionNumber: qNum,
                        reason: `Ambiguous / conflicting answer key mappings for question ${qNum} (ID: ${question.questionId}): ${desc}. Multiple conflicting candidate mappings cannot be resolved automatically.`
                    });
                    answerEntry = null;
                } else {
                    // All candidates agree; take highest precedence (questionId > section_qualified > global_sequence > questionNumber)
                    answerEntry = candidateEntries[0].entry;
                }
            }

            if (!answerEntry) {
                missingAnswers.push(qNum);
                reconciledKeys.push({
                    answerKeyId: keyRecordId,
                    questionId: question.questionId,
                    questionNumber: qNum,
                    sectionId: question.sectionId || null,
                    answerType: "unresolved",
                    correctOptionIds: [],
                    acceptedAnswers: [],
                    correctAnswers: [],
                    verificationStatus: "unverified",
                    verificationMethod: "missing_from_source_key",
                    verificationSource: effectiveSource,
                    verifiedAt: null,
                    scoringRuleId: question.questionType === "numerical" ? "standard_numerical" : "standard_mcq",
                    schemaVersion: 1
                });
                continue;
            }

            // If answer key declares numerical answer and question has no options, synchronize questionType
            if (answerEntry.answerType === "numerical" && (!question.options || question.options.length === 0)) {
                question.questionType = "numerical";
                question.options = [];
            }

            const isNumerical = question.questionType === "numerical" || answerEntry.answerType === "numerical";
            const cleanRaw = (answerEntry.rawString || "").trim().replace(/\*+$/, "");
            const isLowConfidence = (keyMetadata.lowConfidenceQuestions || []).includes(qNum);

            // For MCQ questions with parsed options: verify that options exist for the declared correct answer
            if (!isNumerical && answerEntry.answerType !== "dropped" && Array.isArray(question.options) && question.options.length > 0) {
                const availableOptionIds = new Set(question.options.map(o => String(o.id)));
                const missingOptionInQuestion = answerEntry.correctOptionIds.find(id => !availableOptionIds.has(String(id)));

                if (missingOptionInQuestion) {
                    conflicts.push({
                        questionNumber: qNum,
                        reason: `Answer key declares option ${missingOptionInQuestion}, but question only has options [${Array.from(availableOptionIds).join(", ")}]`
                    });
                }
            }

            verifiedCount++;
            const answerType = isNumerical ? "numerical" : answerEntry.answerType;
            const correctOptionIds = isNumerical ? [] : (answerEntry.correctOptionIds || []);
            const acceptedAnswers = isNumerical ? [cleanRaw] : (answerEntry.acceptedAnswers || []);
            const correctAnswers = isNumerical ? [cleanRaw] : (answerEntry.correctOptionIds || answerEntry.acceptedAnswers || []);

            reconciledKeys.push({
                answerKeyId: keyRecordId,
                questionId: question.questionId,
                questionNumber: qNum,
                sectionId: question.sectionId || null,
                answerType,
                correctOptionIds,
                acceptedAnswers,
                correctAnswers,
                isDropped: answerEntry.isDropped,
                numericTolerance: isNumerical ? 0 : null,
                confidenceLevel: isLowConfidence ? "low_confidence" : "verified",
                confidenceWarning: isLowConfidence ? "Source key indicates lower confidence due to unclear source figure/expression." : null,
                explanation: `Verified against ${effectiveSource} for Question ${qNum} (${answerEntry.rawString}).`,
                verificationStatus: "verified",
                verificationMethod: keyMetadata.isOfficialKey ? "official_key_reconciled" : "unofficial_key_reconciled",
                verificationSource: effectiveSource,
                verifiedAt: new Date().toISOString(),
                scoringRuleId: isNumerical ? "standard_numerical" : "standard_mcq",
                schemaVersion: 1
            });
        }

        // Gate: Scored tests CANNOT be published if ANY scored question is unverified or conflicting
        const totalScored = questions.length;
        const matchCoveragePercent = totalScored > 0
            ? Math.round((verifiedCount / totalScored) * 1000) / 10
            : 0;

        const gatePassed = missingAnswers.length === 0 && conflicts.length === 0 && verifiedCount === totalScored;

        return {
            gatePassed,
            totalQuestions: totalScored,
            verifiedCount,
            missingAnswers,
            conflicts,
            matchCoveragePercent,
            keyMetadata,
            reconciledKeys
        };
    }
}
