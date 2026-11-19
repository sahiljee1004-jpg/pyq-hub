import fs from "node:fs";
import path from "node:path";

/**
 * Builds a valid, spec-compliant single-page PDF buffer with dynamically calculated byte offsets
 */
export function buildSimplePdf(textContent) {
    const lines = textContent.split("\n");
    const streamCommands = [
        "BT",
        "/F1 10 Tf"
    ];
    lines.forEach((line, idx) => {
        const y = 750 - idx * 16;
        const escaped = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
        streamCommands.push(`1 0 0 1 50 ${y} Tm (${escaped}) Tj`);
    });
    streamCommands.push("ET");
    const streamContent = streamCommands.join("\n") + "\n";
    const streamLength = Buffer.byteLength(streamContent, "utf8");

    const header = "%PDF-1.4\n";
    const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
    const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
    const obj3 = "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n";
    const obj4 = "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
    const obj5 = `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}endstream\nendobj\n`;

    const offset1 = Buffer.byteLength(header, "utf8");
    const offset2 = offset1 + Buffer.byteLength(obj1, "utf8");
    const offset3 = offset2 + Buffer.byteLength(obj2, "utf8");
    const offset4 = offset3 + Buffer.byteLength(obj3, "utf8");
    const offset5 = offset4 + Buffer.byteLength(obj4, "utf8");
    const xrefOffset = offset5 + Buffer.byteLength(obj5, "utf8");

    function padOffset(num) {
        return String(num).padStart(10, "0");
    }

    const xref = [
        "xref",
        "0 6",
        "0000000000 65535 f ",
        `${padOffset(offset1)} 00000 n `,
        `${padOffset(offset2)} 00000 n `,
        `${padOffset(offset3)} 00000 n `,
        `${padOffset(offset4)} 00000 n `,
        `${padOffset(offset5)} 00000 n `,
        "trailer",
        "<< /Size 6 /Root 1 0 R >>",
        "startxref",
        String(xrefOffset),
        "%%EOF\n"
    ].join("\n");

    const fullPdf = header + obj1 + obj2 + obj3 + obj4 + obj5 + xref;
    return Buffer.from(fullPdf, "utf8");
}

/**
 * Builds a valid multi-page PDF buffer
 */
export function buildMultiPagePdf(pagesContentArray) {
    if (!pagesContentArray || pagesContentArray.length === 0) {
        return buildSimplePdf("");
    }
    if (pagesContentArray.length === 1) {
        return buildSimplePdf(pagesContentArray[0]);
    }

    const pageCount = pagesContentArray.length;
    const header = "%PDF-1.4\n";
    const objects = [];
    const offsets = [];

    // Obj 1: Catalog
    objects.push({ num: 1, text: "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" });

    // Obj 2: Pages (will list kids [3 0 R, 5 0 R, 7 0 R, ...])
    const kids = [];
    let curObjNum = 3;
    for (let i = 0; i < pageCount; i++) {
        kids.push(`${curObjNum} 0 R`);
        curObjNum += 2; // Each page uses 1 Page obj + 1 Contents obj
    }
    const fontObjNum = curObjNum;
    objects.push({
        num: 2,
        text: `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>\nendobj\n`
    });

    curObjNum = 3;
    for (let i = 0; i < pageCount; i++) {
        const pageObjNum = curObjNum;
        const streamObjNum = curObjNum + 1;
        curObjNum += 2;

        const lines = pagesContentArray[i].split("\n");
        const streamCmds = ["BT", "/F1 10 Tf"];
        lines.forEach((line, idx) => {
            const y = 750 - idx * 16;
            const escaped = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
            streamCmds.push(`1 0 0 1 50 ${y} Tm (${escaped}) Tj`);
        });
        streamCmds.push("ET");
        const streamContent = streamCmds.join("\n") + "\n";
        const streamLen = Buffer.byteLength(streamContent, "utf8");

        objects.push({
            num: pageObjNum,
            text: `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${streamObjNum} 0 R >>\nendobj\n`
        });
        objects.push({
            num: streamObjNum,
            text: `${streamObjNum} 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}endstream\nendobj\n`
        });
    }

    // Font Obj
    objects.push({
        num: fontObjNum,
        text: `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`
    });

    // Assemble PDF and calculate byte offsets
    let currentOffset = Buffer.byteLength(header, "utf8");
    const xrefEntries = [`0000000000 65535 f `];

    // Sort objects by object number
    objects.sort((a, b) => a.num - b.num);

    let pdfBody = "";
    for (const obj of objects) {
        offsets[obj.num] = currentOffset;
        xrefEntries[obj.num] = String(currentOffset).padStart(10, "0") + " 00000 n ";
        pdfBody += obj.text;
        currentOffset += Buffer.byteLength(obj.text, "utf8");
    }

    const xrefOffset = currentOffset;
    const totalObjs = objects.length + 1;
    const xref = [
        "xref",
        `0 ${totalObjs}`,
        ...xrefEntries,
        "trailer",
        `<< /Size ${totalObjs} /Root 1 0 R >>`,
        "startxref",
        String(xrefOffset),
        "%%EOF\n"
    ].join("\n");

    return Buffer.from(header + pdfBody + xref, "utf8");
}

