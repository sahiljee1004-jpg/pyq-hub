import { createRequire } from "node:module";
import {
    createExtractionField,
    createPaperFormatExtraction,
    ExtractionStatus,
    DocumentType,
    ExtractionMethod,
    OptionalPolicyType
} from "./extractionSchema.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

export class PaperFormatParser {

    /**
     * Parse Official Paper Format / Pattern document
     * @param {Buffer|string|Array<{pageNumber: number, text: string}>} input
     * @param {object} options
     * @returns {Promise<object>} Extracted rules and examination structure with strict provenance
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
            throw new Error("[PaperFormatParser] Invalid input: Expected PDF Buffer, string, or page array.");
        }

        const fullText = pages.map(p => p.text).join("\n");

        // 1. Extract Exam Title
        const examTitle = this.extractExamTitle(pages);

        // 2. Extract Paper Code / Series (if format document specifies)
        const paperCode = this.extractPaperCode(pages);

        // 3. Extract Duration
        const durationSeconds = this.extractDuration(pages);

        // 4. Extract Total Questions (checking for internal contradictions)
        const totalQuestions = this.extractTotalQuestions(pages);

        // 5. Extract Maximum Marks
        const maximumMarks = this.extractMaximumMarks(pages);

        // 6. Extract Section Hierarchy
        const sections = this.extractSections(pages);

        // 7. Extract Marking Rules (Positive, Negative, Unanswered)
        const markingRules = this.extractMarkingRules(pages);

        // 8. Extract Optional Question Rules ("any 5 of 10", "first 10 evaluated")
        const optionalQuestionRules = this.extractOptionalRules(pages);

        // 9. Extract Dropped Question Policy
        const droppedQuestionPolicy = this.extractDroppedPolicy(pages);

        return createPaperFormatExtraction({
            examTitle,
            paperCode,
            durationSeconds,
            totalQuestions,
            maximumMarks,
            sections,
            positiveMarks: markingRules.positiveMarks,
            negativeMarks: markingRules.negativeMarks,
            unansweredMarks: markingRules.unansweredMarks,
            optionalQuestionRules,
            droppedQuestionPolicy,
            rawTextSnippets: pages.map(p => ({ pageNumber: p.pageNumber, snippet: p.text.slice(0, 1500) }))
        });
    }

    /**
     * Extract pages from PDF buffer
     */
    static async extractPagesFromPdf(pdfBuffer) {
        if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
            throw new Error("[PaperFormatParser] Empty or invalid PDF buffer supplied.");
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
     * Extract Exam Title from top pages
     */
    static extractExamTitle(pages) {
        for (const page of pages.slice(0, 2)) {
            const lines = page.text.split("\n").map(l => l.trim()).filter(Boolean);
            for (const line of lines.slice(0, 5)) {
                const match = line.match(/^([A-Za-z0-9\s,\-–—\(\)\.]{5,90}(?:EXAMINATION|EXAM(?:\s+PATTERN)?|TEST|BULLETIN|SYLLABUS|SCHEME|NOTIFICATION)[A-Za-z0-9\s,\-–—\(\)\.]*)/i);
                if (match) {
                    return {
                        value: match[1].trim(),
                        pageNumber: page.pageNumber,
                        evidenceText: match[0].trim(),
                        confidence: 0.95
                    };
                }
            }
        }
        return { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 };
    }

    /**
     * Extract Paper / Booklet Code if mentioned
     */
    static extractPaperCode(pages) {
        for (const page of pages) {
            const match = page.text.match(/(?:Booklet\s+Code|Paper\s+Code|Code)\s*[:\-]?\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/i);
            if (match) {
                return {
                    value: match[1].toUpperCase(),
                    pageNumber: page.pageNumber,
                    evidenceText: match[0].trim(),
                    confidence: 0.95
                };
            }
        }
        return { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 };
    }

    /**
     * Extract Examination Duration in seconds
     */
    static extractDuration(pages) {
        for (const page of pages) {
            const compoundMatch = page.text.match(/(?:Duration(?:\s+of\s+Test)?|Time(?:\s+Allowed)?)\s*[:\-]?\s*(\d+)\s*(?:Hours?|Hrs?)\s*(?:and\s*)?(\d+)\s*(?:Minutes?|Mins?)/i);
            const minutesMatch = page.text.match(/(?:Duration(?:\s+of\s+Test)?|Time(?:\s+Allowed)?)\s*[:\-]?\s*(\d+)\s*(?:Minutes?|Mins?)/i);
            const singleHoursMatch = page.text.match(/(?:Duration(?:\s+of\s+Test)?|Time(?:\s+Allowed)?)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:Hours?|Hrs?)/i);

            if (compoundMatch) {
                const hrs = parseInt(compoundMatch[1], 10);
                const mins = parseInt(compoundMatch[2], 10);
                return {
                    value: (hrs * 3600) + (mins * 60),
                    pageNumber: page.pageNumber,
                    evidenceText: compoundMatch[0].trim(),
                    confidence: 0.98
                };
            }
            if (minutesMatch) {
                const mins = parseInt(minutesMatch[1], 10);
                return {
                    value: mins * 60,
                    pageNumber: page.pageNumber,
                    evidenceText: minutesMatch[0].trim(),
                    confidence: 0.98
                };
            }
            if (singleHoursMatch) {
                const hrs = parseFloat(singleHoursMatch[1]);
                return {
                    value: Math.round(hrs * 3600),
                    pageNumber: page.pageNumber,
                    evidenceText: singleHoursMatch[0].trim(),
                    confidence: 0.98
                };
            }

            // Tabular cell duration: e.g. "Total 100 200 1 hour" or "Time Allowed ... 1 hour total"
            const tableDurationMatch = page.text.match(/(?:Total\s+\d+\s+\d+\s+|Time\s+Allowed\s+.*?)(?:(\d+)\s*(?:hours?|hrs?)\s*(?:and\s*)?(\d+)\s*(?:minutes?|mins?)|(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)|(\d+)\s*(?:minutes?|mins?))/i);
            if (tableDurationMatch) {
                const hrs = tableDurationMatch[3] ? parseFloat(tableDurationMatch[3]) : (tableDurationMatch[1] ? parseInt(tableDurationMatch[1], 10) : 0);
                const mins = tableDurationMatch[2] ? parseInt(tableDurationMatch[2], 10) : (tableDurationMatch[4] ? parseInt(tableDurationMatch[4], 10) : 0);
                if (hrs > 0 || mins > 0) {
                    return {
                        value: Math.round((hrs * 3600) + (mins * 60)),
                        pageNumber: page.pageNumber,
                        evidenceText: tableDurationMatch[0].trim(),
                        confidence: 0.95
                    };
                }
            }
        }
        return { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 };
    }

