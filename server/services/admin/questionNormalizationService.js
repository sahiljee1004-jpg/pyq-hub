import { createRequire } from "node:module";
import { SubjectNormalizationService } from "../subjectNormalizationService.js";
import { DiagramExtractionService } from "./diagramExtractionService.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

/**
 * Question Normalization Service
 * 
 * Layout-aware PDF question extraction with coordinate ordering, mathematical fidelity,
 * fraction assembly, strict boundary detection, horizontal band support, dynamic gutter detection,
 * diagram extraction, and exam pattern support.
 * Note: Never includes correct answers or answer-key secrets!
 */
export class QuestionNormalizationService {

    /**
     * Filter watermark and running header/footer artifacts
     */
    static isWatermarkOrHeader(item) {
        if (!item || !item.str) return false;
        const s = item.str.trim();
        if (!s) return false;
        // Running headers above main content region
        if (item.transform[5] > 805) return true;
        // Known NTA / PYQ watermarks and banners
        if (/PREVIOUS YEAR QUESTIONS|COMPLETE SHIFT PAPER|Actual Paper|PYQ\s*HUB|^PYQ$|^HUB$|MATH\s+PHYSICS\s+CHEMISTRY/i.test(s)) return true;
        // State PCS / BPSC running booklet footers and rough work indicators
        if (/19–C\/FI\/CC\/PT–2023|\/201-A|ROUGH\s*WORK|SPACE\s*FOR\s*ROUGH\s*WORK|_hÀdnyU© AZwXoe|a’\$ H$m`©/i.test(s)) return true;
        // Running booklet footers and bottom page number stamps below content region
        if (item.transform[5] < 125 && (/19–C|\/201-A|P\.T\.O|DK23/i.test(s) || (/^\d{1,3}$/.test(s) && item.transform[5] >= 100 && item.transform[5] <= 112 && item.transform[4] >= 280 && item.transform[4] <= 305))) return true;
        // Gutter watermark stamps around x ~= 274
        if (/^(?:PYQ|HUB)$/i.test(s) || (/\b(?:PYQ|HUB)\b/i.test(s) && Math.abs(item.transform[4] - 274) < 20)) return true;
        // Page number stamps like '3 / 8'
        if (/^[1-9]\s*\/\s*\d+$/.test(s)) return true;
        // Running shift subtitle
        if (item.transform[5] > 770 && Math.abs(item.transform[4] - 250) < 60 && /Shift/i.test(s)) return true;
        return false;
    }

    /**
     * Identify non-question pages such as front cover instructions or back-page rough work
     */
    static isInstructionOrRoughPage(text) {
        if (!text || text.trim().length < 50) return false;
        const lower = text.toLowerCase();
        if (lower.includes("important instructions") && (lower.includes("candidate") || lower.includes("booklet") || lower.includes("omr") || lower.includes("invigilator") || lower.includes("serial no"))) {
            return true;
        }
        if (lower.includes("rough work") || lower.includes("space for rough work") || /_hÀdnyU© AZwXoe|a’\$ H$m`©/i.test(text)) {
            return true;
        }
        return false;
    }