/**
 * 8 Canonical Test Scenarios for Universal Document Ingestion Engine
 */
export const SyntheticExamFixtures = {

    /**
     * Scenario 1: Conventional MCQ Exam
     * Single section, standard A..D options, clean sequential keys, full format rules.
     */
    scenario1_conventionalMcq() {
        const qpText = [
            "CIVIL SERVICES PRELIMINARY EXAMINATION 2024 - GENERAL STUDIES",
            "Duration: 2 Hours (120 Minutes) | Maximum Marks: 200",
            "Q. 1 What is the primary function of the Reserve Bank of India?",
            "(A) Direct taxation collection",
            "(B) Monetary policy formulation",
            "(C) Railway budget allocation",
            "(D) Judicial arbitration",
            "Q. 2 Which Indian river does not flow into the Arabian Sea?",
            "(A) Narmada",
            "(B) Tapi",
            "(C) Godavari",
            "(D) Mandovi",
            "Q. 3 Which article of the Constitution relates to the Finance Commission?",
            "(A) Article 280",
            "(B) Article 324",
            "(C) Article 356",
            "(D) Article 370"
        ].join("\n");

        const akText = [
            "CIVIL SERVICES PRELIMINARY EXAMINATION 2024",
            "FINAL ANSWER KEY - PAPER CODE: A",
            "Q.No.  Answer Key",
            "1   B",
            "2   C",
            "3   A"
        ].join("\n");

        const pfText = [
            "CIVIL SERVICES PRELIMINARY EXAMINATION 2024 NOTIFICATION",
            "Duration of Test: 120 Minutes",
            "Total Questions: 3 | Maximum Marks: 200",
            "Marking Scheme: 2 marks for each correct, deduct 0.66 marks for incorrect, 0 marks for unattempted."
        ].join("\n");

        return {
            scenarioName: "Scenario 1: Conventional MCQ Exam",
            questionPaper: buildSimplePdf(qpText),
            answerKey: buildSimplePdf(akText),
            paperFormat: buildSimplePdf(pfText)
        };
    },

    /**
     * Scenario 2: Multiple Sections with Different Marking Rules
     * Section A: General Intelligence (+1 / -0.25)
     * Section B: Quantitative Aptitude (+2 / -0.5)
     */
    scenario2_multiSectionDifferentMarking() {
        const qpText = [
            "STAFF SELECTION COMBINED EXAMINATION 2024",
            "Duration: 60 Minutes | Maximum Marks: 50",
            "SECTION A: GENERAL INTELLIGENCE",
            "Q. 1 Find the next number in sequence: 2, 4, 8, 16, ...",
            "(A) 24",
            "(B) 32",
            "(C) 64",
            "(D) 20",
            "Q. 2 Choose the odd one out from given choices:",
            "(A) Circle",
            "(B) Sphere",
            "(C) Square",
            "(D) Triangle",
            "SECTION B: QUANTITATIVE APTITUDE",
            "Q. 3 Calculate the compound interest on Rs 1000 at 10% for 2 years:",
            "(A) Rs 200",
            "(B) Rs 210",
            "(C) Rs 220",
            "(D) Rs 250",
            "Q. 4 A train travels 300 km in 5 hours. Find speed:",
            "(A) 50 km/h",
            "(B) 60 km/h",
            "(C) 70 km/h",
            "(D) 80 km/h"
        ].join("\n");

        const akText = [
            "COMBINED EXAMINATION 2024 OFFICIAL ANSWER KEY",
            "Booklet Series: B",
            "1   B",
            "2   B",
            "3   B",
            "4   B"
        ].join("\n");

        const pfText = [
            "EXAMINATION SCHEME & PATTERN NOTIFICATION 2024",
            "Total Questions: 4 | Maximum Marks: 50 | Duration: 60 Minutes",
            "Section A: 2 questions. Marking: Correct +1 mark, Incorrect -0.25 mark",
            "Section B: 2 questions. Marking: Correct +2 marks, Incorrect -0.5 mark"
        ].join("\n");

        return {
            scenarioName: "Scenario 2: Multi-Section with Distinct Marking Schemes",
            questionPaper: buildSimplePdf(qpText),
            answerKey: buildSimplePdf(akText),
            paperFormat: buildSimplePdf(pfText)
        };
    },

    /**
     * Scenario 3: Optional Questions ("attempt any 5 of 10")
     */
    scenario3_optionalQuestions() {
        const qpLines = [
            "STATE PUBLIC ENTRANCE EXAMINATION 2024",
            "Duration: 180 Minutes | Maximum Marks: 100",
            "SECTION A: COMPULSORY",
            "1. Define the unit of magnetic flux density.",
            "(A) Weber",
            "(B) Tesla",
            "(C) Henry",
            "(D) Gauss",
            "SECTION B: OPTIONAL QUESTIONS",
            "Candidates have to attempt 5 questions out of 10 in Section B."
        ];
        // Questions 2 through 11 in Section B
        for (let i = 2; i <= 11; i++) {
            qpLines.push(`Q. ${i} Analysis problem ${i} regarding equilibrium:`);
            qpLines.push("(A) Minimum potential energy");
            qpLines.push("(B) Maximum potential energy");
            qpLines.push("(C) Zero kinetic energy");
            qpLines.push("(D) Constant momentum");
        }

        const akLines = [
            "PUBLIC ENTRANCE EXAMINATION 2024 OFFICIAL KEY",
            "Q.No. Key"
        ];
        for (let i = 1; i <= 11; i++) {
            akLines.push(`${i}   A`);
        }

        const pfText = [
            "PUBLIC ENTRANCE EXAMINATION 2024 NOTIFICATION",
            "Total Questions: 11 | Duration: 180 Minutes",
            "Candidates have to attempt 5 questions out of 10 in Section B.",
            "Marking: Correct +4, Incorrect -1, Unanswered 0"
        ].join("\n");

        return {
            scenarioName: "Scenario 3: Optional Questions Policy",
            questionPaper: buildSimplePdf(qpLines.join("\n")),
            answerKey: buildSimplePdf(akLines.join("\n")),
            paperFormat: buildSimplePdf(pfText)
        };
    },

    /**
     * Scenario 4: Numerical / NAT Questions with Ranges
     */
    scenario4_numericalWithRanges() {
        const qpText = [
            "GRADUATE APTITUDE TEST IN ENGINEERING 2024",
            "Duration: 180 Minutes | Maximum Marks: 100",
            "Q. 1 A block of mass 5 kg slides down an incline of 30 degrees. Calculate acceleration in m/s^2. Enter the numerical value.",
            "Q. 2 Find the value of resistance R in ohms such that maximum power is transferred in the circuit.",
            "Q. 3 Compute the efficiency of the Carnot engine operating between 600 K and 300 K. Enter numerical answer in percentage."
        ].join("\n");

        const akText = [
            "GATE 2024 FINAL ANSWER KEY",
            "Q.No.  Accepted Key / Range",
            "1   [4.8, 5.0]",
            "2   12.5 +/- 0.5",
            "3   50"
        ].join("\n");

        const pfText = [
            "GATE 2024 INFORMATION BROCHURE",
            "Total Questions: 3 | Maximum Marks: 100 | Duration: 180 Minutes",
            "Questions comprise Numerical Answer Type (NAT).",
            "For NAT questions, candidates must enter a numerical value or range.",
            "Marking: Correct +2, There is no negative marking for numerical questions."
        ].join("\n");

        return {
            scenarioName: "Scenario 4: Numerical / NAT with Ranges",
            questionPaper: buildSimplePdf(qpText),
            answerKey: buildSimplePdf(akText),
            paperFormat: buildSimplePdf(pfText)
        };
    },

    /**
     * Scenario 5: Scanned Question Paper (OCR Detection)
     * Question paper has minimal text (< 50 chars), triggering scan detection.
     */
    scenario5_scannedQuestionPaper() {
        // Scanned paper with minimal unreadable / image raster representation
        const qpText = "Page 1"; // < 50 characters!
        const akText = [
            "ANSWER KEY 2024",
            "1   A",
            "2   B"
        ].join("\n");
        const pfText = [
            "EXAMINATION SYLLABUS 2024",
            "Total Questions: 2 | Duration: 60 Minutes",
            "Marking: Correct +1, Incorrect -0.25"
        ].join("\n");

        return {
            scenarioName: "Scenario 5: Scanned Question Paper (OCR Gate)",
            questionPaper: buildSimplePdf(qpText),
            answerKey: buildSimplePdf(akText),
            paperFormat: buildSimplePdf(pfText)
        };
    },

    /**
     * Scenario 6: Paper Containing Tables and Diagrams
     */
    scenario6_tablesAndDiagrams() {
        const qpText = [
            "NATIONAL SCIENCE TALENT SEARCH 2024",
            "Duration: 90 Minutes | Maximum Marks: 60",
            "Q. 1 In the bridge circuit depicted in Figure 3 below, calculate the galvanometer current:",
            "(A) 0 mA",
            "(B) 5 mA",
            "(C) 10 mA",
            "(D) 15 mA",
            "Q. 2 Refer to the experimental data table shown below:",
            "| Trial | Pressure (atm) | Volume (L) |",
            "| 1 | 1.0 | 22.4 |",
            "| 2 | 2.0 | 11.2 |",
            "Identify the gas law obeyed by the system:",
            "(A) Boyle's Law",
            "(B) Charles's Law",
            "(C) Gay-Lussac's Law",
            "(D) Avogadro's Law"
        ].join("\n");

        const akText = [
            "SCIENCE TALENT SEARCH 2024 KEY",
            "1   A",
            "2   A"
        ].join("\n");

        const pfText = [
            "SCIENCE TALENT SEARCH NOTIFICATION",
            "Total Questions: 2 | Maximum Marks: 60 | Duration: 90 Minutes",
            "Marking: Correct +2, Incorrect 0"
        ].join("\n");

        return {
            scenarioName: "Scenario 6: Tables and Diagrams",
            questionPaper: buildSimplePdf(qpText),
            answerKey: buildSimplePdf(akText),
            paperFormat: buildSimplePdf(pfText)
        };
    },

    /**
     * Scenario 7: Answer Key with Deleted and Bonus Questions
     * Dropped questions, bonus marks awarded to all candidates.
     */
    scenario7_deletedAndBonusQuestions() {
        const qpText = [
            "CENTRAL TEACHER ELIGIBILITY TEST 2024",
            "Duration: 150 Minutes | Maximum Marks: 150",
            "Q. 1 Constructivist classroom emphasizes:",
            "(A) Active discovery",
            "(B) Rote memorization",
            "(C) Drill practice",
            "(D) Passive reception",
            "Q. 2 Ambiguous question with flawed Hindi and English translations:",
            "(A) Option 1",
            "(B) Option 2",
            "(C) Option 3",
            "(D) Option 4",
            "Q. 3 Out-of-syllabus curriculum item:",
            "(A) Choice A",
            "(B) Choice B",
            "(C) Choice C",
            "(D) Choice D"
        ].join("\n");

        const akText = [
            "CTET 2024 FINAL REVISED ANSWER KEY",
            "Q.No.  Key Status",
            "1   A",
            "2   Dropped",
            "3   Bonus"
        ].join("\n");

        const pfText = [
            "CTET 2024 INFORMATION BULLETIN",
            "Total Questions: 3 | Maximum Marks: 150 | Duration: 150 Minutes",
            "Marking: Correct +1, Incorrect 0",
            "In case of dropped questions, full marks (+1) will be awarded to all candidates."
        ].join("\n");

        return {
            scenarioName: "Scenario 7: Deleted and Bonus Questions",
            questionPaper: buildSimplePdf(qpText),
            answerKey: buildSimplePdf(akText),
            paperFormat: buildSimplePdf(pfText)
        };
    },

    /**
     * Scenario 8: Paper Format with Incomplete / Contradictory Rules
     * Missing negative marking (UNKNOWN).
     * Contradictory question counts (CONTRADICTORY).
     */
    scenario8_incompleteContradictoryRules() {
        const qpText = [
            "STATE ELIGIBILITY EXAM 2024",
            "Duration: 120 Minutes",
            "Q. 1 Which is the capital city of Rajasthan?",
            "(A) Jaipur",
            "(B) Jodhpur",
            "(C) Udaipur",
            "(D) Bikaner",
            "Q. 2 Which fort is known as Golden Fort?",
            "(A) Mehrangarh",
            "(B) Jaisalmer",
            "(C) Chittorgarh",
            "(D) Amber"
        ].join("\n");

        const akText = [
            "STATE ELIGIBILITY EXAM 2024 KEY",
            "1   A",
            "2   B"
        ].join("\n");

        // Format document has:
        // Contradictory question counts: "Total Questions: 100" AND "Total Questions: 90"
        // Missing negative marking rule (not mentioned at all)
        // Missing duration (not mentioned at all)
        const pfText = [
            "STATE ELIGIBILITY EXAM 2024 FORMAT BULLETIN",
            "Section I: General Studies",
            "Total Questions: 100",
            "Maximum Marks: 200",
            "Four marks (+4) for each correct answer.",
            "Appendix A: Examination Overview declares Total Questions: 90."
            // NOTE: Negative marking is completely omitted!
            // NOTE: Duration is completely omitted!
        ].join("\n");

        return {
            scenarioName: "Scenario 8: Incomplete & Contradictory Format Rules",
            questionPaper: buildSimplePdf(qpText),
            answerKey: buildSimplePdf(akText),
            paperFormat: buildSimplePdf(pfText)
        };
    }
};

