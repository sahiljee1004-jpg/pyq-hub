import fs from 'fs';
import { AnswerKeyParser } from '../server/services/ingestion/answerKeyParser.js';
import { UIRTransformationService } from '../server/services/uir/uirTransformationService.js';

function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function compareAnswers() {
    const qpBuf = fs.readFileSync('uploads/vault/1afd99f61ca04f63_1794777789438_SSC_CGL_23Sep2025_Shift1_Question_Paper.pdf');
    const akBuf = fs.readFileSync('uploads/vault/4a4cd10648fc9708_1794777789439_SSC_CGL_23Sep2025_Shift1_Answer_Key.pdf');
    const pfBuf = fs.readFileSync('uploads/vault/7cf77051cf5b231c_1794777790575_SSC_CGL_Exam_Pattern.pdf');

    // 1. Extract raw lines from Answer Key PDF
    const pages = await AnswerKeyParser.extractPagesFromPdf(akBuf);
    const rawAkEntries = [];

    for (const page of pages) {
        const lines = page.text.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            // Match tabular row: <QNum> <OptionNum 1..4> <Description>
            const m = line.match(/^(\d{1,3})\s+([1-4])\s*(.*)$/);
            if (m) {
                const qNum = parseInt(m[1], 10);
                const optNum = parseInt(m[2], 10);
                const optLetter = String.fromCharCode(64 + optNum);
                const desc = m[3].trim();
                rawAkEntries.push({
                    pageNumber: page.pageNumber,
                    rawLine: line,
                    questionNumber: qNum,
                    officialOptionNumber: optNum,
                    officialCorrectOption: optLetter,
                    officialDescriptionText: desc
                });
            }
        }
    }

    console.log(`Raw Answer Key lines parsed: ${rawAkEntries.length}`);

    // 2. Perform UIR Transformation
    const { uirDocument } = await UIRTransformationService.transformDocuments({
        questionPaper: qpBuf,
        answerKey: akBuf,
        paperFormat: pfBuf
    });

    const uirMap = new Map();
    for (const q of uirDocument.questions) {
        uirMap.set(q.questionNumber, q);
    }

    const comparisonRows = [];
    let allAnswersMatched = true;
    let allOptionTextsMatched = true;
    const unmatched = [];
    const ambiguous = [];
    const duplicates = [];
    const missing = [];

    // Check for duplicate Q numbers in AK
    const seenQNums = new Set();
    for (const entry of rawAkEntries) {
        if (seenQNums.has(entry.questionNumber)) {
            duplicates.push(entry);
        }
        seenQNums.add(entry.questionNumber);
    }

    for (let qNum = 1; qNum <= 100; qNum++) {
        const akEntry = rawAkEntries.find(e => e.questionNumber === qNum);
        const uirQ = uirMap.get(qNum);

        if (!akEntry) {
            missing.push({ questionNumber: qNum, reason: 'Missing in official answer key' });
            allAnswersMatched = false;
            continue;
        }
        if (!uirQ) {
            missing.push({ questionNumber: qNum, reason: 'Missing in UIR document' });
            allAnswersMatched = false;
            continue;
        }

        const uirAns = uirQ.correctAnswer;
        const accepted = uirAns ? uirAns.acceptedAnswers : [];
        const isOptLetterMatch = accepted.length === 1 && accepted[0] === akEntry.officialCorrectOption;

        // Check corresponding extracted option text
        const chosenOpt = uirQ.options.find(o => o.id === akEntry.officialCorrectOption);
        const chosenOptText = chosenOpt ? chosenOpt.text.trim() : null;

        // Text semantic match (AK description text vs Question option text)
        let textMatch = false;
        if (chosenOptText && akEntry.officialDescriptionText) {
            const nChosen = norm(chosenOptText);
            const nDesc = norm(akEntry.officialDescriptionText);
            textMatch = nChosen === nDesc || nChosen.includes(nDesc) || nDesc.includes(nChosen);
        }

        if (!isOptLetterMatch) {
            allAnswersMatched = false;
            unmatched.push({ questionNumber: qNum, akEntry, uirAns });
        }
        if (!textMatch && akEntry.officialDescriptionText) {
            allOptionTextsMatched = false;
        }

        comparisonRows.push({
            printedQuestionNumber: qNum,
            questionId: uirQ.questionId,
            officialAnswerKeyEntry: akEntry.rawLine,
            officialCorrectOption: akEntry.officialCorrectOption,
            officialDescriptionText: akEntry.officialDescriptionText,
            extractedOptionText: chosenOptText,
            uirCorrectAnswer: uirAns,
            uirAcceptedAnswers: accepted,
            optionLetterMatch: isOptLetterMatch,
            optionTextMatch: textMatch,
            matchStatus: isOptLetterMatch ? 'EXACT_MATCH' : 'MISMATCH'
        });
    }

    const report = {
        auditTimestamp: new Date().toISOString(),
        examName: 'SSC Combined Graduate Level (CGL) 2025 Tier-I',
        sourceAnswerKeySha256: '4a4cd10648fc970823936e5883242ba753ea692bdb2e8bfb18599a8157d4d9a8',
        totalQuestions: 100,
        totalOfficialKeysFound: rawAkEntries.length,
        summary: {
            all100OfficialKeysPresent: rawAkEntries.length === 100,
            all100AnswersMatched: allAnswersMatched,
            allOptionTextsMatched: allOptionTextsMatched,
            unmatchedCount: unmatched.length,
            ambiguousCount: ambiguous.length,
            duplicatesCount: duplicates.length,
            missingCount: missing.length,
            matchRatePercent: (comparisonRows.filter(r => r.matchStatus === 'EXACT_MATCH').length / 100) * 100
        },
        unmatched,
        ambiguous,
        duplicates,
        missing,
        answers: comparisonRows
    };

    fs.writeFileSync('phase_5_4_answer_key_comparison.json', JSON.stringify(report, null, 2));
    console.log('phase_5_4_answer_key_comparison.json written.');
    console.log(`Summary: AnswerMatch=${allAnswersMatched}, OptionTextMatch=${allOptionTextsMatched}, Unmatched=${unmatched.length}, Missing=${missing.length}`);
}
compareAnswers();