    /**
     * Extract Total Questions with Contradiction Detection
     */
    static extractTotalQuestions(pages) {
        const matches = [];
        for (const page of pages) {
            const regex = /(?:(?:Total|No\.?|Number)\s+of\s+Questions?|Total\s+Questions?|(?:^|\n)\s*Questions?)\s*[:\-]?\s*(\d+)/gim;
            let m;
            while ((m = regex.exec(page.text)) !== null) {
                matches.push({
                    count: parseInt(m[1], 10),
                    pageNumber: page.pageNumber,
                    evidenceText: m[0].trim()
                });
            }

            // Tabular total row: e.g. "Total 100 200"
            const tableTotalRegex = /(?:^|\n)\s*Total\s+(\d{1,4})\s+\d{1,4}/gim;
            let tm;
            while ((tm = tableTotalRegex.exec(page.text)) !== null) {
                matches.push({
                    count: parseInt(tm[1], 10),
                    pageNumber: page.pageNumber,
                    evidenceText: tm[0].trim()
                });
            }
        }

        if (matches.length === 0) {
            return { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 };
        }

        // Check for contradictions within the document
        const uniqueValues = Array.from(new Set(matches.map(m => m.count)));
        if (uniqueValues.length > 1) {
            return {
                value: null,
                status: ExtractionStatus.CONTRADICTORY,
                pageNumber: matches[0].pageNumber,
                evidenceText: `Contradictory total question counts found: ${uniqueValues.join(" vs ")}`,
                confidence: 0
            };
        }

        return {
            value: matches[0].count,
            pageNumber: matches[0].pageNumber,
            evidenceText: matches[0].evidenceText,
            confidence: 0.98
        };
    }

