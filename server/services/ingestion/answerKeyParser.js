import { createRequire } from "node:module";
import {
    createExtractionField,
    createAnswerKeyExtraction,
    ExtractionStatus,
    DocumentType,
    ExtractionMethod
} from "./extractionSchema.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

export class AnswerKeyParser {

    /**
     * Parse Answer Key from PDF buffer, text, or tabular stream
     * @param {Buffer|string|Array<{pageNumber: number, text: string}>} input
     * @param {object} options
     * @returns {Promise<object>} Extracted structured answer key
     */
    static async parse(input, options = {}) {
        let pages = [];

        if (Buffer.isBuffer(input)) {
            const isPdf = input.length >= 5 && (input.subarray(0, 5).toString("ascii") === "%PDF-" || input.subarray(0, 1024).toString("latin1").includes("%PDF-"));
            if (!isPdf) {
                input = input.toString("utf8");
            }
        }

        if (Buffer.isBuffer(input)) {
            pages = await this.extractPagesFromPdf(input);
        } else if (typeof input === "string") {
            const rawPages = input.split(/\f|\n--- Page \d+ ---\n/);
            pages = rawPages.map((text, idx) => ({ pageNumber: idx + 1, text: text.trim() }));
        } else if (Array.isArray(input)) {
            pages = input.map((p, idx) => ({ pageNumber: p.pageNumber || (idx + 1), text: String(p.text || "").trim() }));
        } else {
            throw new Error("[AnswerKeyParser] Invalid input: Expected PDF Buffer, string, or page array.");
        }

        // 1. Extract Booklet Series / Code from Header
        const headerInfo = this.extractHeaderInfo(pages);

        // 2. Parse Question -> Answer mappings across all pages
        const { answers, duplicates, anomalies, warnings } = this.extractAnswers(pages);

        if (headerInfo.paperCode?.value) {
            for (const a of answers) {
                if (!a.paperCode) a.paperCode = headerInfo.paperCode.value;
            }
        }
        if (headerInfo.paperSeries?.value) {
            for (const a of answers) {
                if (!a.paperSeries) a.paperSeries = headerInfo.paperSeries.value;
            }
        }

        return {
            header: headerInfo,
            answers,
            duplicates,
            anomalies,
            warnings,
            totalAnswers: answers.length
        };
    }

    /**
     * Extract pages from PDF buffer
     */
    static async extractPagesFromPdf(pdfBuffer) {
        if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
            throw new Error("[AnswerKeyParser] Empty or invalid PDF buffer supplied.");
        }

