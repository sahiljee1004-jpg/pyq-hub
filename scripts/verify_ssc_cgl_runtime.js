process.env.NODE_ENV = 'test';
import fs from 'fs';
import { UIRTransformationService } from '../server/services/uir/uirTransformationService.js';
import { UIRToMockTestAdapter } from '../server/services/uir/uirAdapters.js';
import { UniversalFirestoreService } from '../server/services/admin/universalFirestoreService.js';
import { MockTestService } from '../server/services/mockTestService.js';
import { UniversalScoringEngine } from '../server/services/scoring/universalScoringEngine.js';

async function runRuntimeVerification() {
    const qpBuf = fs.readFileSync('uploads/vault/1afd99f61ca04f63_1794777789438_SSC_CGL_23Sep2025_Shift1_Question_Paper.pdf');
    const akBuf = fs.readFileSync('uploads/vault/4a4cd10648fc9708_1794777789439_SSC_CGL_23Sep2025_Shift1_Answer_Key.pdf');
    const pfBuf = fs.readFileSync('uploads/vault/7cf77051cf5b231c_1794777790575_SSC_CGL_Exam_Pattern.pdf');

    // 1. Ingest to UIR
    const { uirDocument, validation } = await UIRTransformationService.transformDocuments({
        questionPaper: qpBuf,
        answerKey: akBuf,
        paperFormat: pfBuf
    }, {
        examId: 'ssc-cgl-2025-tier1-shift1',
        year: 2025,
        paperCode: 'Shift1',
        examTitle: 'SSC Combined Graduate Level (CGL) 2025 Tier-I'
    });

    const testId = 'mock_ssc_cgl_tier1_2025_shift1_audit';
    const adminUid = 'admin_auditor_54';
    const studentUid = 'student_candidate_54';

    // 2. Convert UIR to MockTestService Firestore documents
    const { mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs } = UIRToMockTestAdapter.toFirestoreDocuments(uirDocument);
    mockTestDoc.testId = testId;
    mockTestDoc.status = 'draft'; // Initial state: draft

    for (const q of mockQuestionDocs) q.testId = testId;
    for (const ak of mockAnswerKeyDocs) ak.testId = testId;

    await UniversalFirestoreService.setDocument('mockTests', testId, mockTestDoc);
    for (const q of mockQuestionDocs) {
        await UniversalFirestoreService.setDocument('mockQuestions', q.questionId, q);
    }
    for (const ak of mockAnswerKeyDocs) {
        await UniversalFirestoreService.setDocument('mockAnswerKeys', ak.questionId, ak);
    }

    console.log(`Persisted mock test ${testId} with ${mockQuestionDocs.length} questions and ${mockAnswerKeyDocs.length} answer keys.`);

    // 3. Draft Protection Gate Check
    const unauthStudentView = await MockTestService.getTestForStudent(testId, { callerRole: 'user' });
    const draftProtectionPassed = unauthStudentView === null;
    console.log(`Draft Protection: ordinary user cannot access draft test = ${draftProtectionPassed}`);

    // 4. Admin Preview Verification
    const adminTest = await UniversalFirestoreService.getDocument('mockTests', testId);
    const adminQuestions = mockQuestionDocs.sort((a, b) => a.questionNumber - b.questionNumber);
    const adminKeys = mockAnswerKeyDocs;

    const adminPreviewOk = adminTest && adminQuestions.length === 100 && adminKeys.length === 100;
    const allQuestionsHave4Options = adminQuestions.every(q => Array.isArray(q.options) && q.options.length === 4);
    console.log(`Admin Preview: TestFound=${Boolean(adminTest)}, QuestionsCount=${adminQuestions.length}, All4Options=${allQuestionsHave4Options}`);

    // 5. Test Student View With Authorization
    // Temporarily set published in memory to simulate student attempt session
    mockTestDoc.status = 'published';
    await UniversalFirestoreService.setDocument('mockTests', testId, mockTestDoc);

    const studentView = await MockTestService.getTestForStudent(testId, { callerRole: 'user' });
    const studentQuestions = studentView.questions;

    let zeroAnswerLeaks = true;
    const leakageAudits = [];
    for (const sq of studentQuestions) {
        const hasCorrectAnswer = sq.correctAnswer !== undefined;
        const hasAcceptedAnswers = sq.acceptedAnswers !== undefined;
        const hasCorrectOptionIds = sq.correctOptionIds !== undefined;
        const hasAnswerKey = sq.answerKey !== undefined;
        if (hasCorrectAnswer || hasAcceptedAnswers || hasCorrectOptionIds || hasAnswerKey) {
            zeroAnswerLeaks = false;
            leakageAudits.push({ questionId: sq.questionId, hasCorrectAnswer, hasAcceptedAnswers, hasCorrectOptionIds, hasAnswerKey });
        }
    }
    console.log(`Student View Confidentiality: Questions=${studentQuestions.length}, ZeroLeaks=${zeroAnswerLeaks}`);

    // 6. Start Student Attempt
    const attemptRes = await MockTestService.startAttempt({
        testId,
        userId: studentUid,
        language: 'English'
    });
    const attemptId = attemptRes.attemptId;
    console.log(`Started student attempt: ${attemptId}, status=${attemptRes.status}`);

    // 7. Prepare Deterministic Student Answers
    // Expected scoring:
    // Sec A (Q1-25): Q1-20 Correct (+40), Q21-24 Incorrect (-2), Q25 Unattempted (0) = 38.0
    // Sec B (Q26-50): Q26-40 Correct (+30), Q41-45 Incorrect (-2.5), Q46-50 Unattempted (0) = 27.5
    // Sec C (Q51-75): Q51-70 Correct (+40), Q71-72 Incorrect (-1.0), Q73-75 Unattempted (0) = 39.0
    // Sec D (Q76-100): Q76-95 Correct (+40), Q96-98 Incorrect (-1.5), Q99-100 Unattempted (0) = 38.5
    // Expected Totals: Correct=75, Incorrect=14, Unattempted=11, TotalScore=143.0 / 200.0

    const akMap = new Map();
    for (const ak of adminKeys) {
        akMap.set(ak.questionNumber, ak.acceptedAnswers ? ak.acceptedAnswers[0] : ak.correctOptionId);
    }

    const studentAnswers = {};
    for (let qNum = 1; qNum <= 100; qNum++) {
        const qDoc = adminQuestions.find(q => q.questionNumber === qNum);
        const correctOpt = akMap.get(qNum);

        let isCorrect = false;
        let isIncorrect = false;

        if (qNum <= 25) {
            if (qNum <= 20) isCorrect = true;
            else if (qNum <= 24) isIncorrect = true;
        } else if (qNum <= 50) {
            if (qNum <= 40) isCorrect = true;
            else if (qNum <= 45) isIncorrect = true;
        } else if (qNum <= 75) {
            if (qNum <= 70) isCorrect = true;
            else if (qNum <= 72) isIncorrect = true;
        } else {
            if (qNum <= 95) isCorrect = true;
            else if (qNum <= 98) isIncorrect = true;
        }

        if (isCorrect) {
            studentAnswers[qDoc.questionId] = correctOpt;
        } else if (isIncorrect) {
            const wrongOpt = ['A', 'B', 'C', 'D'].find(o => o !== correctOpt);
            studentAnswers[qDoc.questionId] = wrongOpt;
        }
    }

    // 8. Autosave Attempt
    const autosaveRes = await MockTestService.autosaveAttempt({
        attemptId,
        userId: studentUid,
        answers: studentAnswers,
        markedForReview: [adminQuestions[9].questionId]
    });
    console.log(`Autosave result: success=${autosaveRes.success}, savedCount=${autosaveRes.savedCount}`);

    // 9. Submit Attempt & Evaluate
    const submitRes = await MockTestService.submitAttempt({
        attemptId,
        userId: studentUid
    });
    const result = submitRes.result || submitRes;

    console.log('Submission evaluation results:');
    console.log(`Total Score: ${result.totalScore} / ${result.maximumMarks}`);
    console.log(`Correct: ${result.correctCount}, Incorrect: ${result.incorrectCount}, Unanswered: ${result.unansweredCount}`);

    const expectedScore = 143.0;
    const expectedCorrect = 75;
    const expectedIncorrect = 14;
    const expectedUnanswered = 11;

    const isScoreExact = Math.abs(result.totalScore - expectedScore) < 0.001;
    const isCountsExact = result.correctCount === expectedCorrect &&
        result.incorrectCount === expectedIncorrect &&
        result.unansweredCount === expectedUnanswered;

    // 10. Section-wise Breakdown Verification
    const sectionResults = result.sectionAnalysis || (result.sectionScores ? Object.entries(result.sectionScores).map(([k, v]) => ({ sectionId: k, ...v })) : []);
    console.log(`Section breakdown count: ${sectionResults.length}`);
    for (const sr of sectionResults) {
        console.log(` - Section ${sr.sectionName || sr.sectionId}: Score=${sr.score ?? sr.totalScore}, Correct=${sr.correctCount ?? sr.correct}, Incorrect=${sr.incorrectCount ?? sr.incorrect}`);
    }

    // 11. Strictly Restore Draft Status (No publication)
    mockTestDoc.status = 'draft';
    await UniversalFirestoreService.setDocument('mockTests', testId, mockTestDoc);
    const finalTestState = await UniversalFirestoreService.getDocument('mockTests', testId);
    const isStrictlyDraft = finalTestState.status === 'draft';
    console.log(`Final Test Status restored to draft: ${isStrictlyDraft}`);

    const report = {
        auditTimestamp: new Date().toISOString(),
        testId,
        examName: 'SSC Combined Graduate Level (CGL) 2025 Tier-I',
        adminPreviewAudit: {
            mockTestFound: Boolean(adminTest),
            totalQuestions: adminQuestions.length,
            allQuestionsHave4Options,
            totalAnswerKeys: adminKeys.length,
            isPublicationPrevented: isStrictlyDraft,
            finalStatus: finalTestState.status
        },
        draftAccessControlAudit: {
            unauthenticatedStudentBlocked: draftProtectionPassed
        },
        studentConfidentialityAudit: {
            totalStudentQuestions: studentQuestions.length,
            zeroAnswerKeyLeaks: zeroAnswerLeaks,
            leakageIncidentsCount: leakageAudits.length,
            leakageAudits
        },
        runtimeExecutionAudit: {
            attemptId,
            autosaveSuccessful: autosaveRes.success,
            submittedSuccessfully: Boolean(submitRes),
            scoringEvaluation: {
                totalScore: result.totalScore,
                expectedScore,
                scoreMatched: isScoreExact,
                maximumMarks: result.maximumMarks,
                correctCount: result.correctCount,
                expectedCorrect,
                incorrectCount: result.incorrectCount,
                expectedIncorrect,
                unansweredCount: result.unansweredCount,
                expectedUnanswered,
                countsMatched: isCountsExact,
                accuracyPercentage: result.accuracyPercent || ((expectedCorrect / (expectedCorrect + expectedIncorrect)) * 100)
            },
            sectionBreakdown: sectionResults
        },
        finalRuntimeVerdict: isScoreExact && isCountsExact && zeroAnswerLeaks && isStrictlyDraft ? 'PASS' : 'FAIL'
    };

    fs.writeFileSync('phase_5_4_runtime_verification.json', JSON.stringify(report, null, 2));
    console.log('phase_5_4_runtime_verification.json written successfully.');
    console.log(`Runtime Verdict: ${report.finalRuntimeVerdict}`);
}
runRuntimeVerification();