    /**
     * Extract Maximum Marks
     */
    static extractMaximumMarks(pages) {
        for (const page of pages) {
            const match = page.text.match(/(?:Maximum\s+Marks?|Max\.?\s+Marks?|Total\s+Marks?)\s*[:\-]?\s*(\d+)/i);
            if (match) {
                return {
                    value: parseInt(match[1], 10),
                    pageNumber: page.pageNumber,
                    evidenceText: match[0].trim(),
                    confidence: 0.98
                };
            }

            // Tabular total row: e.g. "Total 100 200"
            const tableTotalMatch = page.text.match(/(?:^|\n)\s*Total\s+\d{1,4}\s+(\d{1,4})/i);
            if (tableTotalMatch) {
                return {
                    value: parseInt(tableTotalMatch[1], 10),
                    pageNumber: page.pageNumber,
                    evidenceText: tableTotalMatch[0].trim(),
                    confidence: 0.95
                };
            }
        }
        return { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 };
    }

    /**
     * Extract Section declarations from format document
     */
    static extractSections(pages) {
        const sections = [];
        const seenSecIds = new Set();

        for (const page of pages) {
            const lines = page.text.split("\n");
            let currentSec = null;

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;

                // 1. Inline pattern e.g. "Physics (Section A: 35, Section B: 15)" or "Section A: 35 questions"
                const inlineMatches = Array.from(line.matchAll(/(?:Section|Part|Group)\s+([A-Z0-9]+)\s*[:\(]\s*(\d+)\s*(?:questions?)?/gi));
                if (inlineMatches.length > 0) {
                    for (const sm of inlineMatches) {
                        const secId = `sec_${sm[1].toLowerCase()}`;
                        if (!seenSecIds.has(secId)) {
                            seenSecIds.add(secId);
                            currentSec = {
                                sectionId: secId,
                                sectionName: `Section ${sm[1].toUpperCase()}`,
                                questionCount: parseInt(sm[2], 10),
                                markingRules: null,
                                pageNumber: page.pageNumber,
                                evidenceText: line
                            };
                            sections.push(currentSec);
                        }
                    }
                } else {
                    // 2. Block header pattern: "SECTION A: ROBOTICS" (exclude table headers like "Section Marks" or "Group Topics")
                    const reservedHeaderKeywords = /^(?:MARKS|TOPICS|QUESTIONS|DETAILS|SUMMARY|STRUCTURE|BREAKUP|WISE|OVERVIEW|SCHEME|PATTERN|NOTES|HOURS|MINUTES|COUNT|TYPES?)\b/i;
                    const headerMatch = line.match(/^(?:SECTION|PART|GROUP)\s+([A-Z0-9]+)(?:\s*[:\-]\s*(.*))?$/i);
                    if (headerMatch && !reservedHeaderKeywords.test(headerMatch[1]) && (headerMatch[1].length <= 4 || headerMatch[2])) {
                        const secLetter = headerMatch[1].toUpperCase();
                        const secId = `sec_${secLetter.toLowerCase()}`;
                        const remainder = (headerMatch[2] || "").trim();
                        let qCount = null;
                        let secName = `Section ${secLetter}`;

                        const countInRem = remainder.match(/^(\d+)\s*(?:questions?)?/i);
                        if (countInRem) {
                            qCount = parseInt(countInRem[1], 10);
                        } else if (remainder) {
                            secName = remainder.split("|")[0].trim();
                        }

                        if (!seenSecIds.has(secId)) {
                            seenSecIds.add(secId);
                            currentSec = {
                                sectionId: secId,
                                sectionName: secName,
                                questionCount: qCount,
                                markingRules: null,
                                pageNumber: page.pageNumber,
                                evidenceText: line
                            };
                            sections.push(currentSec);
                        } else {
                            currentSec = sections.find(s => s.sectionId === secId);
                        }
                    } else {
                        // 3a. Tabular question layout row: e.g. "Q.1 – Q.5 General Aptitude 1 5 5" or "Q.11 – Q.35 Technical (Engg. Maths + CS) 1 25 25"
                        const qRangeLayoutMatch = line.match(/^Q\.?\s*(\d{1,3})\s*[-–—]\s*Q?\.?\s*(\d{1,3})\s+([A-Za-z0-9\s\(\)\+&\.\/]+?)\s+(\d+(?:\.\d+)?)\s+(\d{1,3})\s+(\d{1,4})$/);
                        if (qRangeLayoutMatch) {
                            const startQ = parseInt(qRangeLayoutMatch[1], 10);
                            const endQ = parseInt(qRangeLayoutMatch[2], 10);
                            const rawName = qRangeLayoutMatch[3].trim();
                            const marksEach = parseFloat(qRangeLayoutMatch[4]);
                            const count = parseInt(qRangeLayoutMatch[5], 10);
                            const totMarks = parseInt(qRangeLayoutMatch[6], 10);

                            if (!/^(?:Total|Overall|Grand\s*Total|Sum)$/i.test(rawName)) {
                                const secId = `sec_${rawName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
                                if (!seenSecIds.has(secId)) {
                                    seenSecIds.add(secId);
                                    currentSec = {
                                        sectionId: secId,
                                        sectionName: rawName,
                                        subject: rawName,
                                        questionCount: count,
                                        startQuestion: startQ,
                                        endQuestion: endQ,
                                        maximumMarks: totMarks,
                                        questionRanges: [{ startQ, endQ, positiveMarks: marksEach, questionCount: count, marks: totMarks }],
                                        markingRules: {
                                            positiveMarks: { value: marksEach, confidence: 0.95 },
                                            negativeMarks: null,
                                            unansweredMarks: { value: 0, confidence: 0.95 }
                                        },
                                        pageNumber: page.pageNumber,
                                        evidenceText: line
                                    };
                                    sections.push(currentSec);
                                } else {
                                    currentSec = sections.find(s => s.sectionId === secId);
                                    if (currentSec) {
                                        currentSec.questionCount = (currentSec.questionCount || 0) + count;
                                        currentSec.maximumMarks = (currentSec.maximumMarks || 0) + totMarks;
                                        currentSec.startQuestion = Math.min(currentSec.startQuestion || startQ, startQ);
                                        currentSec.endQuestion = Math.max(currentSec.endQuestion || endQ, endQ);
                                        currentSec.questionRanges = currentSec.questionRanges || [];
                                        currentSec.questionRanges.push({ startQ, endQ, positiveMarks: marksEach, questionCount: count, marks: totMarks });
                                    }
                                }
                            }
                        } else {
                            // 3b. Tabular row pattern: "Physics 45 180 1 – 45" or "General Studies 100 200 1 - 100"
                        const tableRowMatch = line.match(/^([A-Za-z\s\(\)\+]+?)\s+(\d{1,3})\s+(?:\d{1,4}\s+)?(\d{1,3})\s*[-–—]\s*(\d{1,3})$/);
                        if (tableRowMatch) {
                            const rawName = tableRowMatch[1].trim();
                            if (!/^(?:Total|Overall|Grand\s*Total|Sum)$/i.test(rawName)) {
                                const qCount = parseInt(tableRowMatch[2], 10);
                                const startQ = parseInt(tableRowMatch[3], 10);
                                const endQ = parseInt(tableRowMatch[4], 10);
                                const secId = `sec_${rawName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
                                if (!seenSecIds.has(secId)) {
                                    seenSecIds.add(secId);
                                    currentSec = {
                                        sectionId: secId,
                                        sectionName: rawName,
                                        subject: rawName,
                                        questionCount: qCount,
                                        startQuestion: startQ,
                                        endQuestion: endQ,
                                        markingRules: null,
                                        pageNumber: page.pageNumber,
                                        evidenceText: line
                                    };
                                    sections.push(currentSec);
                                } else {
                                    currentSec = sections.find(s => s.sectionId === secId);
                                }
                            }
                        } else {
                            // 4. Tabular section row with letter, subject, questions, marks:
                            // e.g. "A General Intelligence and Reasoning 25 50"
                            const secTableMatch = line.match(/^([A-Z])\s+([A-Za-z\s&]+?)\s+(\d{1,3})\s+(\d{1,4})(?:\s+.*)?$/);
                            if (secTableMatch && !/^(?:Total|Overall|Grand|Session|Section|Paper)\b/i.test(secTableMatch[2])) {
                                const secLetter = secTableMatch[1].toUpperCase();
                                const rawName = secTableMatch[2].trim();
                                const qCount = parseInt(secTableMatch[3], 10);
                                const secId = `sec_${secLetter.toLowerCase()}`;
                                if (!seenSecIds.has(secId)) {
                                    seenSecIds.add(secId);
                                    currentSec = {
                                        sectionId: secId,
                                        sectionName: `Section ${secLetter} – ${rawName}`,
                                        subject: rawName,
                                        questionCount: qCount,
                                        markingRules: null,
                                        pageNumber: page.pageNumber,
                                        evidenceText: line
                                    };
                                    sections.push(currentSec);
                                } else {
                                    currentSec = sections.find(s => s.sectionId === secId);
                                }
                            }
                        }
                    }
                }
                }

                // If current section active, extract questions count and marking rules on this line
                if (currentSec) {
                    if (currentSec.questionCount === null && !/(?:Total|Overall|Grand)\s+Questions?/i.test(line)) {
                        const countMatch = line.match(/(?:Number\s+of\s+Questions?|Questions?)\s*[:\-]?\s*(\d+)/i);
                        if (countMatch) {
                            currentSec.questionCount = parseInt(countMatch[1], 10);
                        }
                    }

                    const posMatch = line.match(/(?:(?:marks?\s*(?:per\s*question|\/question|each))|(?:(?:positive|correct)(?:\s*marks?)?))\s*[:=\-+]?\s*(\+?\d+(?:\.\d+)?)/i);
                    const negMatch = line.match(/(?:(?:negative|incorrect|deduct(?:ion)?)(?:\s*marking|\s*marks?)?)\s*[:=\-]?\s*(-?\d+(?:\.\d+)?)/i);
                    const zeroNeg = /(?:no\s+negative|0\s*negative|incorrect\s*0)/i.test(line) && !/^(?:•|\*|-)?\s*(?:NAT|MSQ)\b/i.test(line);

                    if (posMatch || negMatch || zeroNeg) {
                        currentSec.markingRules = currentSec.markingRules || {
                            positiveMarks: null,
                            negativeMarks: null,
                            unansweredMarks: { value: 0, confidence: 0.95 }
                        };
                        if (posMatch) {
                            currentSec.markingRules.positiveMarks = { value: parseFloat(posMatch[1]), confidence: 0.95 };
                        }
                        if (zeroNeg) {
                            currentSec.markingRules.negativeMarks = { value: 0, confidence: 0.95 };
                        } else if (negMatch) {
                            const nv = parseFloat(negMatch[1]);
                            currentSec.markingRules.negativeMarks = { value: nv > 0 ? -nv : nv, confidence: 0.95 };
                        }
                    }
                }
            }
        }
        return sections;
    }