        const pages = [];
        try {
            const cleanBuffer = new Uint8Array(pdfBuffer);
            const options = {
                version: "v2.0.550",
                pagerender: function (pageData) {
                    return pageData.getTextContent().then(function (textContent) {
                        let text = "";
                        let lastY = null;
                        for (const item of textContent.items) {
                            if (lastY === null || Math.abs(lastY - item.transform[5]) < 4) {
                                text += item.str + " ";
                            } else {
                                text += "\n" + item.str + " ";
                            }
                            lastY = item.transform[5];
                        }
                        pages.push({
                            pageNumber: pageData.pageIndex + 1,
                            text: text.trim()
                        });
                        return text;
                    });
                }
            };

            const parsed = await pdfParse(cleanBuffer, options);
            if (pages.length === 0 && parsed.text) {
                pages.push({ pageNumber: 1, text: parsed.text.trim() });
            }
            return pages;
        } catch (err) {
            return [{ pageNumber: 1, text: "" }];
        }
    }

    /**
     * Extract Series, Code, and Key Revision metadata from headers
     */
    static extractHeaderInfo(pages) {
        const topText = pages.slice(0, 2).map(p => p.text).join("\n");
        const pageNum = pages[0]?.pageNumber || 1;

        // Series / Set
        let paperSeries = null;
        const seriesMatch = topText.match(/(?:Set|Series|Booklet\s+Series|Test\s+Booklet\s+Series)\s*[:\-]?\s*([A-Z0-9]+)/i);
        if (seriesMatch) {
            paperSeries = createExtractionField(seriesMatch[1].toUpperCase(), {
                documentId: DocumentType.ANSWER_KEY,
                pageNumber: pageNum,
                evidenceText: seriesMatch[0].trim(),
                confidence: 0.95
            });
        } else {
            paperSeries = createExtractionField(null, { documentId: DocumentType.ANSWER_KEY, status: ExtractionStatus.UNKNOWN });
        }

        // Booklet / Paper Code
        let paperCode = null;
        const codeMatch = topText.match(/(?:Booklet\s+Code|Paper\s+Code|Test\s+(?:Booklet\s+)?Code|Code)\s*[:\-]?\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/i);
        if (codeMatch) {
            paperCode = createExtractionField(codeMatch[1].toUpperCase(), {
                documentId: DocumentType.ANSWER_KEY,
                pageNumber: pageNum,
                evidenceText: codeMatch[0].trim(),
                confidence: 0.95
            });
        } else {
            paperCode = createExtractionField(null, { documentId: DocumentType.ANSWER_KEY, status: ExtractionStatus.UNKNOWN });
        }

        // Final vs Provisional Key
        const isFinal = /final\s+answer\s+key|amended\s+key|revised\s+key/i.test(topText);
        const isProvisional = /provisional\s+answer\s+key|draft\s+key/i.test(topText);
        const version = isFinal ? "final" : (isProvisional ? "provisional" : "unknown");

        return {
            paperSeries,
            paperCode,
            keyVersion: createExtractionField(version, {
                documentId: DocumentType.ANSWER_KEY,
                pageNumber: pageNum,
                evidenceText: isFinal ? "FINAL ANSWER KEY" : (isProvisional ? "PROVISIONAL ANSWER KEY" : ""),
                confidence: (isFinal || isProvisional) ? 0.95 : 0.5
            })
        };
    }

    /**
     * Parse question-to-answer mappings across all pages with multi-column support
     */
    static extractAnswers(pages) {
        const answersMap = new Map();
        const duplicates = [];
        const anomalies = [];
        const warnings = [];

        for (const page of pages) {
            const pageNum = page.pageNumber;
            const lines = page.text.split("\n");

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                // Ignore header / metadata / footer lines
                if (/^(?:UNION\s+PUBLIC|Civil\s+Services|Subject|Maximum|Negative|Scoring|Answer\s+Keys|Q\s*\.\s*N\s*o|NATIONAL\s+TESTING|CONFIDENTIAL|Candidate’s|Booklet\s+Series|\*\s+Lower\s+confidence)/i.test(line)) {
                    continue;
                }
                if (/^(?:Page|PAGE)\s*\d+(?:\s*(?:of|\/)\s*\d+)?/i.test(line)) {
                    continue;
                }
                if (/^(?:Mathematics|Physics|Chemistry|Botany|Zoology)\s*[-:–]\s*Section/i.test(line)) {
                    continue;
                }
                if (/^Q\s+Ans\s+Q\s+Ans/i.test(line)) {
                    continue;
                }

                // Extract all question-answer pairs on this line (supports single and multi-column lines)
                this.parseLineForAnswers(line, pageNum, answersMap, duplicates, anomalies);
            }
        }

        // Convert Map to sorted array by questionNumber
        const sortedAnswers = Array.from(answersMap.values())
            .sort((a, b) => a.questionNumber - b.questionNumber);

        // Sequence continuity check
        for (let i = 0; i < sortedAnswers.length - 1; i++) {
            const cur = sortedAnswers[i].questionNumber;
            const next = sortedAnswers[i + 1].questionNumber;
            if (next > cur + 1) {
                warnings.push(`Sequence gap detected in Answer Key: Missing questions between Q${cur} and Q${next}.`);
            }
        }

        if (duplicates.length > 0) {
            warnings.push(`Found ${duplicates.length} duplicate question entries in Answer Key.`);
        }

        return {
            answers: sortedAnswers,
            duplicates,
            anomalies,
            warnings
        };
    }

    /**
     * Parses an individual line for one or more question-answer pairs
     * Handles:
     * - Multi-column tabular layouts: '1 ( d ) 11 ( d ) 21 ( b ) 31 ( a ) 41 ( c )'
     * - Space-separated pairs: '1 C 2 C 3 B 4 A 5 D'
     * - Single tabular rows: '1   A' or '1. (B)' or '4   2 or 4' or '5   Dropped'
     * - Numerical ranges: '1   [4.8, 5.0]' or '2   12.5 +/- 0.5'
     */
    static parseLineForAnswers(line, pageNum, answersMap, duplicates, anomalies) {
        // Skip header lines that have no data
        if (/^(?:Q\s+Ans|Answer\s+Key|Mathematics|Physics|Chemistry|\*|Note\b)/i.test(line)) {
            if (!/\b\d{1,3}\b[\.\s\:\-\t\|]+[A-Da-d0-9]/.test(line)) return;
        }

        // Pattern 0: Explicit Question-Type Table Row
        // e.g. "19 MSQ A, C, D HTTP 1.1 has persistent..." or "32 NAT 3 A full binary..." or "1 MCQ B The antonym..."
        const typeRowMatch = line.match(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*)?(\d{1,3})\s+(MCQ|MSQ|NAT|SCQ)\s+([A-E](?:\s*,\s*[A-E])*|[-+]?\d+(?:\.\d+)?(?:\s*(?:to|-)\s*[-+]?\d+(?:\.\d+)?)?)\b\s*(.*)$/i);
        if (typeRowMatch) {
            const qNum = parseInt(typeRowMatch[1], 10);
            const qTypeHint = typeRowMatch[2].toUpperCase();
            const ansToken = typeRowMatch[3].trim();
            if (qNum > 0 && qNum <= 300) {
                const parsed = this.interpretAnswerToken(qNum, ansToken, line, pageNum, qTypeHint);
                if (parsed) {
                    answersMap.set(qNum, parsed);
                    return;
                }
            }
        }

        // Pattern 0.5: Quick Answer Grid colon-separated pairs
        // e.g. "1: B 2: C 3: C 4: D" or "19: A, C, D 20: B, D 21: A, C"
        const colonGridMatches = Array.from(line.matchAll(/(?:^|\s)\b(\d{1,3})\s*[:]\s*([A-Za-z0-9\.\+\-\*,\/\s]+?)(?=\s+\b\d{1,3}\s*[:]\s*|\s*$)/gi));
        if (colonGridMatches.length > 1) {
            let allValid = true;
            const parsedList = [];
            for (const gm of colonGridMatches) {
                const qNum = parseInt(gm[1], 10);
                const rawTok = gm[2].trim();
                if (qNum <= 0 || qNum > 300) { allValid = false; break; }
                const parsed = this.interpretAnswerToken(qNum, rawTok, line, pageNum);
                if (!parsed) { allValid = false; break; }
                parsedList.push({ qNum, parsed });
            }
            if (allValid && parsedList.length > 1) {
                for (const item of parsedList) {
                    if (!answersMap.has(item.qNum)) {
                        answersMap.set(item.qNum, item.parsed);
                    }
                }
                return;
            }
        }

        // Multi-pair regex:
        // Matches tabular multi-column pairs: e.g. "1 ( d ) 11 ( d ) 21 ( b )", "1 C 2 C 3 B", "23 225 24 17", "50 100*", "38 2,3"
        const multiRegex = /(?:^|\s)\b(\d{1,3})\b[\.\s\:\-\t\|]+(?:\(\s*([A-Za-z0-9\.\+\-\*,\/]+)\s*\)|([A-Za-z0-9\.\+\-\*,\/]+))(?=\s+\b\d{1,3}\b|\s*$)/gi;
        const matches = Array.from(line.matchAll(multiRegex));

        let isValidMultiColumn = matches.length > 1;
        if (isValidMultiColumn) {
            // Must start at or near the beginning of line
            if (matches[0].index > 2) {
                isValidMultiColumn = false;
            } else {
                for (let m = 0; m < matches.length - 1; m++) {
                    const q1 = parseInt(matches[m][1], 10);
                    const q2 = parseInt(matches[m + 1][1], 10);
                    if (q2 <= q1) {
                        isValidMultiColumn = false;
                        break;
                    }
                }
                // Check if all tokens are valid answers
                if (isValidMultiColumn) {
                    for (const match of matches) {
                        const qNum = parseInt(match[1], 10);
                        const rawToken = (match[2] || match[3]).trim();
                        if (qNum <= 0 || qNum > 300 || !this.interpretAnswerToken(qNum, rawToken, line, pageNum)) {
                            isValidMultiColumn = false;
                            break;
                        }
                    }
                }
            }
        }

        if (isValidMultiColumn) {
            for (const match of matches) {
                const qNum = parseInt(match[1], 10);
                const rawToken = (match[2] || match[3]).trim();
                const parsed = this.interpretAnswerToken(qNum, rawToken, line, pageNum);
                if (parsed) {
                    if (answersMap.has(qNum)) {
                        const existing = answersMap.get(qNum);
                        const isSame = JSON.stringify(existing.acceptedAnswers) === JSON.stringify(parsed.acceptedAnswers);
                        if (!isSame) {
                            duplicates.push({ questionNumber: qNum, existing, duplicate: parsed, line });
                        }
                    }
                    answersMap.set(qNum, parsed);
                }
            }
            return;
        }

        // Single-row fallback:
        // e.g. "1   A or C", "1   [4.8, 5.0]", "2   12.5 +/- 0.5", "3   50", "1   B", "4   Dropped"
        // Also supports tabular rows with option text: "1 3 38" or "2 2 Patna, Bihar..." or "(B) 4th March"
        const rowMatch = line.match(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*)?(\d{1,3})[\.\s\:\-\t\|]+(.+)$/i);
        if (rowMatch) {
            const qNum = parseInt(rowMatch[1], 10);
            const answerToken = rowMatch[2].trim();

            if (qNum > 0 && qNum <= 300) {
                let parsed = null;
                const isMultiOption = /^\(?[1-5A-Ea-e]\)?(?:\s*(?:or|and|\/|,)\s*\(?[1-5A-Ea-e]\)?)+$/i.test(answerToken);
                const tableRowMatch = !isMultiOption && answerToken.match(/^(\([1-5A-Ea-e]\)|[1-5A-Ea-e]|\*|Drop(?:ped)?|Bonus)\b(?:\s*[\.\:\-\–\t\|]\s*|\s+)(.*)$/i);
                if (isMultiOption) {
                    parsed = this.interpretAnswerToken(qNum, answerToken, line, pageNum);
                } else if (tableRowMatch) {
                    parsed = this.interpretAnswerToken(qNum, tableRowMatch[1], line, pageNum);
                } else if (!this.isInstructionSentence(answerToken)) {
                    parsed = this.interpretAnswerToken(qNum, answerToken, line, pageNum);
                }

                if (parsed) {
                    if (answersMap.has(qNum)) {
                        const existing = answersMap.get(qNum);
                        const isSame = JSON.stringify(existing.acceptedAnswers) === JSON.stringify(parsed.acceptedAnswers);
                        if (!isSame) {
                            duplicates.push({ questionNumber: qNum, existing, duplicate: parsed, line });
                        }
                    }
                    answersMap.set(qNum, parsed);
                }
            }
        }
    }

    /**
     * Interpret a single answer string into canonical format:
     * - Single choice: "A", "B", "1", "2" -> canonical "A", "B", etc.
     * - Multiple choice: "A or C", "2 or 4", "A, B", "1/3", "B, D" -> ["A", "C"]
     * - Dropped / Bonus: "Dropped", "Drop", "Bonus", "*", "Cancelled"
     * - Numerical / Range: "12.5", "[12.4, 12.6]", "125 +/- 2", "12.4 to 12.6"
     */
    static interpretAnswerToken(qNum, token, rawLine, pageNum, hintType = null) {
        const trimmed = String(token || "").trim();
        const isAsteriskOnly = /^[\*\#\@]+$/.test(trimmed);

        // Strip trailing footnote asterisks or extraneous whitespace
        const clean = trimmed.replace(/[\(\)\[\]\*]/g, " ").trim();

        // 1. Dropped / Bonus / Cancelled / All / Asterisk
        if (isAsteriskOnly || /^(?:Drop(?:ped)?|Bonus|Cancelled|Deleted|\*|All|Full\s*Marks)$/i.test(clean)) {
            return createAnswerKeyExtraction({
                questionNumber: qNum,
                answerType: "dropped",
                acceptedAnswers: ["*"],
                isDropped: true,
                isBonus: true,
                evidenceText: rawLine,
                pageNumber: pageNum,
                confidence: 0.99
            });
        }

        // If hint indicates NAT/numerical question, evaluate numerical value before option mapping (e.g. answer "3" is value 3, not option C)
        const isExplicitNat = hintType && /^(?:NAT|NUMERICAL)$/i.test(hintType);
        if (isExplicitNat && /^[-+]?\d+(?:\.\d+)?$/.test(clean)) {
            const numVal = parseFloat(clean);
            if (Number.isFinite(numVal) && !isNaN(numVal)) {
                return createAnswerKeyExtraction({
                    questionNumber: qNum,
                    answerType: "numerical",
                    numericValue: numVal,
                    acceptedAnswers: [clean],
                    evidenceText: rawLine,
                    pageNumber: pageNum,
                    confidence: 0.98
                });
            }
        }

        // 2. Multi-Option Choice: e.g. "2 or 4", "A or C", "A, B", "1/3", "B, D", "A and D"
        if (/\b(?:or|and)\b|[\/,]/i.test(token)) {
            const parts = token.split(/\b(?:or|and)\b|[\/,]/i)
                .map(p => p.trim())
                .filter(Boolean);

            const canonicalOptions = [];
            let allValidOptions = true;

            for (const part of parts) {
                const opt = this.normalizeOptionToken(part);
                if (opt) {
                    canonicalOptions.push(opt);
                } else {
                    allValidOptions = false;
                }
            }

            if (allValidOptions && canonicalOptions.length >= 2) {
                return createAnswerKeyExtraction({
                    questionNumber: qNum,
                    answerType: "multiple_choice",
                    acceptedAnswers: canonicalOptions,
                    evidenceText: rawLine,
                    pageNumber: pageNum,
                    confidence: 0.98
                });
            }
        }

        // 3. Range format: "[12.4, 12.6]" or "12.4 to 12.6" or "12.4 - 12.6" or "12.5 +/- 0.5"
        const bracketRange = token.match(/\[\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*\]/);
        const toRange = token.match(/([-+]?\d+(?:\.\d+)?)\s*(?:to|-)\s*([-+]?\d+(?:\.\d+)?)/i);
        const plusMinusRange = token.match(/([-+]?\d+(?:\.\d+)?)\s*(?:\+\/\-|±)\s*(\d+(?:\.\d+)?)/);

        if (bracketRange) {
            const min = parseFloat(bracketRange[1]);
            const max = parseFloat(bracketRange[2]);
            return createAnswerKeyExtraction({
                questionNumber: qNum,
                answerType: "range",
                numericRange: { min, max },
                evidenceText: rawLine,
                pageNumber: pageNum,
                confidence: 0.98
            });
        } else if (plusMinusRange) {
            const center = parseFloat(plusMinusRange[1]);
            const delta = parseFloat(plusMinusRange[2]);
            return createAnswerKeyExtraction({
                questionNumber: qNum,
                answerType: "range",
                numericRange: { min: center - delta, max: center + delta },
                evidenceText: rawLine,
                pageNumber: pageNum,
                confidence: 0.95
            });
        } else if (toRange && !/\b(?:to)\b/i.test(rawLine)) {
            // Guard against "to" in sentence instructions
            const min = parseFloat(toRange[1]);
            const max = parseFloat(toRange[2]);
            return createAnswerKeyExtraction({
                questionNumber: qNum,
                answerType: "range",
                numericRange: { min, max },
                evidenceText: rawLine,
                pageNumber: pageNum,
                confidence: 0.95
            });
        }

        // 4. Single MCQ Option: "A", "B", "C", "D", "E", "1", "2", "3", "4", "5"
        const opt = this.normalizeOptionToken(clean);
        if (opt) {
            return createAnswerKeyExtraction({
                questionNumber: qNum,
                answerType: "single_choice",
                acceptedAnswers: [opt],
                evidenceText: rawLine,
                pageNumber: pageNum,
                confidence: 0.99
            });
        }

        // 5. Single Numerical Answer: e.g. "14.5", "250", "-3.14", "1333", "225"
        if (/^[-+]?\d+(?:\.\d+)?$/.test(clean)) {
            const numVal = parseFloat(clean);
            if (Number.isFinite(numVal) && !isNaN(numVal)) {
                return createAnswerKeyExtraction({
                    questionNumber: qNum,
                    answerType: "numerical",
                    numericValue: numVal,
                    acceptedAnswers: [clean],
                    evidenceText: rawLine,
                    pageNumber: pageNum,
                    confidence: 0.95
                });
            }
        }

        return null;
    }

    /**
     * Normalizes single token into canonical option A..E
     */
    static normalizeOptionToken(tok) {
        const clean = tok.replace(/[\(\)\[\]\.\,\:\*]/g, "").trim().toUpperCase();
        if (/^[A-E]$/.test(clean)) {
            return clean;
        }
        if (/^[1-5]$/.test(clean)) {
            return String.fromCharCode(64 + parseInt(clean, 10)); // 1->A, 2->B, 3->C, 4->D, 5->E
        }
        return null;
    }

    /**
     * Filters out non-answer instruction sentences
     */
    static isInstructionSentence(text) {
        return text.split(/\s+/).length > 8 ||
            /(?:candidates|regulations|instructions|examination|centre|invigilator|admit\s+card|signature)/i.test(text);
    }
}
