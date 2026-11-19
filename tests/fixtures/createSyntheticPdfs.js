import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = __dirname;

/**
 * Builds a valid, spec-compliant PDF buffer with dynamically calculated byte offsets and xref table
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
 * Generate NEET UG 2024 synthetic fixtures
 */
export function generateNeetUgFixtures() {
    if (!fs.existsSync(FIXTURES_DIR)) {
        fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    }

    // 1. Question Paper PDF text (NEET UG 2024 Code Q1)
    const qpLines = [
        "NATIONAL ELIGIBILITY CUM ENTRANCE TEST NEET (UG) - 2024",
        "Booklet Code: Q1 | Duration: 3 Hours 20 Minutes (200 Minutes)",
        "Maximum Marks: 720 | Four marks (+4) for each correct, minus one (-1) for incorrect",
        "PHYSICS - SECTION A",
        "Q1. A particle of mass 2 kg moves with velocity v = 10 m/s. Calculate kinetic energy.",
        "(1) 50 J",
        "(2) 100 J",
        "(3) 150 J",
        "(4) 200 J",
        "Q2. The dimensional formula of Planck's constant is:",
        "(1) [M L^2 T^-1]",
        "(2) [M L T^-1]",
        "(3) [M L^2 T^-2]",
        "(4) [M L^-1 T^-2]",
        "Q3. In the circuit diagram shown in figure below, the equivalent resistance is:",
        "(1) 2 ohms",
        "(2) 4 ohms",
        "(3) 6 ohms",
        "(4) 8 ohms",
        "Q4. Which of the following statements is true for isothermal process?",
        "(1) Temperature changes",
        "(2) Temperature remains constant",
        "(3) Heat exchange is zero",
        "(4) Internal energy remains constant",
        "Q5. An open organ pipe of length L resonates with fundamental frequency.",
        "(1) v / 2L",
        "(2) v / 4L",
        "(3) 2v / L",
        "(4) 3v / 2L"
    ];
    const qpBuffer = buildSimplePdf(qpLines.join("\n"));
    fs.writeFileSync(path.join(FIXTURES_DIR, "synthetic_neet_2024_qp.pdf"), qpBuffer);

    // 2. Official Answer Key PDF text (NEET UG 2024 Code Q1 Final Answer Key)
    const akLines = [
        "NATIONAL TESTING AGENCY - NEET (UG) 2024 FINAL ANSWER KEY",
        "Booklet Code: Q1 | Exam Date: 05 May 2024",
        "Q.No.  Answer Key",
        "1   2",
        "2   1",
        "3   4",
        "4   2 or 4",
        "5   Dropped"
    ];
    const akBuffer = buildSimplePdf(akLines.join("\n"));
    fs.writeFileSync(path.join(FIXTURES_DIR, "synthetic_neet_2024_ak.pdf"), akBuffer);

    // 3. Official Exam Pattern Document PDF text (NEET UG 2024 Information Bulletin)
    const epLines = [
        "NATIONAL ELIGIBILITY CUM ENTRANCE TEST (UG) 2024 INFORMATION BULLETIN",
        "CHAPTER 3: EXAMINATION SCHEME & PATTERN",
        "Total Questions: 5 | Maximum Marks: 20",
        "Duration of Test: 200 Minutes (03 Hours 20 Minutes)",
        "Marking Scheme: Correct +4, Incorrect -1, Unanswered 0",
        "Sections: Physics (Section A: 35, Section B: 15), Chemistry (Section A: 35, Section B: 15),",
        "Botany (Section A: 35, Section B: 15), Zoology (Section A: 35, Section B: 15)",
        "Candidates have to attempt 10 questions out of 15 in Section B."
    ];
    const epBuffer = buildSimplePdf(epLines.join("\n"));
    fs.writeFileSync(path.join(FIXTURES_DIR, "synthetic_neet_2024_pattern.pdf"), epBuffer);

    // 4. Mismatched Booklet Code Answer Key (Code R1 instead of Q1)
    const mismatchedAkLines = [
        "NATIONAL TESTING AGENCY - NEET (UG) 2024 FINAL ANSWER KEY",
        "Booklet Code: R1",
        "Q.No.  Answer Key",
        "1   3",
        "2   2",
        "3   1"
    ];
    fs.writeFileSync(path.join(FIXTURES_DIR, "synthetic_mismatched_ak.pdf"), buildSimplePdf(mismatchedAkLines.join("\n")));

    // 5. Incomplete / Missing Answers Key (Leaves Q5 missing)
    const missingAkLines = [
        "NATIONAL TESTING AGENCY - NEET (UG) 2024 FINAL ANSWER KEY",
        "Booklet Code: Q1",
        "Q.No.  Answer Key",
        "1   2",
        "2   1",
        "3   4",
        "4   2 or 4"
        // Q5 is intentionally omitted!
    ];
    fs.writeFileSync(path.join(FIXTURES_DIR, "synthetic_missing_answers_ak.pdf"), buildSimplePdf(missingAkLines.join("\n")));

    return {
        qpPath: path.join(FIXTURES_DIR, "synthetic_neet_2024_qp.pdf"),
        akPath: path.join(FIXTURES_DIR, "synthetic_neet_2024_ak.pdf"),
        patternPath: path.join(FIXTURES_DIR, "synthetic_neet_2024_pattern.pdf"),
        mismatchedAkPath: path.join(FIXTURES_DIR, "synthetic_mismatched_ak.pdf"),
        missingAkPath: path.join(FIXTURES_DIR, "synthetic_missing_answers_ak.pdf")
    };
}
