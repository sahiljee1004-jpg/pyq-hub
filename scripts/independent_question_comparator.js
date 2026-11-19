import fs from 'fs';
import { QuestionPaperParser } from '../server/services/ingestion/questionPaperParser.js';
import { UIRTransformationService } from '../server/services/uir/uirTransformationService.js';

function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

async function compareQuestions() {
    const qpBuf = fs.readFileSync('uploads/vault/1afd99f61ca04f63_1794777789438_SSC_CGL_23Sep2025_Shift1_Question_Paper.pdf');
    const akBuf = fs.readFileSync('uploads/vault/4a4cd10648fc9708_1794777789439_SSC_CGL_23Sep2025_Shift1_Answer_Key.pdf');
    const pfBuf = fs.readFileSync('uploads/vault/7cf77051cf5b231c_1794777790575_SSC_CGL_Exam_Pattern.pdf');

    const { pages } = await QuestionPaperParser.extractPagesFromPdf(qpBuf);

    const { uirDocument } = await UIRTransformationService.transformDocuments({
        questionPaper: qpBuf,
        answerKey: akBuf,
        paperFormat: pfBuf
    });

    const rawQuestions = [];
    let currentRawQ = null;
    let currentSec = null;

    for (const page of pages) {
        const lines = page.text.split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (/^PART\s+([A-D])\s*[-–—]\s*(.*)/i.test(line)) {
                const sm = line.match(/^PART\s+([A-D])\s*[-–—]\s*(.*)/i);
                currentSec = {
                    part: sm[1].toUpperCase(),
                    name: sm[2].trim()
                };
                continue;
            }

            const qm = line.match(/^Q(\d{1,3})\.\s*(.*)/i);
            if (qm) {
                const qNum = parseInt(qm[1], 10);
                if (currentRawQ) {
                    rawQuestions.push(currentRawQ);
                }
                currentRawQ = {
                    questionNumber: qNum,
                    section: currentSec ? `Part ${currentSec.part} – ${currentSec.name}` : 'Unknown',
                    sectionPart: currentSec ? currentSec.part : null,
                    pageNumber: page.pageNumber,
                    rawHeaderLine: line,
                    stemLines: [qm[2].trim()],
                    options: []
                };
                continue;
            }

            // Option detection: (1), (2), (3), (4) - but not slash-delimiters like '(1)/'
            const optMatch = line.match(/^\(([1-4])\)(?!\/)\s*(.*)/);
            if (optMatch && currentRawQ) {
                currentRawQ.options.push({
                    index: parseInt(optMatch[1], 10),
                    label: `(${optMatch[1]})`,
                    text: optMatch[2].trim()
                });
                continue;
            }

            if (currentRawQ && !line.startsWith('SSC CGL Tier 1') && !line.startsWith('PART ')) {
                if (currentRawQ.options.length === 0) {
                    currentRawQ.stemLines.push(line);
                } else {
                    const lastOpt = currentRawQ.options[currentRawQ.options.length - 1];
                    lastOpt.text += '\n' + line;
                }
            }
        }
    }
    if (currentRawQ) {
        rawQuestions.push(currentRawQ);
    }

    const uirMap = new Map();
    for (const q of uirDocument.questions) {
        uirMap.set(q.questionNumber, q);
    }

    const comparisonResults = [];
    let allStemsMatched = true;
    let allOptionsMatched = true;
    let allOrderingMatched = true;
    let allSectionsMatched = true;

    for (const rawQ of rawQuestions) {
        const uirQ = uirMap.get(rawQ.questionNumber);
        if (!uirQ) {
            comparisonResults.push({
                questionNumber: rawQ.questionNumber,
                status: 'MISSING_IN_UIR',
                rawQ
            });
            continue;
        }

        const rawStem = rawQ.stemLines.join('\n').trim();
        const uirStem = uirQ.stem.text.trim();
        const stemMatches = norm(rawStem) === norm(uirStem);
        if (!stemMatches) allStemsMatched = false;

        const optionsComparison = [];
        let optionsMatch = rawQ.options.length === uirQ.options.length;

        for (let oIdx = 0; oIdx < rawQ.options.length; oIdx++) {
            const rOpt = rawQ.options[oIdx];
            const uOpt = uirQ.options[oIdx];
            const labelMatches = uOpt && (uOpt.label === rOpt.label || uOpt.id === String.fromCharCode(64 + rOpt.index));
            const textMatches = uOpt && norm(uOpt.text) === norm(rOpt.text);
            if (!textMatches || !labelMatches) optionsMatch = false;

            optionsComparison.push({
                optionIndex: rOpt.index,
                rawLabel: rOpt.label,
                rawText: rOpt.text,
                uirId: uOpt ? uOpt.id : null,
                uirLabel: uOpt ? uOpt.label : null,
                uirText: uOpt ? uOpt.text : null,
                isMatch: Boolean(labelMatches && textMatches)
            });
        }
        if (!optionsMatch) allOptionsMatched = false;

        let sectionMatches = false;
        if (rawQ.questionNumber <= 25 && uirQ.sectionId === 'sec_1') sectionMatches = true;
        else if (rawQ.questionNumber > 25 && rawQ.questionNumber <= 50 && uirQ.sectionId === 'sec_2') sectionMatches = true;
        else if (rawQ.questionNumber > 50 && rawQ.questionNumber <= 75 && uirQ.sectionId === 'sec_3') sectionMatches = true;
        else if (rawQ.questionNumber > 75 && rawQ.questionNumber <= 100 && uirQ.sectionId === 'sec_4') sectionMatches = true;
        if (!sectionMatches) allSectionsMatched = false;

        comparisonResults.push({
            questionNumber: rawQ.questionNumber,
            questionId: uirQ.questionId,
            pageNumber: rawQ.pageNumber,
            rawSection: rawQ.section,
            uirSectionId: uirQ.sectionId,
            sectionMatches,
            stemFidelity: {
                rawStemLength: rawStem.length,
                uirStemLength: uirStem.length,
                isExactMatch: stemMatches,
                rawStemPreview: rawStem.slice(0, 100),
                uirStemPreview: uirStem.slice(0, 100)
            },
            optionsFidelity: {
                rawCount: rawQ.options.length,
                uirCount: uirQ.options.length,
                isCountMatch: rawQ.options.length === uirQ.options.length,
                isTextMatch: optionsMatch,
                options: optionsComparison
            },
            overallMatch: Boolean(stemMatches && optionsMatch && sectionMatches)
        });
    }

    const report = {
        auditTimestamp: new Date().toISOString(),
        examName: 'SSC Combined Graduate Level (CGL) 2025 Tier-I',
        sourceQuestionPaperSha256: '1afd99f61ca04f63039c4b7e09eb7f222a5a0b7626d3b75a584da07d29884ed3',
        totalQuestionsInPdf: rawQuestions.length,
        totalQuestionsInUir: uirDocument.questions.length,
        summary: {
            all100QuestionsPresent: rawQuestions.length === 100 && uirDocument.questions.length === 100,
            allStemsMatched,
            allOptionsMatched,
            allSectionsMatched,
            allQuestionsPassedFidelity: comparisonResults.every(r => r.overallMatch)
        },
        discrepanciesCount: comparisonResults.filter(r => !r.overallMatch).length,
        discrepancies: comparisonResults.filter(r => !r.overallMatch),
        questions: comparisonResults
    };

    fs.writeFileSync('phase_5_4_question_comparison.json', JSON.stringify(report, null, 2));
    console.log('phase_5_4_question_comparison.json updated.');
    console.log(`Summary: Stems=${allStemsMatched}, Options=${allOptionsMatched}, Sections=${allSectionsMatched}, Discrepancies=${report.discrepanciesCount}`);
}
compareQuestions();