    /**
     * Linguistically score a page's text for English vs Devanagari / KrutiDev font glyphs
     */
    static scoreLanguage(text) {
        if (!text) return { english: 0, hindi: 0 };
        const englishWords = (text.match(/\b(?:the|of|and|in|to|is|which|following|select|correct|answer|statements?|consider|match|below|given|with|not|are|from|for|on|by|at|an|as|who|what|where|when|why|how)\b/gi) || []).length;
        const devanagariCount = (text.match(/[\u0900-\u097F]/g) || []).length;
        const krutiDevTokens = (text.match(/\{ZÂZ|gw‡r_|H$s|Ho$|h°|h¢|bg|nÃH$|‡À`oH$|nwpÒVH$m|‡ÌZ|narjm|_hÀdnyU©|H$mo|Ho$|H$a|Amn|EH$|`h/g) || []).length;
        return {
            english: englishWords,
            hindi: devanagariCount + (krutiDevTokens * 5)
        };
    }

    /**
     * Filter option matches to enforce monotonic sequences (A -> B -> C -> D or 1 -> 2 -> 3 -> 4),
     * preventing Assertion (A) stem collision and internal trailing option references like (D) Both (A) and (B).
     */
    static filterMonotonicOptions(rawMatches, body) {
        const letters = ["A", "B", "C", "D", "E"];
        let bestChain = [];
        for (let i = 0; i < rawMatches.length; i++) {
            const m = rawMatches[i];
            const label = String(m[1]).toUpperCase();
            if (label === "A" || label === "1") {
                const preText = body.substring(Math.max(0, m.index - 20), m.index);
                if (/assertion\s*$/i.test(preText)) continue;

                const isNumeric = label === "1";
                const seqList = isNumeric ? ["1", "2", "3", "4", "5"] : letters;

                const chain = [m];
                let expectedIdx = 1;
                for (let j = i + 1; j < rawMatches.length; j++) {
                    const nextM = rawMatches[j];
                    const nextLabel = String(nextM[1]).toUpperCase();
                    if (nextLabel === seqList[expectedIdx]) {
                        chain.push(nextM);
                        expectedIdx++;
                        if (expectedIdx >= 4) {
                            if (j + 1 < rawMatches.length && String(rawMatches[j+1][1]).toUpperCase() === seqList[4]) {
                                chain.push(rawMatches[j+1]);
                            }
                            break;
                        }
                    }
                }
                if (chain.length > bestChain.length) {
                    bestChain = chain;
                }
            }
        }
        return bestChain.length >= 2 ? bestChain : rawMatches;
    }

    /**
     * Check if a candidate question number corresponds to a known numerical / NAT section
     */
    static isNumericalQuestionNumber({ candidateNum, cleanExam = "", pattern = null }) {
        if (pattern && Array.isArray(pattern.sections)) {
            const sec = pattern.sections.find(s => candidateNum >= s.startQuestion && candidateNum <= s.endQuestion);
            if (sec && sec.questionType === "numerical") return true;
        }
        if (cleanExam.includes("jee")) {
            if ((candidateNum >= 21 && candidateNum <= 25) || (candidateNum >= 46 && candidateNum <= 50) || (candidateNum >= 71 && candidateNum <= 75)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Authoritative quality & formula-fidelity evaluation
     */
    static evaluateQuestionFidelity({ questionText = "", options = [], questionType = "mcq", hasDiagram = false }) {
        const optionText = (Array.isArray(options) ? options : []).map(o => `${o.label || ""}: ${o.text || ""}`).join(" ");
        const fullContent = `${questionText} ${optionText}`;

        // Check 1: Fraction & exponent collisions e.g. x/362/+, x2/+, 2/x), tan-1/x, /162, \d+/\d+/
        const hasFractionCollision = /(?:[a-zA-Z0-9]+\/\d{2,}\/|[a-zA-Z0-9]+\/\d{2,}\+|x\/\d{2,}2|\d+\/[a-zA-Z0-9]+\/\d+|[a-zA-Z]\/\d+[a-zA-Z0-9]*\/|[a-zA-Z0-9]+2?\/[+\u2212-])/.test(fullContent);

        // Check 2: Distorted calculus / limits / integrals
        const hasDistortedCalculus = /∫[^\n]{0,20}ππ|lim\/x→|\/x1\)|iπn\+\/s/.test(fullContent);

        // Check 3: Distorted differential equations e.g. (1+ 2/x)dy or tan-1/x
        const hasDistortedDiffEq = /\(1\+\s*\d+\/x\)dy|tan−1\/x|π2\/e\/4/.test(fullContent);

        // Check 4: Watermark or banner leakage
        const hasBannerLeakage = /MATH\s*Statement|Statement.*PHYSICS CHEMISTRY|COMPLETE SHIFT|PYQ\s*HUB/i.test(fullContent);

        // Check 5: Scrambled coordination complex notation
        const hasScrambledComplex = /\[Cu\(.*\)\]\d+\/\d+\+|\d+\/Pb|\d+\/CH/i.test(fullContent);

        // MCQs and MSQs require options; numerical questions do NOT require options
        const isMcqFamily = questionType === "mcq" || questionType === "msq" || questionType === "assertion_reason" || questionType === "match_following";
        const hasDiagramOption = Array.isArray(options) && options.some(o => o.isDiagramOption || (o.text || "").includes("[Diagram / Structure"));

        if (hasDiagramOption) {
            return {
                validationStatus: "flagged",
                flagReason: "Option choices contain visual diagrams/structures from source PDF. Administrator visual verification required before publication."
            };
        } else if (isMcqFamily && (!Array.isArray(options) || options.length < 2)) {
            return {
                validationStatus: "flagged",
                flagReason: hasDiagram
                    ? "MCQ options contain diagrams or chemical structures requiring visual review."
                    : `MCQ has only ${options?.length || 0} options parsed. Possible OCR or format anomaly.`
            };
        } else if (questionText.trim().length < 5 && (!Array.isArray(options) || options.length === 0)) {
            return {
                validationStatus: "flagged",
                flagReason: "Question body text appears unusually short or fragmented."
            };
        } else if (hasBannerLeakage) {
            return {
                validationStatus: "flagged",
                flagReason: "Running watermark / banner text leaked into question content."
            };
        } else if (hasFractionCollision) {
            return {
                validationStatus: "flagged",
                flagReason: "Mathematical expression corruption detected (fraction / exponent collision). Requires administrator verification against source."
            };
        } else if (hasDistortedCalculus || hasDistortedDiffEq) {
            return {
                validationStatus: "flagged",
                flagReason: "Calculus expression corruption detected (integral/limit/differential equation). Requires administrator verification against source."
            };
        } else if (hasScrambledComplex) {
            return {
                validationStatus: "flagged",
                flagReason: "Chemical formula corruption detected (scrambled coordination complex / subscripts). Requires administrator verification against source."
            };
        }

        return {
            validationStatus: "valid",
            flagReason: null
        };
    }

    /**
     * Process a single column of PDF text items with spatial fraction assembly
     */
    static processColumnItems(colItems) {
        if (!colItems || colItems.length === 0) return "";

        // Pre-pass 1: Detect chemical ions (subscript + superscript charge sign at same x, e.g. MnO4^2-)
        const consumed = new Set();
        const fractions = [];
        const subMap = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉" };
        const superMap = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻" };

        for (let i = 0; i < colItems.length; i++) {
            if (consumed.has(i)) continue;
            const a = colItems[i]; // potential superscript
            const aStr = a.str ? a.str.trim() : "";

            for (let j = 0; j < colItems.length; j++) {
                if (i === j || consumed.has(j)) continue;
                const b = colItems[j]; // potential subscript
                const bStr = b.str ? b.str.trim() : "";

                const dy = a.transform[5] - b.transform[5];
                const dx = Math.abs(a.transform[4] - b.transform[4]);

                if (dy >= 4.0 && dy <= 13 && dx <= 5.0) {
                    let signItem = null;
                    for (let k = 0; k < colItems.length; k++) {
                        if (k === i || k === j || consumed.has(k)) continue;
                        const it = colItems[k];
                        const s = it.str ? it.str.trim() : "";
                        if ((s === "-" || s === "−" || s === "+") && Math.abs(it.transform[5] - a.transform[5]) <= 1.5 && it.transform[4] >= a.transform[4] && (it.transform[4] - a.transform[4]) <= 8.0) {
                            signItem = { idx: k, str: s };
                            break;
                        }
                    }

                    const isSubscriptDigit = /^[0-9]+$/.test(bStr);
                    const isSuperscriptCharge = (/^[0-9]+$/.test(aStr) && Boolean(signItem)) || /^[+\u2212-]$/.test(aStr);

                    if (isSubscriptDigit && isSuperscriptCharge) {
                        const subUnicode = bStr.split("").map(c => subMap[c] || c).join("");
                        const rawSup = aStr + (signItem ? signItem.str : "");
                        const supUnicode = rawSup.split("").map(c => superMap[c] || c).join("");

                        fractions.push({
                            str: subUnicode + supUnicode,
                            transform: [b.transform[0], 0, 0, b.transform[3], b.transform[4], (a.transform[5] + b.transform[5]) / 2],
                            width: Math.max(a.width || 0, b.width || 0) + (signItem ? 5 : 0)
                        });
                        consumed.add(i);
                        consumed.add(j);
                        if (signItem) consumed.add(signItem.idx);
                        break;
                    }
                }
            }
        }

        // Pre-pass 2: Detect fractions (numerator at y_top, denominator at y_bot, same x)
        for (let i = 0; i < colItems.length; i++) {
            if (consumed.has(i)) continue;
            const a = colItems[i];
            const aStr = a.str ? a.str.trim() : "";
            if (!aStr || aStr.length > 8 || a.str.includes("\n") || !/^[0-9a-zA-Z\+\-\^\*\√]+$/.test(aStr)) continue;

            // Never pair if an ionic charge sign is adjacent
            const hasChargeSign = colItems.some(it => {
                if (!it.str) return false;
                const s = it.str.trim();
                if (s !== "-" && s !== "−" && s !== "+") return false;
                return Math.abs(it.transform[5] - a.transform[5]) <= 1.5 && it.transform[4] >= a.transform[4] && (it.transform[4] - a.transform[4]) <= 8.0;
            });
            if (hasChargeSign) continue;

            for (let j = 0; j < colItems.length; j++) {
                if (i === j || consumed.has(j)) continue;
                const b = colItems[j];
                const bStr = b.str ? b.str.trim() : "";
                if (!bStr || bStr.length > 8 || b.str.includes("\n") || !/^[0-9a-zA-Z\+\-\^\*\√]+$/.test(bStr)) continue;

                const dy = a.transform[5] - b.transform[5];
                const dx = Math.abs(a.transform[4] - b.transform[4]);
                // Vertical alignment for stacked fractions: dy between 4.5 and 13 pt, dx <= 8.5 pt
                if (dy >= 4.5 && dy <= 13 && dx <= 8.5) {
                    const midY = (a.transform[5] + b.transform[5]) / 2;
                    fractions.push({
                        str: `${aStr}/${bStr}`,
                        transform: [a.transform[0], 0, 0, a.transform[3], a.transform[4], midY],
                        width: Math.max(a.width || 0, b.width || 0)
                    });
                    consumed.add(i);
                    consumed.add(j);
                    break;
                }
            }
        }

        const remaining = colItems.filter((_, idx) => !consumed.has(idx)).concat(fractions);
        remaining.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);

        // Group into horizontal visual lines using gap-based clustering
        // Consecutive items on the same text baseline (including subscripts & superscripts) step down <= 5.8 pt.
        // Step downs > 5.8 pt cross the line height threshold into the next line.
        const lines = [];
        let curLine = [];
        let lastItemY = null;

        for (const it of remaining) {
            if (lastItemY !== null && (lastItemY - it.transform[5]) > 5.8) {
                curLine.sort((a, b) => a.transform[4] - b.transform[4]);
                lines.push(curLine);
                curLine = [it];
            } else {
                curLine.push(it);
            }
            lastItemY = it.transform[5];
        }
        if (curLine.length) {
            curLine.sort((a, b) => a.transform[4] - b.transform[4]);
            lines.push(curLine);
        }

        // Render lines with coordinate-aware spacing
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
    }

    /**
     * Render page items respecting horizontal section bands and two-column reading order
     * with dynamic gutter calculation.
     */
    static spatialRenderPage(items) {
        const body = items.filter(it => !this.isWatermarkOrHeader(it));
        if (body.length === 0) return [];

        // Find horizontal section divider items centered around x ~= 255 (e.g. 'Math Sec 2', 'Phy Sec 2', 'Chem Sec 1')
        const dividers = body.filter(it => {
            if (!it.str) return false;
            const s = it.str.trim();
            return /(?:Math|Phy|Chem|Botany|Zoology|Section)\s+Sec/i.test(s) && Math.abs(it.transform[4] - 255) < 35;
        });

        // Sort divider Y coordinates descending to divide page into horizontal bands
        const divYs = dividers.map(d => d.transform[5]).sort((a, b) => b - a);
        const yBounds = [Infinity, ...divYs, -Infinity];

        const xs = body.map(it => it.transform[4]).filter(x => x > 50 && x < 550);
        const leftCount = xs.filter(x => x < 280).length;
        const rightCount = xs.filter(x => x >= 280).length;
        const isTwoCol = leftCount >= 10 && rightCount >= 10;

        // Dynamic gutter detection: find gap between left column and right column around page center (275-310)
        let dynamicGutter = 285;
        if (isTwoCol) {
            const midXs = xs.filter(x => x >= 275 && x <= 310).sort((a, b) => a - b);
            let maxGap = 0;
            let gapMid = 285;
            for (let i = 0; i < midXs.length - 1; i++) {
                const gap = midXs[i + 1] - midXs[i];
                if (gap > maxGap && gap >= 10) {
                    maxGap = gap;
                    gapMid = (midXs[i] + midXs[i + 1]) / 2;
                }
            }
            if (maxGap >= 12) {
                dynamicGutter = gapMid;
            }
        }

        const resultColumns = [];
        for (let b = 0; b < yBounds.length - 1; b++) {
            const yTop = yBounds[b];
            const yBot = yBounds[b + 1];
            // Filter body items in this horizontal band (excluding the divider header itself)
            const bandItems = body.filter(it => it.transform[5] <= yTop && it.transform[5] > yBot && !dividers.includes(it));
            if (!bandItems.length) continue;

            if (isTwoCol) {
                const left = bandItems.filter(it => it.transform[4] < dynamicGutter);
                const right = bandItems.filter(it => it.transform[4] >= dynamicGutter);
                if (left.length) resultColumns.push(this.processColumnItems(left));
                if (right.length) resultColumns.push(this.processColumnItems(right));
            } else {
                resultColumns.push(this.processColumnItems(bandItems));
            }
        }

        return resultColumns.length > 0 ? resultColumns : [this.processColumnItems(body)];
    }

    /**
     * Parse multiple option formats (letters, numbers, parentheses, dots, horizontal layout)
     */
    static parseQuestionOptions(body, hasDiagram = false) {
        const structuredOptions = [];
        let questionText = body;

        // Priority 1: Parenthesized letters (A), (B), (C), (D), (E)
        const parenLetterRegex = /(?<=\s|^|[a-z])\(([A-E])\)\s*/gi;
        let matches = [...body.matchAll(parenLetterRegex)];
        if (matches.length >= 2) {
            matches = this.filterMonotonicOptions(matches, body);
        }

        // Priority 2: Parenthesized numbers (1), (2), (3), (4), (5)
        if (matches.length < 2) {
            const parenNumRegex = /(?<=\s|^)\(([1-5])\)/g;
            matches = [...body.matchAll(parenNumRegex)];
            if (matches.length >= 2) {
                matches = this.filterMonotonicOptions(matches, body);
            }
        }

        // Priority 3: A), B), C), D), E) or 1), 2), 3), 4), 5)
        if (matches.length < 2) {
            const parenCloseRegex = /(?<=\s|^)([1-5A-E])\)\s*/gi;
            matches = [...body.matchAll(parenCloseRegex)];
        }

        // Priority 4: Dot options A.-E. or 1.-5.
        if (matches.length < 2) {
            const dotRegex = /(?<=\s|^)([1-5A-E])[\.\)](?!\d)/g;
            matches = [...body.matchAll(dotRegex)];
        }

        // Priority 5: Lowercase (a)-(e)
        if (matches.length < 2) {
            const lowerRegex = /(?<=\s|^)\(([a-e])\)\s*/g;
            matches = [...body.matchAll(lowerRegex)];
        }

        if (matches.length >= 2) {
            questionText = body.substring(0, matches[0].index).trim();
            for (let i = 0; i < matches.length; i++) {
                const start = matches[i].index + matches[i][0].length;
                const end = (i + 1 < matches.length) ? matches[i + 1].index : body.length;
                let optText = body.substring(start, end).trim();

                // If option text is empty, consists only of watermark banner, or has diagram
                let isDiagOpt = false;
                if (!optText || /^(?:PYQ\s*HUB|MATH\s*Statement|PHYSICS\s*CHEMISTRY|COMPLETE\s*SHIFT|MATH\s+PHYSICS\s+CHEMISTRY)$/i.test(optText) || /(?:MATH\s+PHYSICS\s+CHEMISTRY)/i.test(optText)) {
                    optText = "[Diagram / Structure in source PDF]";
                    isDiagOpt = true;
                } else if (!optText && hasDiagram) {
                    optText = "[Diagram / Structure in source PDF]";
                    isDiagOpt = true;
                } else if ((optText || "").includes("[Diagram / Structure")) {
                    isDiagOpt = true;
                }

                const rawLabel = String(matches[i][1]).toUpperCase();

                let normId = rawLabel;
                if (rawLabel === "A") normId = "1";
                else if (rawLabel === "B") normId = "2";
                else if (rawLabel === "C") normId = "3";
                else if (rawLabel === "D") normId = "4";
                else if (rawLabel === "E") normId = "5";

                structuredOptions.push({
                    id: normId,
                    label: rawLabel,
                    text: optText,
                    isDiagramOption: isDiagOpt,
                    hasDiagram: isDiagOpt
                });
            }
        }

        return { questionText, options: structuredOptions };
    }