    /**
     * Extract Marking Scheme (Positive, Negative, Unanswered)
     */
    static extractMarkingRules(pages) {
        let positive = null;
        let negative = null;
        let unanswered = null;

        // 1. Positive Marking
        const wordToNum = { one: 1, two: 2, three: 3, four: 4, five: 5 };
        for (const page of pages) {
            if (positive) break;
            const lines = page.text.split("\n");
            for (const line of lines) {
                // Ignore descriptive sentences such as "only one option is correct."
                if (/only\s+one\s+option\s+is\s+correct/i.test(line)) continue;

                const mPerQ = line.match(/\(\s*(\d+(?:\.\d+)?)\s*marks?\s+per\s+question\s*\)/i);
                const mMarksPerQ = line.match(/(?:marks?\s+per\s+question|marks?\s+for\s+each\s+question)\s*[:=\-]?\s*(\d+(?:\.\d+)?)/i);
                const mEachCorrect = line.match(/(?:(?:each\s+)?correct\s*(?:answer)?|allotted\s+marks?)\s*(?:[:=\-]|carries|gives|awards|yields|receives)?\s*[\+]?\s*(\d+(?:\.\d+)?)\s*(?:marks?)?/i);
                const mMarksPer = line.match(/(One|Two|Three|Four|Five|\d+(?:\.\d+)?)\s*marks?\s*(?:\(\s*[\+]?(\d+(?:\.\d+)?)\s*\))?\s*(?:per\s+question|for\s+(?:each\s+)?correct(?:\s+answer)?)/i);
                const mWeightage = line.match(/(?:MCQ|NAT|MSQ)\s*[-–]\s*(\d+)\s*marks?\s*[\+]?(\d+(?:\.\d+)?)/i)
                    || line.match(/\b(\d+)\s*marks?\s+each\b/i)
                    || line.match(/Question\s+weightage\s*[:\-]?\s*(\d+)-mark/i);

                if (mPerQ && Number.isFinite(parseFloat(mPerQ[1]))) {
                    positive = {
                        value: parseFloat(mPerQ[1]),
                        pageNumber: page.pageNumber,
                        evidenceText: mPerQ[0].trim(),
                        confidence: 0.98
                    };
                    break;
                } else if (mMarksPerQ && Number.isFinite(parseFloat(mMarksPerQ[1]))) {
                    positive = {
                        value: parseFloat(mMarksPerQ[1]),
                        pageNumber: page.pageNumber,
                        evidenceText: mMarksPerQ[0].trim(),
                        confidence: 0.98
                    };
                    break;
                } else if (mEachCorrect && Number.isFinite(parseFloat(mEachCorrect[1]))) {
                    positive = {
                        value: parseFloat(mEachCorrect[1]),
                        pageNumber: page.pageNumber,
                        evidenceText: mEachCorrect[0].trim(),
                        confidence: 0.98
                    };
                    break;
                } else if (mWeightage && Number.isFinite(parseFloat(mWeightage[2] || mWeightage[1]))) {
                    positive = {
                        value: parseFloat(mWeightage[2] || mWeightage[1]),
                        pageNumber: page.pageNumber,
                        evidenceText: mWeightage[0].trim(),
                        confidence: 0.95
                    };
                    break;
                } else if (mMarksPer) {
                    const val = mMarksPer[2] ? parseFloat(mMarksPer[2]) : (wordToNum[mMarksPer[1].toLowerCase()] || parseFloat(mMarksPer[1]));
                    if (Number.isFinite(val)) {
                        positive = {
                            value: val,
                            pageNumber: page.pageNumber,
                            evidenceText: mMarksPer[0].trim(),
                            confidence: 0.98
                        };
                        break;
                    }
                }
            }
        }

        // 2. Negative Marking
        for (const page of pages) {
            if (negative) break;
            const text = page.text;
            const hasExplicitNegative = /(?:negative\s+marking\s+only\s+for\s+mcqs?|mcq[^\n]*[-−]1\/3|deduct(?:ion)?\s*(?:of)?\s*[-−]?[0-9\.\/]+\s*marks?|incorrect\s*answer\s*[:=\-–—−]\s*[-−]?[0-9\.\/]+)/i.test(text);
            if (!hasExplicitNegative && (/no\s+negative\s+marking|there\s+is\s+no\s+penalty|no\s+penalty/i.test(text))) {
                negative = {
                    value: 0,
                    pageNumber: page.pageNumber,
                    evidenceText: "No negative marking",
                    confidence: 0.99
                };
                break;
            }

            // Check explicit lines first: 'Incorrect answer: -1 mark' or 'Incorrect answer -1/3'
            const lines = text.split("\n");
            for (const line of lines) {
                // Check if line specifies a fraction of allotted marks first (e.g. "1/3rd of allotted marks")
                const fractionOfAllotted = /(?:1\/3(?:rd)?|one-third)\s*(?:of\s+(?:allotted|each|the)\s*marks?)/i;
                if (fractionOfAllotted.test(line)) {
                    const base = (positive && Number.isFinite(positive.value)) ? positive.value : 1;
                    negative = {
                        value: -(base / 3),
                        pageNumber: page.pageNumber,
                        evidenceText: line.trim(),
                        confidence: 0.98
                    };
                    break;
                }

                // Tabular marking scheme row: "MCQ – 1 mark +1 −1/3 0"
                const mcqTableMarkMatch = line.match(/(?:MCQ|Single\s*Choice)\s*[-–—]\s*(\d+)\s*marks?\s*\+(\d+)\s*([−\-–—]\s*[0-9\.\/]+)/i);
                if (mcqTableMarkMatch) {
                    const raw = mcqTableMarkMatch[3].trim().replace(/[–—−]/g, "-").replace(/\s+/g, "");
                    const val = (raw === "-1/3" || raw === "1/3") ? -0.3333 : (raw === "-2/3" || raw === "2/3") ? -2 / 3 : parseFloat(raw);
                    if (Number.isFinite(val)) {
                        negative = {
                            value: val > 0 ? -val : val,
                            pageNumber: page.pageNumber,
                            evidenceText: mcqTableMarkMatch[0].trim(),
                            confidence: 0.98
                        };
                        break;
                    }
                }

                const negLineRegex = /(?:incorrect\s*(?:answer)?|wrong\s*answer|negative\s*(?:marking|marks?))\s*(?:[:=\-–—−]|of|carries|deducts)?\s*([+\-–—−]?[0-9\.\/\-]+)\s*(?:marks?)?/i;
                const mNeg = line.match(negLineRegex);
                if (mNeg) {
                    const raw = mNeg[1].trim().replace(/[–—−]/g, "-");
                    if (raw === "-1/3" || raw === "1/3") {
                        negative = {
                            value: -0.3333,
                            pageNumber: page.pageNumber,
                            evidenceText: mNeg[0].trim(),
                            confidence: 0.98
                        };
                        break;
                    } else if (raw === "-2/3" || raw === "2/3") {
                        negative = {
                            value: -2 / 3,
                            pageNumber: page.pageNumber,
                            evidenceText: mNeg[0].trim(),
                            confidence: 0.98
                        };
                        break;
                    } else if (raw === "-1/4" || raw === "1/4") {
                        negative = {
                            value: -0.25,
                            pageNumber: page.pageNumber,
                            evidenceText: mNeg[0].trim(),
                            confidence: 0.98
                        };
                        break;
                    } else {
                        const v = parseFloat(raw);
                        if (Number.isFinite(v)) {
                            negative = {
                                value: v > 0 ? -v : v,
                                pageNumber: page.pageNumber,
                                evidenceText: mNeg[0].trim(),
                                confidence: 0.98
                            };
                            break;
                        }
                    }
                }

                const deductRegex = /(?:deduct(?:ion)?\s*(?:of)?\s*([+\-–—−]?\d+(?:\.\d+)?)\s*marks?(?:\s+for\s+(?:each\s+)?incorrect)?|([+\-–—−]?\d+(?:\.\d+)?)\s*marks?\s*(?:for\s+(?:each\s+)?incorrect|deducted|penalty)|(?:deduction|penalty)\s*of\s*([+\-–—−]?\d+(?:\.\d+)?)\s*marks?)/i;
                const mDed = line.match(deductRegex);
                if (mDed) {
                    const numStr = (mDed[1] || mDed[2] || mDed[3] || "").replace(/[–—−]/g, "-");
                    const v = parseFloat(numStr);
                    if (Number.isFinite(v)) {
                        negative = {
                            value: v > 0 ? -v : v,
                            pageNumber: page.pageNumber,
                            evidenceText: mDed[0].trim(),
                            confidence: 0.98
                        };
                        break;
                    }
                }
            }

            // If not found in line-by-line checks, check broader fractional patterns
            if (!negative) {
                const fractionOfAllotted = /(?:1\/3(?:rd)?|one-third)\s*(?:of\s+(?:allotted|each|the)\s*marks?)/i;
                if (fractionOfAllotted.test(text)) {
                    const base = (positive && Number.isFinite(positive.value)) ? positive.value : 1;
                    negative = {
                        value: -(base / 3),
                        pageNumber: page.pageNumber,
                        evidenceText: "1/3rd of allotted marks",
                        confidence: 0.98
                    };
                } else if (/(?:one-third\s*\(\s*1\/3\s*\)|1\/3rd?\s+negative|penalty\s+of\s+1\/3|1\/3\s*penalty)/i.test(text)) {
                    negative = {
                        value: -1 / 3,
                        pageNumber: page.pageNumber,
                        evidenceText: "1/3 penalty",
                        confidence: 0.98
                    };
                } else if (/(?:one-fourth\s*\(\s*1\/4\s*\)|1\/4th?\s+negative|penalty\s+of\s+1\/4|0\.25\s*penalty)/i.test(text)) {
                    negative = {
                        value: -0.25,
                        pageNumber: page.pageNumber,
                        evidenceText: "1/4 penalty",
                        confidence: 0.98
                    };
                }
            }
        }

        // 3. Unanswered Questions
        for (const page of pages) {
            if (unanswered) break;
            const mUn = page.text.match(/(?:unanswered|unattempted)[^\.\n]*[:\-]?\s*0/i)
                || page.text.match(/(?:zero|0)\s*marks?\s*(?:for\s+)?(?:unanswered|unattempted)/i);
            if (mUn) {
                unanswered = {
                    value: 0,
                    pageNumber: page.pageNumber,
                    evidenceText: mUn[0].trim(),
                    confidence: 0.95
                };
            }
        }

        return {
            positiveMarks: positive || { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 },
            negativeMarks: negative || { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 },
            unansweredMarks: unanswered || { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 }
        };
    }