    /**
     * Parse and normalize questions from Question Paper PDF buffer
     */
    static async extractAndNormalizeQuestions({
        pdfBuffer,
        examId = "neet-ug",
        year = 2024,
        paperCode = "Q1",
        language = "en",
        pattern = null
    }) {
        if (!Buffer.isBuffer(pdfBuffer)) {
            throw new Error("Invalid Question Paper PDF buffer provided");
        }

        const rawPages = [];
        const options = {
            version: "v2.0.550",
            pagerender: (pageData) => {
                return pageData.getTextContent().then((textContent) => {
                    const pageNum = pageData.pageIndex + 1;
                    const renderedColumns = this.spatialRenderPage(textContent.items);
                    const pageText = renderedColumns.join("\n\n");
                    rawPages.push({
                        pageNum,
                        text: pageText,
                        renderedColumns
                    });
                    return pageText;
                });
            }
        };

        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Question extraction from PDF timed out (exceeded 30s)")), 30000);
        });
        const cleanBuffer = new Uint8Array(pdfBuffer);
        const parsed = await Promise.race([pdfParse(cleanBuffer, options), timeoutPromise]).finally(() => clearTimeout(timer));
        if (parsed.numpages > 100) {
            throw new Error(`Question paper exceeds maximum supported limit of 100 pages (detected ${parsed.numpages})`);
        }

        const cleanExam = (examId || "neet-ug").toLowerCase().trim();
        const cleanPaperCode = (paperCode || "Q1").toUpperCase().trim();

        // Detect bilingual pages (e.g. Hindi/English interleaved like BPSC)
        let hasHindiPages = false;
        let hasEnglishPages = false;
        for (const p of rawPages) {
            const sc = this.scoreLanguage(p.text);
            if (sc.hindi > 20) hasHindiPages = true;
            if (sc.english > 20) hasEnglishPages = true;
        }
        const isBilingual = hasHindiPages && hasEnglishPages;

        let selectedPages = [];
        for (const p of rawPages) {
            if (this.isInstructionOrRoughPage(p.text)) continue;
            if (isBilingual) {
                const sc = this.scoreLanguage(p.text);
                if (language === "hi") {
                    if (sc.hindi >= sc.english) selectedPages.push(p);
                } else {
                    if (sc.english > sc.hindi && sc.english >= 5) selectedPages.push(p);
                }
            } else {
                selectedPages.push(p);
            }
        }
        if (selectedPages.length === 0) {
            selectedPages = rawPages;
        }

        const pageColumns = [];
        selectedPages.forEach(p => {
            p.renderedColumns.forEach((colText, colIdx) => {
                pageColumns.push({
                    pageNum: p.pageNum,
                    colIndex: colIdx + 1,
                    text: colText
                });
            });
        });

        // Extract diagrams and figures in parallel from PDF buffer
        let extractedDiagrams = [];
        try {
            extractedDiagrams = await DiagramExtractionService.extractDiagrams({
                pdfBuffer,
                jobId: `${cleanExam}_${year}_${cleanPaperCode}`
            });
        } catch (diagErr) {
            console.warn("[QuestionNormalizationService] Diagram extraction notice:", diagErr.message);
        }

        // Join document columns in natural reading order
        const fullDocumentStream = pageColumns.map(c => c.text).join("\n\n");

        // Detect if document predominantly uses explicit 'Q' or 'Question' prefixes
        const qPrefixCount = (fullDocumentStream.match(/(?:^|\n)\s*Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d{1,3}/gi) || []).length;
        const usesExplicitQPrefix = qPrefixCount >= 5;

        const rawQuestions = [];
        let currentQ = null;
        let expectedNextQNum = 1;
        const numberingRestarts = Boolean(pattern?.numberingRestartsPerSection);
        const sections = Array.isArray(pattern?.sections) ? pattern.sections : [];
        let currentSectionIndex = 0;

        for (const page of selectedPages) {
            const cleanedText = page.text
                .replace(/19–C\/FI\/CC\/PT–2023\/201-A[^\n]*/g, "")
                .replace(/(?:^|\n)[ \t]*\d{1,2}[ \t]*\[[ \t]*P\.T\.O\.[ \t]*/gi, "\n")
                .trim();
            const lines = cleanedText.split("\n");

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                // If numbering restarts per section, check if this line is a section heading
                if (numberingRestarts && sections.length > 0) {
                    const secMatchIdx = sections.findIndex((s, idx) => {
                        if (idx <= currentSectionIndex && currentQ) return false;
                        const sName = (s.name || "").toLowerCase();
                        const sSub = (s.subject || "").toLowerCase();
                        const lLow = trimmed.toLowerCase();
                        return (sName && lLow.includes(sName)) || (sSub && lLow.includes(sSub));
                    });
                    if (secMatchIdx > currentSectionIndex) {
                        currentSectionIndex = secMatchIdx;
                        expectedNextQNum = 1;
                    }
                }

                const headerMatch = /^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})|(\d{1,3})\s*[\.\)])\s*(?=\S)/i.exec(trimmed);
                const isExplicitQ = Boolean(headerMatch && headerMatch[1]);
                const candidateNum = headerMatch ? parseInt(headerMatch[1] || headerMatch[2], 10) : null;

                let isNewQuestion = false;

                if (headerMatch && candidateNum && candidateNum > 0 && candidateNum <= 300) {
                    const bodyPreview = trimmed.replace(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d+|^\d+\s*[\.\)])[\s:\-]*/i, "").trim();
                    const isUnit = /^(?:kg|g|m|cm|mm|m\/s|km\/h|ohms?|v|volts?|hz|j|joules?|w|watts?|days?|years?|months?)\b/i.test(bodyPreview);
                    const isHeaderNoise = /^(?:Booklet|Paper)\s+Code/i.test(trimmed) || /^\|\s*Duration/i.test(bodyPreview);

                    if (!isUnit && !isHeaderNoise) {
                        if (isExplicitQ) {
                            isNewQuestion = true;
                        } else if (expectedNextQNum === 1 && candidateNum === 1) {
                            isNewQuestion = true;
                        } else if (numberingRestarts && candidateNum === 1 && currentQ !== null) {
                            isNewQuestion = true;
                        } else if (candidateNum === expectedNextQNum || (currentQ && candidateNum > currentQ.questionNumber && candidateNum <= currentQ.questionNumber + 2)) {
                            if (!currentQ) {
                                isNewQuestion = true;
                            } else {
                                const isCurrentNumerical = this.isNumericalQuestionNumber({
                                    candidateNum: currentQ.questionNumber,
                                    cleanExam,
                                    pattern
                                });
                                if (isCurrentNumerical) {
                                    isNewQuestion = true;
                                } else {
                                    const accumText = currentQ.rawLines.join("\n");
                                    const hasA = /\([A-E1-5]\)|[A-E1-5]\)/i.test(accumText);
                                    const hasB = /\([B-E2-5]\)|[B-E2-5]\)/i.test(accumText);
                                    if (hasA && hasB) {
                                        isNewQuestion = true;
                                    } else {
                                        // Internal statement
                                        isNewQuestion = false;
                                    }
                                }
                            }
                        }
                    }
                }

                if (isNewQuestion) {
                    if (currentQ) {
                        rawQuestions.push(currentQ);
                    }
                    if (numberingRestarts && currentQ && (candidateNum === 1 || candidateNum < currentQ.questionNumber)) {
                        currentSectionIndex = Math.min(currentSectionIndex + 1, Math.max(sections.length - 1, 0));
                    }
                    const activeSection = sections[currentSectionIndex] || null;
                    const stemStart = trimmed.replace(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d+|^\d+\s*[\.\)])[\s:\-]*/i, "").trim();
                    currentQ = {
                        questionNumber: candidateNum,
                        sourcePage: page.pageNum,
                        rawLines: [stemStart],
                        sectionId: activeSection ? activeSection.id : null,
                        subject: activeSection ? activeSection.subject : null
                    };
                    expectedNextQNum = candidateNum + 1;
                } else if (currentQ) {
                    currentQ.rawLines.push(trimmed);
                }
            }
        }
        if (currentQ) {
            rawQuestions.push(currentQ);
        }

        // Deduplicate and resolve by question number
        const questionMap = new Map();
        for (const q of rawQuestions) {
            const key = numberingRestarts && q.sectionId ? `${q.sectionId}_${q.questionNumber}` : q.questionNumber;
            if (!questionMap.has(key)) {
                questionMap.set(key, q);
            }
        }

        const sortedRaw = Array.from(questionMap.values()).sort((a, b) => {
            if (numberingRestarts && a.sectionId && b.sectionId && a.sectionId !== b.sectionId) {
                const idxA = sections.findIndex(s => s.id === a.sectionId);
                const idxB = sections.findIndex(s => s.id === b.sectionId);
                if (idxA !== -1 && idxB !== -1) return idxA - idxB;
            }
            return a.questionNumber - b.questionNumber;
        });
        const processedQuestions = [];

        for (const raw of sortedRaw) {
            const fullBody = raw.rawLines.join("\n");
            const hasDiagram = /\b(?:figure|fig\.?|diagram|shown in figure|as shown below|circuit diagram|refer to figure|graph|given figure|structure of|reaction sequence|shown)\b/i.test(fullBody);

            const isNumerical = this.isNumericalQuestionNumber({
                candidateNum: raw.questionNumber,
                cleanExam,
                pattern
            });

            let structuredOptions = [];
            let questionText = fullBody;

            if (!isNumerical) {
                const parsedOptResult = this.parseQuestionOptions(fullBody, hasDiagram);
                structuredOptions = parsedOptResult.options;
                questionText = parsedOptResult.questionText;
            }

            let questionType = isNumerical ? "numerical" : "mcq";
            if (!isNumerical && structuredOptions.length === 0) {
                const isNatStem = /\b(?:numerical|integer|find the value|calculate|nearest integer|magnitude of|is equal to\s*_{1,}|value of|number of|in\s*(?:ohms?|kg|m\/s|joules?|j|w|watts?|v|volts?|a|amperes?|hz|sec|seconds?|k|kelvin|mol|mole|moles?)\b|determine\b|evaluate\b|how many\b)/i.test(questionText) ||
                    /_{2,}|\[\s*\]/.test(questionText);
                if (isNatStem) {
                    questionType = "numerical";
                }
            } else if (/assertion\s*(?:\(A\)|:)|reason\s*(?:\(R\)|:)/i.test(questionText)) {
                questionType = "assertion_reason";
            } else if (/match\s+(?:the\s+)?following|list\s*-\s*i|column\s*-\s*i/i.test(questionText)) {
                questionType = "match_following";
            } else if (/\b(?:one or more (?:than one )?(?:correct|options?)|multiple correct)\b/i.test(questionText)) {
                questionType = "msq";
            }

            processedQuestions.push({
                questionNumber: raw.questionNumber,
                questionText,
                options: structuredOptions,
                questionType,
                pageNumber: raw.sourcePage,
                hasDiagram,
                sectionId: raw.sectionId || null,
                subject: raw.subject || null
            });
        }
        const normalizedQuestions = [];

        // Map into universal schema and apply pattern sections
        for (const raw of processedQuestions) {
            const qNum = raw.questionNumber;
            const qNumPad = String(qNum).padStart(3, "0");
            let questionId = `${cleanExam}-${year}-${cleanPaperCode}-${qNumPad}`;

            // Determine Subject and Section from Pattern if available
            let subject = raw.subject || "General";
            let sectionId = raw.sectionId || "general";

            if (numberingRestarts && raw.sectionId) {
                questionId = `${cleanExam}-${year}-${cleanPaperCode}-${raw.sectionId}-q${qNumPad}`;
                sectionId = raw.sectionId;
                subject = raw.subject || subject;
            } else if (pattern && Array.isArray(pattern.sections)) {
                const matchedSec = pattern.sections.find(s => qNum >= s.startQuestion && qNum <= s.endQuestion);
                if (matchedSec) {
                    subject = matchedSec.subject;
                    sectionId = matchedSec.id;
                }
            } else if (cleanExam.includes("jee")) {
                // Standard JEE Main boundaries: 1-25 Math, 26-50 Physics, 51-75 Chem
                if (qNum <= 20) { subject = "Mathematics"; sectionId = "math_a"; }
                else if (qNum <= 25) { subject = "Mathematics"; sectionId = "math_b"; }
                else if (qNum <= 45) { subject = "Physics"; sectionId = "physics_a"; }
                else if (qNum <= 50) { subject = "Physics"; sectionId = "physics_b"; }
                else if (qNum <= 70) { subject = "Chemistry"; sectionId = "chemistry_a"; }
                else { subject = "Chemistry"; sectionId = "chemistry_b"; }
            } else if (cleanExam.includes("bpsc") || cleanExam.includes("upsc")) {
                subject = "General Studies";
                sectionId = "general_studies";
            } else {
                // NEET Standard subject boundaries
                if (qNum <= 50) subject = "Physics";
                else if (qNum <= 100) subject = "Chemistry";
                else if (qNum <= 150) subject = "Botany";
                else if (qNum <= 200) subject = "Zoology";
            }

            // Normalize subject into canonical identifier and display name
            const normSubject = SubjectNormalizationService.normalizeSubject(subject);

            // Quality & fidelity checks: Detect formula corruption, distorted expressions, leaked banners
            const fidelity = QuestionNormalizationService.evaluateQuestionFidelity({
                questionText: raw.questionText,
                options: raw.options,
                questionType: raw.questionType,
                hasDiagram: raw.hasDiagram
            });

            const validationStatus = fidelity.validationStatus;
            const flagReason = fidelity.flagReason;

            const media = raw.hasDiagram
                ? [{ type: "diagram_reference", page: raw.pageNumber }]
                : (validationStatus === "flagged"
                    ? [{ type: "source_page_evidence", page: raw.pageNumber, note: "Compare formula with original PDF source page." }]
                    : []);

            normalizedQuestions.push({
                questionId,
                examId: cleanExam,
                year: Number(year),
                paperCode: cleanPaperCode,
                questionNumber: qNum,
                originalNumbering: String(qNum),
                subject: normSubject.subjectName,
                subjectId: normSubject.subjectId,
                subjectName: normSubject.subjectName,
                sectionId,
                topic: raw.topic || "",
                questionType: raw.questionType,
                language,
                questionText: raw.questionText,
                options: raw.options,
                hasDiagram: raw.hasDiagram,
                media,
                sourcePage: raw.pageNumber,
                validationStatus,
                flagReason,
                schemaVersion: 1,
                extractedAt: new Date().toISOString()
            });
        }

        // Associate extracted diagram assets and bounding boxes with normalized questions
        const enrichedQuestions = DiagramExtractionService.associateDiagramsWithQuestions({
            questions: normalizedQuestions,
            diagrams: extractedDiagrams,
            jobId: `${cleanExam}_${year}_${cleanPaperCode}`
        });

        return {
            totalExtracted: enrichedQuestions.length,
            questions: enrichedQuestions,
            numPages: parsed.numpages,
            diagrams: extractedDiagrams
        };
    }
}