    /**
     * Extract Optional Question Rules
     * e.g. "Candidates have to attempt 10 questions out of 15 in Section B"
     * e.g. "Attempt any 5 out of 10"
     * e.g. "First 10 attempted questions will be evaluated"
     */
    static extractOptionalRules(pages) {
        const rules = [];

        for (const page of pages) {
            const text = page.text;

            // Pattern 1: "attempt X questions out of Y (in Section Z)?"
            const chooseMatches = text.matchAll(/(?:attempt|answer)\s+(\d+)\s+questions?\s*(?:out\s+of|from)\s+(\d+)(?:\s+(?:in|for)\s+([A-Za-z0-9\s]+))?/gi);
            for (const cm of chooseMatches) {
                const req = parseInt(cm[1], 10);
                const tot = parseInt(cm[2], 10);
                const scope = cm[3] ? cm[3].trim() : "All";
                rules.push({
                    policy: OptionalPolicyType.CHOOSE_N_OF_M,
                    requiredCount: req,
                    totalCount: tot,
                    targetScope: scope,
                    pageNumber: page.pageNumber,
                    evidenceText: cm[0].trim(),
                    confidence: 0.98
                });
            }

            // Pattern 2: "First K attempted questions will be evaluated"
            const firstKMatches = text.matchAll(/(?:only\s+)?first\s+(\d+)\s+attempted\s+questions?\s+will\s+be\s+evaluated/gi);
            for (const fm of firstKMatches) {
                const limit = parseInt(fm[1], 10);
                rules.push({
                    policy: OptionalPolicyType.FIRST_K_ATTEMPTED,
                    evaluateLimit: limit,
                    targetScope: "All",
                    pageNumber: page.pageNumber,
                    evidenceText: fm[0].trim(),
                    confidence: 0.98
                });
            }
        }

        return rules;
    }

    /**
     * Extract Dropped Question Policy if declared
     */
    static extractDroppedPolicy(pages) {
        for (const page of pages) {
            const text = page.text;
            if (/full\s*marks.*awarded\s+to\s+all\s+candidates|dropped.*awarded\s+to\s+all|marked\s+Bonus/i.test(text)) {
                const match = text.match(/(?:full\s*marks.*awarded\s+to\s+all\s+candidates|dropped.*awarded\s+to\s+all[^\.\n]*|marked\s+Bonus[^\.\n]*)/i);
                return {
                    value: "full_marks_for_all",
                    pageNumber: page.pageNumber,
                    evidenceText: match ? match[0].trim() : "full marks to all candidates",
                    confidence: 0.98
                };
            }
            if (/awarded\s+only\s+to\s+candidates\s+who\s+attempted/i.test(text)) {
                const match = text.match(/awarded\s+only\s+to\s+candidates\s+who\s+attempted[^\.\n]*/i);
                return {
                    value: "attempted_only",
                    pageNumber: page.pageNumber,
                    evidenceText: match ? match[0].trim() : "awarded only to candidates who attempted",
                    confidence: 0.98
                };
            }
        }
        return { value: null, status: ExtractionStatus.UNKNOWN, confidence: 0 };
    }
}

